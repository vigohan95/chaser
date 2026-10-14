/**
 * Mock PayPal: implements the semantics of the PayPal Agent Toolkit tools against the in-memory store
 * and returns responses shaped like the real PayPal REST APIs, so the LLM sees the same thing in
 * both modes. Enabled with MOCK_PAYPAL=1 (or automatically when no sandbox credentials are set).
 */
import { bump, getStore } from "../store";
import { invoiceId, isoDate, paypalFee, txnId } from "./fixtures";
import type { ChaseOverride, ChaseStage, Dispute, Invoice, InvoiceItem, Subscription, SubscriptionPlan, Tracking, Transaction } from "./types";
import { isOpenInvoice, round2, unappliedAmount } from "./types";

type Input = Record<string, unknown>;

export class MockPayPalError extends Error {
  constructor(message: string, public readonly name_ = "RESOURCE_NOT_FOUND") {
    super(message);
  }
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;
}
function num(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}
function amountValue(v: unknown): number | undefined {
  if (v && typeof v === "object") return num((v as Input).value, NaN) || undefined;
  if (v === undefined || v === null || v === "") return undefined;
  return num(v, NaN) || undefined;
}

export function findInvoice(id: string): Invoice {
  const inv = getStore().mock.invoices.find((i) => i.id === id || i.invoice_number === id);
  if (!inv) throw new MockPayPalError(`Invoice ${id} not found`, "INVALID_RESOURCE_ID");
  return inv;
}

function findDispute(id: string): Dispute {
  const d = getStore().mock.disputes.find((x) => x.id === id);
  if (!d) throw new MockPayPalError(`Dispute ${id} not found`);
  return d;
}

/* ---------- PayPal-shaped serializers (Invoicing v2, Transaction Search v1, Disputes v1) ---------- */

function toPayPalInvoice(inv: Invoice) {
  return {
    id: inv.id,
    status: inv.status,
    detail: {
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      currency_code: inv.currency,
      reference: inv.reference,
      note: inv.note,
      payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: inv.due_date },
    },
    primary_recipients: [
      {
        billing_info: {
          business_name: inv.client.business,
          name: { given_name: inv.client.given_name, surname: inv.client.surname },
          email_address: inv.client.email,
        },
      },
    ],
    items: inv.items.map((i) => ({ name: i.name, description: i.description, quantity: String(i.quantity), unit_amount: { currency_code: inv.currency, value: i.unit_amount.toFixed(2) } })),
    amount: { currency_code: inv.currency, value: inv.total.toFixed(2) },
    due_amount: { currency_code: inv.currency, value: inv.due.toFixed(2) },
    payments: { paid_amount: { currency_code: inv.currency, value: inv.paid.toFixed(2) }, transactions: inv.paid_at ? [{ type: "PAYPAL", payment_date: inv.paid_at, amount: { currency_code: inv.currency, value: inv.paid.toFixed(2) } }] : undefined },
    refunds: inv.refunded ? { refund_amount: { currency_code: inv.currency, value: inv.refunded.toFixed(2) } } : undefined,
    links: [
      inv.links.view && { href: inv.links.view, rel: "self", method: "GET" },
      inv.links.pay && { href: inv.links.pay, rel: "payer-view", method: "GET" },
    ].filter(Boolean),
    chaser: { reminders_sent: inv.reminders.length, last_reminder_at: inv.reminders.at(-1)?.at, chase_override: inv.chase_override },
  };
}

function toPayPalTransaction(t: Transaction) {
  return {
    transaction_info: {
      transaction_id: t.id,
      transaction_event_code: t.type === "REFUND" ? "T1107" : "T0006",
      transaction_initiation_date: t.date,
      transaction_amount: { currency_code: t.currency, value: t.amount.toFixed(2) },
      fee_amount: { currency_code: t.currency, value: (-t.fee).toFixed(2) },
      transaction_status: t.status,
      transaction_note: t.memo,
      invoice_id: t.invoice_id,
      paypal_reference_id: t.capture_id,
    },
    payer_info: { email_address: t.payer_email, payer_name: { alternate_full_name: t.payer_name } },
  };
}

