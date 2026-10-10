/**
 * Chaser's own tools (not PayPal): deterministic planning helpers the agent calls before it acts.
 * Each returns plain JSON so any model (or the mock planner) can act on it.
 */
import { tool } from "ai";
import { z } from "zod";
import { merchantProfile } from "../env";
import { currentMode, getDisputes, getInvoices, getTransactions } from "../paypal/backend";
import { findInvoice as findMockInvoice, setChaseOverride } from "../paypal/mock";
import { isOpenInvoice, money, round2 } from "../paypal/types";
import { audit, bump, getStore, overlayFor } from "../store";
import { overdueDays, planCollections } from "./chase";
import { matchTransactions } from "./reconcile";

export const localTools = {
  get_policy: tool({
    description: "Return the user's chasing policy: reminder cadence, dispute auto-accept limit, approval thresholds and reconciliation rules. Read it before chasing, refunding or accepting disputes.",
    inputSchema: z.object({}),
    execute: async () => getStore().policy,
  }),

  summarize_receivables: tool({
    description: "Totals for the business: outstanding, overdue, collected in the last 30 days, open disputes, and a per-client breakdown of what is owed.",
    inputSchema: z.object({}),
    execute: async () => {
      const now = new Date();
      const invoices = await getInvoices();
      const transactions = await getTransactions();
      const disputes = await getDisputes();
      const open = invoices.filter(isOpenInvoice);
      const overdue = open.filter((i) => overdueDays(i, now) > 0);
      const byClient: Record<string, { outstanding: number; overdue: number; invoices: number }> = {};
      for (const i of open) {
        const k = i.client.business ?? i.client.email;
        byClient[k] ??= { outstanding: 0, overdue: 0, invoices: 0 };
        byClient[k].outstanding = round2(byClient[k].outstanding + i.due);
        byClient[k].invoices += 1;
        if (overdueDays(i, now) > 0) byClient[k].overdue = round2(byClient[k].overdue + i.due);
      }
      const since = now.getTime() - 30 * 86_400_000;
      return {
        outstanding: round2(open.reduce((a, i) => a + i.due, 0)),
        overdue: round2(overdue.reduce((a, i) => a + i.due, 0)),
        open_invoices: open.length,
        overdue_invoices: overdue.length,
        collected_last_30_days: round2(transactions.filter((t) => t.type === "PAYMENT" && t.status === "S" && new Date(t.date).getTime() >= since).reduce((a, t) => a + t.amount, 0)),
        open_disputes: disputes.filter((d) => d.status !== "RESOLVED").length,
        unlinked_payments: transactions.filter((t) => t.type === "PAYMENT" && t.status === "S" && !t.invoice_id).length,
        by_client: byClient,
        oldest_overdue: overdue.sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 5).map((i) => ({ invoice_number: i.invoice_number, client: i.client.business, due: i.due, overdue_days: overdueDays(i, now) })),
      };
    },
  }),

  lookup_customer: tool({
    description: "Find a client by business name, person name or email and return their invoices (ids, numbers, status, balance) and linked PayPal transaction/capture ids. Use this before creating an invoice, refund, subscription or shipment for a client.",
    inputSchema: z.object({ query: z.string().describe("Business name, person name, email, or invoice number") }),
    execute: async ({ query }) => {
      const q = query.trim().toLowerCase();
      const invoices = await getInvoices();
      const transactions = await getTransactions();
      const byEmail = new Map<string, typeof invoices>();
      for (const i of invoices) {
        const hay = [i.client.business, i.client.given_name, i.client.surname, i.client.email, i.invoice_number].filter(Boolean).join(" ").toLowerCase();
        const words = q.split(/\s+/).filter(Boolean);
        if (words.length > 0 && words.every((w) => hay.includes(w))) {
          const list = byEmail.get(i.client.email) ?? [];
          list.push(i);
          byEmail.set(i.client.email, list);
        }
      }
      const customers = [...byEmail.values()].map((list) => {
        const c = list[0].client;
        return {
          business: c.business,
          given_name: c.given_name,
          surname: c.surname,
          email: c.email,
          invoices: list.map((i) => ({
            invoice_id: i.id,
            invoice_number: i.invoice_number,
            status: i.status,
            total: i.total,
            due: i.due,
            due_date: i.due_date,
            items: i.items.map((x) => x.name),
            transactions: transactions.filter((t) => t.invoice_id === i.id).map((t) => ({ transaction_id: t.id, capture_id: t.capture_id, amount: t.amount, type: t.type, date: t.date })),
          })),
        };
      });
      return { found: customers.length, customers, hint: customers.length === 0 ? "No existing client matched. Ask the user for the email address, or create the invoice with the details they gave." : undefined };
    },
  }),

  propose_collections: tool({
    description: "Apply the user's reminder policy to every open invoice and return the reminders that are due right now (stage friendly/firm/final, days overdue, amount, and a drafted subject + note you may improve). Call this before sending reminders.",
    inputSchema: z.object({ invoice_ids: z.array(z.string()).optional().describe("Limit to these invoice ids or numbers") }),
    execute: async ({ invoice_ids }) => {
      const store = getStore();
      const now = new Date();
      let invoices = await getInvoices();
      if (invoice_ids?.length) invoices = invoices.filter((i) => invoice_ids.includes(i.id) || invoice_ids.includes(i.invoice_number));
      const proposals = planCollections(invoices, store.policy, now, merchantProfile().givenName);
      const skipped = invoices
        .filter(isOpenInvoice)
        .filter((i) => !proposals.some((p) => p.invoice_id === i.id))
        .map((i) => ({ invoice_number: i.invoice_number, overdue_days: overdueDays(i, now), reason: i.chase_override === "paused" ? "chasing paused" : i.reminders.length >= store.policy.reminders.maxReminders ? "max reminders reached" : overdueDays(i, now) < store.policy.reminders.friendlyAfterDays ? "not yet due for a reminder" : "already reminded at this stage / too soon since last reminder" }));
      return { now: now.toISOString(), policy: store.policy.reminders, proposals, skipped };
    },
  }),

  match_payments: tool({
    description: "Reconcile: match successful PayPal payments that are not linked to an invoice against open invoices (exact, partial and combined-invoice matches, with confidence and reasoning). Then record the matches with record_payment_for_invoice (method PAYPAL, payment_id = transaction_id).",
    inputSchema: z.object({}),
    execute: async () => {
      const invoices = await getInvoices();
      const transactions = await getTransactions();
      const result = matchTransactions(transactions, invoices, getStore().policy.reconciliation.amountTolerance);
      return { ...result, policy: getStore().policy.reconciliation };
    },
  }),

  draft_dispute_evidence: tool({
    description: "Assemble an evidence pack for a dispute (invoice details, delivery/tracking, reminder history, timeline) as a draft the user can submit in the PayPal Resolution Center. Use for disputes above the auto-accept limit.",
    inputSchema: z.object({ dispute_id: z.string() }),
    execute: async ({ dispute_id }) => {
      const disputes = await getDisputes();
      const d = disputes.find((x) => x.id === dispute_id);
      if (!d) return { error: `Dispute ${dispute_id} not found` };
      const invoices = await getInvoices();
      const inv = invoices.find((i) => i.id === d.invoice_id) ?? invoices.find((i) => i.client.email === d.buyer_email && !isOpenInvoice(i));
      const tracking = getStore().mock.trackings.find((t) => t.transaction_id === d.transaction_id);
      const m = merchantProfile();
      const lines = [
        `Dispute ${d.id} - ${money(d.amount, d.currency)} - reason: ${d.reason}`,
        `Buyer: ${d.buyer_name ?? ""} <${d.buyer_email}>`,
        `Transaction: ${d.transaction_id}`,
        inv ? `Invoice ${inv.invoice_number} issued ${inv.invoice_date}, due ${inv.due_date}, status ${inv.status}, total ${money(inv.total, inv.currency)}` : "Invoice: not linked",
        inv ? `Work delivered: ${inv.items.map((i) => `${i.quantity} x ${i.name}${i.description ? ` (${i.description})` : ""}`).join("; ")}` : "",
        tracking ? `Shipment: ${tracking.carrier} ${tracking.tracking_number} - ${tracking.status} (${tracking.shipped_at.slice(0, 10)})` : "Shipment: digital/service delivery, no physical shipment",
        inv && inv.reminders.length ? `Reminder history: ${inv.reminders.map((r) => `${r.stage} on ${r.at.slice(0, 10)}`).join(", ")}` : "",
        "",
        `Statement: ${m.businessName} delivered the services described on the invoice, which the buyer accepted and paid. The buyer did not raise concerns before opening this dispute. Attached: invoice PDF, delivery confirmation, written approvals, and correspondence.`,
        "",
        "Suggested attachments: invoice PDF, final deliverable files or links, client emails approving the work, contract/SOW.",
      ].filter(Boolean);
      const draft = lines.join("\n");
      if (currentMode() === "mock") {
        d.evidence_draft = draft;
        bump();
      }
      audit({ actor: "agent", tool: "draft_dispute_evidence", action: `Drafted evidence pack for dispute ${d.id} (${money(d.amount, d.currency)})`, decision: "info" });
      return { dispute_id: d.id, respond_by: d.seller_response_due, draft, next_step: "Review and submit in PayPal Resolution Center (the Disputes API supports provide-evidence; Chaser keeps that step human)." };
    },
  }),

  set_chase_override: tool({
    description: "Pause, resume or change the chasing intensity for one invoice: paused | default | gentle | aggressive.",
    inputSchema: z.object({ invoice_id: z.string().describe("Invoice id or number"), override: z.enum(["default", "paused", "gentle", "aggressive"]) }),
    execute: async ({ invoice_id, override }) => {
      if (currentMode() === "mock") {
        const inv = findMockInvoice(invoice_id);
        setChaseOverride(inv, override);
        return { invoice_id: inv.id, invoice_number: inv.invoice_number, chase_override: override };
      }
      const invoices = await getInvoices();
      const inv = invoices.find((i) => i.id === invoice_id || i.invoice_number === invoice_id);
      if (!inv) return { error: `Invoice ${invoice_id} not found` };
      overlayFor(inv.id).chase_override = override;
      bump();
      return { invoice_id: inv.id, invoice_number: inv.invoice_number, chase_override: override };
    },
  }),
};

export type LocalTools = typeof localTools;