function toPayPalDispute(d: Dispute) {
  return {
    dispute_id: d.id,
    create_time: d.created,
    reason: d.reason,
    status: d.status,
    dispute_amount: { currency_code: d.currency, value: d.amount.toFixed(2) },
    dispute_life_cycle_stage: d.life_cycle_stage ?? (d.status === "OPEN_INQUIRIES" ? "INQUIRY" : "CHARGEBACK"),
    seller_response_due_date: d.seller_response_due,
    disputed_transactions: [{ seller_transaction_id: d.transaction_id, invoice_number: d.invoice_id, buyer: { email: d.buyer_email, name: d.buyer_name } }],
    dispute_outcome: d.outcome ? { outcome_code: d.outcome } : undefined,
  };
}

/* ---------- mutations shared with the webhook route and the UI ---------- */

export function recordPayment(inv: Invoice, amount: number, opts: { method: string; note?: string; date?: string; transaction?: Transaction }): Transaction {
  const amt = round2(Math.min(amount, inv.due));
  inv.paid = round2(inv.paid + amt);
  inv.due = round2(Math.max(0, inv.total - inv.paid));
  inv.status = inv.due <= 0 ? (opts.method === "PAYPAL" ? "PAID" : "MARKED_AS_PAID") : "PARTIALLY_PAID";
  const s = getStore();
  let t = opts.transaction;
  if (t) {
    // Apply (part of) an existing payment: one PayPal transaction can settle several invoices, or part of one.
    t.allocations = [...(t.allocations ?? []), { invoice_id: inv.id, invoice_number: inv.invoice_number, amount: amt }];
    const applied = round2(t.allocations.reduce((a, x) => a + x.amount, 0));
    if (applied >= t.amount - 0.01) t.invoice_id = t.allocations.length === 1 ? inv.id : t.allocations[0].invoice_id;
  } else {
    t = {
      id: txnId(`${inv.id}-${s.mock.seq++}`),
      date: opts.date ?? new Date().toISOString(),
      type: "PAYMENT",
      amount: amt,
      fee: opts.method === "PAYPAL" ? paypalFee(amt) : 0,
      currency: inv.currency,
      status: "S",
      payer_email: inv.client.email,
      payer_name: `${inv.client.given_name} ${inv.client.surname}`,
      memo: opts.note ?? `${opts.method} payment recorded`,
      invoice_id: inv.id,
    };
    s.mock.transactions.unshift(t);
  }
  bump();
  return t;
}

export function addReminder(inv: Invoice, stage: ChaseStage, subject?: string): void {
  inv.reminders.push({ at: new Date().toISOString(), stage, subject });
  bump();
}

export function setChaseOverride(inv: Invoice, override: ChaseOverride): void {
  inv.chase_override = override;
  bump();
}

/** Simulates "client paid the invoice on PayPal": used by the webhook simulator in the UI. */
export function simulateInvoicePaid(id: string): { invoice: Invoice; transaction: Transaction } {
  const inv = findInvoice(id);
  if (!isOpenInvoice(inv)) throw new MockPayPalError(`Invoice ${inv.invoice_number} is ${inv.status}`, "INVALID_STATE");
  const t = recordPayment(inv, inv.due, { method: "PAYPAL", note: `Paid via PayPal invoice ${inv.invoice_number}` });
  return { invoice: inv, transaction: t };
}

/* ---------- tool executor ---------- */

export async function mockExecute(tool: string, rawInput: unknown): Promise<unknown> {
  const input: Input = rawInput && typeof rawInput === "object" ? (rawInput as Input) : {};
  const s = getStore();
  const m = s.mock;

  switch (tool) {
    case "list_invoices": {
      const page = num(input.page, 1);
      const size = num(input.page_size, 100);
      const items = m.invoices.slice((page - 1) * size, page * size);
      return { total_items: m.invoices.length, total_pages: Math.ceil(m.invoices.length / size), items: items.map(toPayPalInvoice) };
    }
    case "get_invoice":
      return toPayPalInvoice(findInvoice(str(input.invoice_id)));

    case "search_invoicing": {
      const f = (input.invoice_filters ?? {}) as Input;
      let list = m.invoices;
      if (f.status) list = list.filter((i) => (f.status as string[]).includes(i.status));
      if (f.recipient_email) list = list.filter((i) => i.client.email.toLowerCase() === str(f.recipient_email).toLowerCase());
      if (f.invoice_number) list = list.filter((i) => i.invoice_number === f.invoice_number);
      if (f.recipient_business_name) list = list.filter((i) => (i.client.business ?? "").toLowerCase().includes(str(f.recipient_business_name).toLowerCase()));
      return { total_items: list.length, items: list.map(toPayPalInvoice) };
    }

    case "generate_invoice_number":
      return { invoice_number: `INV-${String(m.seq).padStart(4, "0")}` };

    case "create_invoice": {
      const recipients = Array.isArray(input.primary_recipients) ? (input.primary_recipients as Input[]) : [];
      const billing = (recipients[0]?.billing_info ?? {}) as Input;
      const name = (billing.name ?? {}) as Input;
      const rawItems = Array.isArray(input.items) ? (input.items as Input[]) : [];
      const items: InvoiceItem[] = rawItems.map((it) => ({
        name: str(it.name, "Item"),
        description: typeof it.description === "string" ? it.description : undefined,
        quantity: num(it.quantity, 1),
        unit_amount: amountValue(it.unit_amount) ?? 0,
      }));
      const total = round2(items.reduce((a, i) => a + i.quantity * i.unit_amount, 0) + (amountValue(input.shipping_cost) ?? 0));
      const n = m.seq++;
      const id = invoiceId(n);
      const today = new Date();
      const invoiceDate = str(input.invoice_date, isoDate(today));
      // The toolkit's create_invoice schema has no payment_term, so terms travel in the note ("Net 30", "due 2026-11-01").
      const note = str(input.note);
      const netDays = Number(note.match(/net\s*(\d{1,3})/i)?.[1] ?? 15);
      const explicitDue = note.match(/due\s+(\d{4}-\d{2}-\d{2})/i)?.[1];
      const dueDate = explicitDue ?? isoDate(new Date(new Date(invoiceDate + "T00:00:00Z").getTime() + netDays * 86_400_000));
      const inv: Invoice = {
        id,
        invoice_number: str(input.invoice_number, `INV-${String(n).padStart(4, "0")}`),
        status: "DRAFT",
        client: {
          business: typeof billing.business_name === "string" ? billing.business_name : undefined,
          given_name: str(name.given_name, "Client"),
          surname: str(name.surname, ""),
          email: str(billing.email_address, "client@example.com"),
        },
        items,
        currency: str(input.currency_code, "USD"),
        total,
        paid: 0,
        refunded: 0,
        due: total,
        invoice_date: invoiceDate,
        due_date: dueDate,
        reference: typeof input.reference === "string" ? input.reference : undefined,
        note: typeof input.note === "string" ? input.note : undefined,
        reminders: [],
        chase_override: "default",
        links: { view: `https://www.sandbox.paypal.com/invoice/p/#${id}`, pay: `https://www.sandbox.paypal.com/invoice/payerView/details/${id}` },
      };
      m.invoices.unshift(inv);
      bump();
      return { id, status: "DRAFT", href: inv.links.view, detail: toPayPalInvoice(inv).detail, amount: { currency_code: inv.currency, value: total.toFixed(2) } };
    }

    case "send_invoice": {
      const inv = findInvoice(str(input.invoice_id));
      if (inv.status !== "DRAFT" && inv.status !== "SCHEDULED") throw new MockPayPalError(`Invoice ${inv.invoice_number} is already ${inv.status}`, "INVALID_STATE");
      inv.status = "UNPAID";
      bump();
      return { id: inv.id, status: inv.status, sent_to: [inv.client.email, ...((input.additional_recipients as string[] | undefined) ?? [])], payer_view: inv.links.pay };
    }

    case "send_invoice_reminder": {
      const inv = findInvoice(str(input.invoice_id));
      if (!isOpenInvoice(inv)) throw new MockPayPalError(`Cannot remind: invoice ${inv.invoice_number} is ${inv.status}`, "INVALID_STATE");
      const stage = inferStage(str(input.subject) + " " + str(input.note));
      addReminder(inv, stage, str(input.subject) || undefined);
      return { id: inv.id, reminder_sent_to: inv.client.email, subject: input.subject, reminders_sent: inv.reminders.length };
    }

    case "cancel_sent_invoice": {
      const inv = findInvoice(str(input.invoice_id));
      inv.status = "CANCELLED";
      bump();
      return { id: inv.id, status: inv.status };
    }
    case "delete_invoice": {
      const inv = findInvoice(str(input.invoice_id));
      if (inv.status !== "DRAFT" && inv.status !== "SCHEDULED") throw new MockPayPalError("Only draft or scheduled invoices can be deleted", "INVALID_STATE");
      m.invoices = m.invoices.filter((i) => i.id !== inv.id);
      bump();
      return { deleted: inv.id };
    }

    case "generate_invoice_qr_code": {
      const inv = findInvoice(str(input.invoice_id));
      const w = num(input.width, 300);
      const h = num(input.height, 300);
      return { invoice_id: inv.id, image_url: `https://api.qrserver.com/v1/create-qr-code/?size=${w}x${h}&data=${encodeURIComponent(inv.links.pay ?? inv.id)}`, note: "Mock mode: QR renders the sandbox payer link." };
    }

    case "record_payment_for_invoice": {
      const inv = findInvoice(str(input.invoice_id));
      if (!isOpenInvoice(inv)) throw new MockPayPalError(`Invoice ${inv.invoice_number} is ${inv.status}`, "INVALID_STATE");
      const amt = amountValue(input.amount) ?? inv.due;
      const existing = typeof input.payment_id === "string" ? m.transactions.find((t) => t.id === input.payment_id && unappliedAmount(t) > 0.01) : undefined;
      const t = recordPayment(inv, amt, { method: str(input.method, "OTHER"), note: typeof input.note === "string" ? input.note : undefined, date: typeof input.payment_date === "string" ? input.payment_date : undefined, transaction: existing });
      return { payment_id: t.id, invoice_id: inv.id, status: inv.status, paid_amount: { currency_code: inv.currency, value: inv.paid.toFixed(2) }, due_amount: { currency_code: inv.currency, value: inv.due.toFixed(2) } };
    }

    case "record_refund_for_invoice": {
      const inv = findInvoice(str(input.invoice_id));
      const amt = amountValue(input.amount) ?? inv.paid;
      inv.refunded = round2(inv.refunded + amt);
      inv.status = inv.refunded >= inv.paid ? "MARKED_AS_REFUNDED" : "PARTIALLY_REFUNDED";
      m.transactions.unshift({ id: txnId(`${inv.id}-refund-${m.seq++}`), date: new Date().toISOString(), type: "REFUND", amount: -amt, fee: 0, currency: inv.currency, status: "S", payer_email: inv.client.email, payer_name: `${inv.client.given_name} ${inv.client.surname}`, memo: `Refund recorded (${str(input.method, "OTHER")})`, invoice_id: inv.id });
      bump();
      return { refund_id: m.transactions[0].id, invoice_id: inv.id, status: inv.status, refund_amount: { currency_code: inv.currency, value: amt.toFixed(2) } };
    }

    case "create_refund": {
      const capture = str(input.capture_id);
      const t = m.transactions.find((x) => x.capture_id === capture || x.id === capture);
      if (!t) throw new MockPayPalError(`Capture ${capture} not found`);
      const amt = amountValue(input.amount) ?? t.amount;
      const inv = t.invoice_id ? m.invoices.find((i) => i.id === t.invoice_id) : undefined;
      if (inv) {
        inv.refunded = round2(inv.refunded + amt);
        inv.status = inv.refunded >= inv.paid ? "REFUNDED" : "PARTIALLY_REFUNDED";
      }
      const r: Transaction = { id: txnId(`refund-${capture}-${m.seq++}`), date: new Date().toISOString(), type: "REFUND", amount: -amt, fee: -round2(amt * 0.0349), currency: t.currency, status: "S", payer_email: t.payer_email, payer_name: t.payer_name, memo: typeof input.note_to_payer === "string" ? input.note_to_payer : "Refund", invoice_id: t.invoice_id };
      m.transactions.unshift(r);
      bump();
      return { id: r.id, status: "COMPLETED", amount: { currency_code: t.currency, value: amt.toFixed(2) }, invoice_id: t.invoice_id };
    }

    case "list_transactions": {
      const start = typeof input.start_date === "string" ? new Date(input.start_date).getTime() : 0;
      const end = typeof input.end_date === "string" ? new Date(input.end_date).getTime() : Infinity;
      const status = typeof input.transaction_status === "string" ? input.transaction_status : undefined;
      const list = m.transactions.filter((t) => {
        const ts = new Date(t.date).getTime();
        return ts >= start && ts <= end && (!status || t.status === status);
      });
      return { total_items: list.length, transaction_details: list.map(toPayPalTransaction) };
    }

    case "list_disputes": {
      const state = typeof input.dispute_state === "string" ? input.dispute_state : undefined;
      const list = m.disputes.filter((d) => !state || d.status === state);
      return { items: list.map(toPayPalDispute) };
    }
    case "get_dispute":
      return toPayPalDispute(findDispute(str(input.dispute_id)));
    case "accept_dispute_claim": {
      const d = findDispute(str(input.dispute_id));
      if (d.status === "RESOLVED") throw new MockPayPalError(`Dispute ${d.id} is already resolved`, "INVALID_STATE");
      d.status = "RESOLVED";
      d.outcome = "ACCEPTED_BY_SELLER";
      const t = m.transactions.find((x) => x.id === d.transaction_id);
      m.transactions.unshift({ id: txnId(`dispute-refund-${d.id}`), date: new Date().toISOString(), type: "REFUND", amount: -d.amount, fee: 0, currency: d.currency, status: "S", payer_email: d.buyer_email, payer_name: d.buyer_name, memo: `Dispute ${d.id} accepted: ${str(input.note)}`, invoice_id: t?.invoice_id });
      if (t?.invoice_id) {
        const inv = m.invoices.find((i) => i.id === t.invoice_id);
        if (inv) {
          inv.refunded = round2(inv.refunded + d.amount);
          inv.status = inv.refunded >= inv.paid ? "REFUNDED" : "PARTIALLY_REFUNDED";
        }
      }
      bump();
      return { dispute_id: d.id, status: d.status, outcome: d.outcome, refunded: { currency_code: d.currency, value: d.amount.toFixed(2) } };
    }

    case "submit_dispute_evidence": {
      // Not a toolkit tool: Chaser calls the Disputes API directly in sandbox mode (see rest.ts). The mock mirrors it.
      const d = findDispute(str(input.dispute_id));
      if (d.status === "RESOLVED") throw new MockPayPalError(`Dispute ${d.id} is already resolved`, "INVALID_STATE");
      const stage = d.life_cycle_stage ?? (d.status === "OPEN_INQUIRIES" ? "INQUIRY" : "CHARGEBACK");
      const channel = stage === "INQUIRY" ? "send-message" : "provide-evidence";
      d.evidence_submitted_at = new Date().toISOString();
      d.evidence_channel = channel;
      d.status = stage === "INQUIRY" ? "REQUIRED_OTHER_PARTY_ACTION" : "UNDER_PAYPAL_REVIEW";
      bump();
      return { dispute_id: d.id, channel, status: 200, dispute_status: d.status, links: [{ href: `https://www.sandbox.paypal.com/resolutioncenter/view/${d.id}`, rel: "self", method: "GET" }] };
    }

    case "create_shipment_tracking": {
      const tr: Tracking = {
        transaction_id: str(input.transaction_id),
        tracking_number: str(input.tracking_number),
        carrier: str(input.carrier, "OTHER"),
        status: str(input.status, "SHIPPED"),
        shipped_at: new Date().toISOString(),
        invoice_id: m.transactions.find((t) => t.id === input.transaction_id)?.invoice_id,
      };
      m.trackings.unshift(tr);
      bump();
      return { tracker_id: `${tr.transaction_id}-${tr.tracking_number}`, status: tr.status, carrier: tr.carrier, tracking_number: tr.tracking_number };
    }
    case "get_shipment_tracking": {
      const list = m.trackings.filter((t) => (!input.transaction_id || t.transaction_id === input.transaction_id));
      return { trackers: list.map((t) => ({ transaction_id: t.transaction_id, tracking_number: t.tracking_number, carrier: t.carrier, status: t.status, shipment_date: t.shipped_at })) };
    }
    case "update_shipment_tracking": {
      const tr = m.trackings.find((t) => t.tracking_number === input.tracking_number || t.transaction_id === input.transaction_id);
      if (!tr) throw new MockPayPalError("Tracker not found");
      if (typeof input.status === "string") tr.status = input.status;
      if (typeof input.carrier === "string") tr.carrier = input.carrier;
      bump();
      return { tracker_id: `${tr.transaction_id}-${tr.tracking_number}`, status: tr.status };
    }

    case "create_product": {
      const id = `PROD-MOCK-${String(m.seq++).padStart(4, "0")}`;
      m.products.unshift({ id, name: str(input.name, "Product"), type: (str(input.type, "SERVICE") as "SERVICE"), description: typeof input.description === "string" ? input.description : undefined });
      bump();
      return { id, name: input.name, type: input.type, create_time: new Date().toISOString() };
    }
    case "list_products":
      return { products: m.products, total_items: m.products.length };
    case "show_product_details":
      return m.products.find((p) => p.id === input.product_id) ?? (() => { throw new MockPayPalError("Product not found"); })();

    case "create_subscription_plan": {
      const cycles = Array.isArray(input.billing_cycles) ? (input.billing_cycles as Input[]) : [];
      const regular = cycles.find((c) => c.tenure_type === "REGULAR") ?? cycles[0] ?? {};
      const freq = (regular.frequency ?? {}) as Input;
      const scheme = (regular.pricing_scheme ?? {}) as Input;
      const plan: SubscriptionPlan = {
        id: `P-MOCK-${String(m.seq++).padStart(6, "0")}`, // toolkit plan ids must be 12-32 chars
        product_id: str(input.product_id),
        name: str(input.name, "Plan"),
        amount: amountValue(scheme.fixed_price) ?? 0,
        currency: str(((scheme.fixed_price ?? {}) as Input).currency_code, "USD"),
        interval_unit: (str(freq.interval_unit, "MONTH") as SubscriptionPlan["interval_unit"]),
        interval_count: num(freq.interval_count, 1),
        status: "ACTIVE",
      };
      m.plans.unshift(plan);
      bump();
      return { id: plan.id, product_id: plan.product_id, name: plan.name, status: plan.status, billing_cycles: cycles };
    }
    case "list_subscription_plans":
      return { plans: m.plans, total_items: m.plans.length };
    case "show_subscription_plan_details":
      return m.plans.find((p) => p.id === input.plan_id) ?? (() => { throw new MockPayPalError("Plan not found"); })();
    case "create_subscription": {
      const plan = m.plans.find((p) => p.id === input.plan_id);
      if (!plan) throw new MockPayPalError(`Plan ${str(input.plan_id)} not found`);
      const sub = (input.subscriber ?? {}) as Input;
      const subName = (sub.name ?? {}) as Input;
      const s2: Subscription = {
        id: `I-MOCK${String(m.seq++).padStart(6, "0")}`,
        plan_id: plan.id,
        status: "APPROVAL_PENDING",
        subscriber_email: str(sub.email_address, "client@example.com"),
        subscriber_name: [subName.given_name, subName.surname].filter(Boolean).join(" ") || undefined,
        approve_url: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-MOCK${m.seq}`,
        created: new Date().toISOString(),
      };
      m.subscriptions.unshift(s2);
      bump();
      return { id: s2.id, status: s2.status, plan_id: plan.id, links: [{ href: s2.approve_url, rel: "approve", method: "GET" }] };
    }
    case "show_subscription_details":
      return m.subscriptions.find((x) => x.id === input.subscription_id) ?? (() => { throw new MockPayPalError("Subscription not found"); })();
    case "cancel_subscription": {
      const sub = m.subscriptions.find((x) => x.id === input.subscription_id);
      if (!sub) throw new MockPayPalError("Subscription not found");
      sub.status = "CANCELLED";
      bump();
      return { id: sub.id, status: sub.status };
    }

    case "create_order": {
      const items = Array.isArray(input.items) ? (input.items as Input[]) : [];
      const total = round2(items.reduce((a, i) => a + num(i.itemTotal, num(i.itemCost) * num(i.quantity, 1)), 0));
      const id = `ORDER-MOCK-${m.seq++}`;
      return { id, status: "CREATED", amount: { currency_code: "USD", value: total.toFixed(2) }, links: [{ href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`, rel: "approve" }] };
    }
    case "get_order":
      return { id: input.id, status: "CREATED" };

    default:
      throw new MockPayPalError(`Tool "${tool}" is not implemented in mock mode`, "NOT_IMPLEMENTED");
  }
}

function inferStage(text: string): ChaseStage {
  const t = text.toLowerCase();
  if (t.includes("final")) return "final";
  if (t.includes("overdue") || t.includes("past due")) return "firm";
  return "friendly";
}
