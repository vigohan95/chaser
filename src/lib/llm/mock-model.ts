/**
 * MockPlannerModel: a keyless LanguageModelV3 that plans tool calls with rules instead of weights.
 *
 * It exists so the whole product (UI, agent loop, policy gate, approval cards, audit log) runs with
 * zero API keys: `MOCK_PAYPAL=1` + no LLM key. It reads the same tool results a real model would and
 * follows the same playbook as the system prompt. Swap in Gemini/Groq/Nemotron by setting a key.
 */
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";

type J = Record<string, unknown>;
const j = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const arr = (v: unknown): J[] => (Array.isArray(v) ? v.map(j) : []);
const s = (v: unknown, d = ""): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : d);
const n = (v: unknown, d = 0): number => (typeof v === "number" ? v : Number(v) || d);
const usd = (v: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);

export interface TurnResult {
  toolName: string;
  input: J;
  output: J;
  denied?: string;
  error?: string;
}

export interface Turn {
  system: string;
  userText: string;
  results: TurnResult[];
  policy: J;
  merchant: J;
}

export type Action = { type: "calls"; calls: Array<{ toolName: string; input: J }> } | { type: "text"; text: string };

/* ---------------- prompt parsing ---------------- */

export function parseTurn(prompt: LanguageModelV3Prompt): Turn {
  let system = "";
  let lastUser = -1;
  prompt.forEach((m, i) => {
    if (m.role === "system") system += m.content + "\n";
    if (m.role === "user") lastUser = i;
  });
  const userMsg = lastUser >= 0 ? prompt[lastUser] : undefined;
  const userText = userMsg && userMsg.role === "user" ? userMsg.content.map((p) => (p.type === "text" ? p.text : "")).join(" ") : "";
  const calls = new Map<string, { toolName: string; input: J }>();
  const results: TurnResult[] = [];
  for (const m of prompt.slice(lastUser + 1)) {
    if (m.role === "assistant") {
      for (const p of m.content) if (p.type === "tool-call") calls.set(p.toolCallId, { toolName: p.toolName, input: j(p.input) });
    } else if (m.role === "tool") {
      for (const p of m.content) {
        if (p.type !== "tool-result") continue;
        const call = calls.get(p.toolCallId) ?? { toolName: p.toolName, input: {} };
        const r: TurnResult = { toolName: call.toolName, input: call.input, output: {} };
        const out = p.output;
        if (out.type === "json") r.output = j(out.value);
        else if (out.type === "text") {
          try {
            r.output = j(JSON.parse(out.value));
          } catch {
            r.output = { text: out.value };
          }
        } else if (out.type === "execution-denied") r.denied = out.reason ?? "denied by policy";
        else if (out.type === "error-text") r.error = out.value;
        else if (out.type === "error-json") r.error = JSON.stringify(out.value);
        if (r.output.error) r.error = s(r.output.error) || JSON.stringify(r.output.error);
        results.push(r);
      }
    }
  }
  const tag = (name: string): J => {
    const m = system.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    try {
      return m ? j(JSON.parse(m[1])) : {};
    } catch {
      return {};
    }
  };
  return { system, userText, results, policy: tag("policy"), merchant: tag("merchant") };
}

/* ---------------- text parsing ---------------- */

export function parseAmount(text: string): number | undefined {
  const m = text.match(/\$\s?([\d,]+(?:\.\d{1,2})?)/) ?? text.match(/([\d,]+(?:\.\d{1,2})?)\s?(?:usd|dollars|bucks)/i);
  return m ? Number(m[1].replace(/,/g, "")) : undefined;
}

export function parseClient(text: string): string | undefined {
  const m = text.match(/\b(?:for|to|from|with)\s+((?:[A-Z][\w&.'-]*|&)(?:\s+(?:[A-Z][\w&.'-]*|&))*)/);
  if (!m) return undefined;
  return m[1].replace(/\s*(?:,|\.|\$).*$/, "").trim();
}

export function parseInvoiceNumbers(text: string): string[] {
  return [...new Set((text.match(/INV-\d{4}/gi) ?? []).map((x) => x.toUpperCase()))];
}

export function parseDisputeIds(text: string): string[] {
  return [...new Set(text.match(/PP-D-[A-Z0-9-]+/gi)?.map((x) => x.toUpperCase()) ?? [])];
}

export interface ExplicitAllocation {
  transaction_id: string;
  invoice_id: string;
  invoice_number: string;
  amount: number;
}

/**
 * "Record these payment allocations: 7AB...XYZ -> INV-0015 [INV2-...] $900.00; ..." (what the match-review grid
 * sends). The bracketed invoice id is optional; without it the invoice number is used as the id.
 */
export function parseAllocations(text: string): ExplicitAllocation[] {
  const out: ExplicitAllocation[] = [];
  const re = /\b([A-Z0-9]{12,32})\s*(?:->|=>|to)\s*(INV-\d{4})(?:\s*\[([^\]]+)\])?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/gi;
  for (const m of text.matchAll(re)) {
    const number = m[2].toUpperCase();
    out.push({ transaction_id: m[1].toUpperCase(), invoice_number: number, invoice_id: m[3]?.trim() || number, amount: Number(m[4].replace(/,/g, "")) });
  }
  return out;
}

function parseNet(text: string): number {
  const m = text.match(/net\s*(\d{1,3})/i) ?? text.match(/due in\s*(\d{1,3})\s*days/i);
  return m ? Number(m[1]) : 15;
}

function parseDescription(text: string): string {
  const m =
    text.match(/(?:finished|completed|delivered|wrapped up|shipped|did)\s+(?:the\s+)?(.+?)\s+(?:for|to)\s+[A-Z]/i) ??
    text.match(/(?:invoice|bill|charge)\s+[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)*\s+(?:\$[\d,.]+\s+)?for\s+(?:the\s+)?(.+?)(?:,|\.|$)/i) ??
    text.match(/for\s+(?:the\s+)?(.+?)\s*(?:,|\.|$)/i);
  const d = (m?.[1] ?? "Professional services").replace(/\$[\d,.]+/g, "").replace(/\bnet\s*\d+\b/i, "").trim().replace(/[,.]$/, "");
  return d.length > 2 ? d[0].toUpperCase() + d.slice(1) : "Professional services";
}

function parseTracking(text: string): { number?: string; carrier?: string } {
  const num = text.match(/\b(1Z[0-9A-Z]{16}|[A-Z]{2}\d{9}[A-Z]{2}|\d{12,22})\b/i)?.[1];
  const carrier = text.match(/\b(ups|usps|fedex|dhl)\b/i)?.[1]?.toUpperCase();
  return { number: num, carrier };
}

export type Intent = "refund" | "collections" | "reconcile" | "disputes" | "tracking" | "subscription" | "override" | "status" | "invoice" | "promise" | "help";

export function detectIntent(text: string): Intent {
  const t = text.toLowerCase();
  if (/\b(promise[sd]?|promise to pay|will pay|'ll pay|pay by|pays? on|paying on|client (?:replied|says|said|wrote|emailed)|reply from|replied)\b/.test(t)) return "promise";
  if (/\brefund\b/.test(t)) return "refund";
  if (/\b(pause|stop chasing|resume|unpause|gentle|aggressive)\b/.test(t)) return "override";
  if (/\b(remind|reminder|chase|chasing|collect|collections|nudge|overdue|late payers?)\b/.test(t)) return "collections";
  if (/\b(reconcile|reconciliation|match|unmatched|came in|payments? (?:received|arrived)|bank|transactions?|allocations?)\b/.test(t)) return "reconcile";
  if (/\b(dispute|disputes|chargeback|claim|evidence)\b/.test(t)) return "disputes";
  if (/\b(ship|shipped|shipping|track|tracking|delivered)\b/.test(t)) return "tracking";
  if (/\b(subscription|retainer|recurring|monthly|every month)\b/.test(t)) return "subscription";
  if (/\b(status|summary|how much|outstanding|owed|owe|overview|report|receivables)\b/.test(t)) return "status";
  if (/\b(invoice|bill|charge|finished|completed|delivered)\b/.test(t) || parseAmount(t) !== undefined) return "invoice";
  return "help";
}

/* ---------------- playbooks ---------------- */

const has = (turn: Turn, name: string) => turn.results.filter((r) => r.toolName === name);
const first = (turn: Turn, name: string) => has(turn, name)[0];

function customerFrom(turn: Turn, fallbackName?: string) {
  const r = first(turn, "lookup_customer");
  const c = arr(r?.output.customers)[0];
  if (c) return { found: true, business: s(c.business) || undefined, given_name: s(c.given_name, "Client"), surname: s(c.surname), email: s(c.email), invoices: arr(c.invoices) };
  const name = (fallbackName ?? "Client").trim();
  const [given, ...rest] = name.split(/\s+/);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "") || "client";
  return { found: false, business: rest.length ? name : undefined, given_name: given ?? "Client", surname: rest.join(" "), email: `billing@${slug}.example`, invoices: [] as J[] };
}

function outcomeLine(r: TurnResult | undefined, ok: (o: J) => string): string {
  if (!r) return "not attempted";
  if (r.denied) return `not done - ${r.denied}`;
  if (r.error) return `failed - ${r.error}`;
  return ok(r.output);
}

function invoicePlaybook(turn: Turn): Action {
  const text = turn.userText;
  const client = parseClient(text) ?? "Client";
  const amount = parseAmount(text) ?? 0;
  const net = parseNet(text);
  const description = parseDescription(text);
  if (!first(turn, "lookup_customer")) return { type: "calls", calls: [{ toolName: "lookup_customer", input: { query: client } }] };
  const created = first(turn, "create_invoice");
  if (!created) {
    const c = customerFrom(turn, client);
    const today = new Date();
    const due = new Date(today.getTime() + net * 86_400_000);
    const m = turn.merchant;
    return {
      type: "calls",
      calls: [
        {
          toolName: "create_invoice",
          input: {
            currency_code: "USD",
            invoice_date: today.toISOString().slice(0, 10),
            note: `Net ${net} - due ${due.toISOString().slice(0, 10)}. Thank you for your business!`,
            invoicer_business_name: s(m.businessName, "Vigo Design Studio"),
            invoicer_given_name: s(m.givenName, "Han"),
            invoicer_surname: s(m.surname, "Vigo"),
            invoicer_email_address: s(m.invoicerEmail) || undefined,
            primary_recipients: [{ billing_info: { business_name: c.business, name: { given_name: c.given_name, surname: c.surname }, email_address: c.email } }],
            items: [{ name: description, quantity: "1", unit_amount: { currency_code: "USD", value: amount.toFixed(2) } }],
          },
        },
      ],
    };
  }
  if (created.denied || created.error) {
    return { type: "text", text: `I did not create the ${usd(amount)} invoice for ${client}: ${created.denied ?? created.error}. Adjust the policy or approve it and I will try again.` };
  }
  const id = s(created.output.id);
  const sent = first(turn, "send_invoice");
  if (!sent) return { type: "calls", calls: [{ toolName: "send_invoice", input: { invoice_id: id, send_to_recipient: true } }] };
  const c = customerFrom(turn, client);
  const number = s(j(created.output.detail).invoice_number, id);
  const pay = s(sent.output.payer_view) || s(created.output.href);
  return {
    type: "text",
    text: `Done. I created invoice ${number} for ${usd(amount)} - "${description}" - to ${c.business ?? `${c.given_name} ${c.surname}`} <${c.email}>${c.found ? "" : " (new client; email guessed - please check)"}, net ${net}, and ${outcomeLine(sent, () => "sent it via PayPal")}.${pay ? `\n\nPay link: ${pay}` : ""}\n\nIt is now in the grid; I will chase it under your policy if it goes overdue.`,
  };
}

function collectionsPlaybook(turn: Turn): Action {
  const ids = parseInvoiceNumbers(turn.userText);
  const proposed = first(turn, "propose_collections");
  if (!proposed) return { type: "calls", calls: [{ toolName: "propose_collections", input: ids.length ? { invoice_ids: ids } : {} }] };
  const proposals = arr(proposed.output.proposals);
  const skipped = arr(proposed.output.skipped);
  if (proposals.length === 0) {
    return { type: "text", text: `Nothing to chase right now. ${skipped.length ? `I checked ${skipped.length} open invoice(s): ${skipped.map((x) => `${s(x.invoice_number)} (${s(x.reason)})`).join(", ")}.` : "No open invoices are past your reminder thresholds."}` };
  }
  const sent = has(turn, "send_invoice_reminder");
  if (sent.length === 0) {
    return {
      type: "calls",
      calls: proposals.map((p) => {
        const draft = j(p.draft);
        return { toolName: "send_invoice_reminder", input: { invoice_id: s(p.invoice_id), subject: s(draft.subject), note: s(draft.note) } };
      }),
    };
  }
  const lines = proposals.map((p) => {
    const r = sent.find((x) => s(x.input.invoice_id) === s(p.invoice_id));
    const history = s(p.rule) === "reminders.adaptToHistory" ? ` (${s(p.risk)} payer: ${s(p.why)})` : "";
    return `- ${s(p.invoice_number)} ${s(p.client)} - ${s(p.stage)} reminder, ${usd(n(p.amount_due))}, ${n(p.overdue_days)} days overdue${history}: ${outcomeLine(r, (o) => `sent to ${s(o.reminder_sent_to, s(p.email))}`)}`;
  });
  const okCount = sent.filter((r) => !r.denied && !r.error).length;
  return {
    type: "text",
    text: `Collections run complete: ${okCount} of ${proposals.length} reminder(s) sent under your policy (friendly after ${n(j(turn.policy.reminders).friendlyAfterDays, 3)} days, firm after ${n(j(turn.policy.reminders).firmAfterDays, 10)}, final after ${n(j(turn.policy.reminders).finalAfterDays, 21)}).\n${lines.join("\n")}${skipped.length ? `\n\nSkipped: ${skipped.map((x) => `${s(x.invoice_number)} (${s(x.reason)})`).join(", ")}.` : ""}`,
  };
}

function allocationsPlaybook(turn: Turn, allocations: ExplicitAllocation[]): Action {
  const recorded = has(turn, "record_payment_for_invoice");
  if (recorded.length === 0) {
    return {
      type: "calls",
      calls: allocations.map((a) => ({ toolName: "record_payment_for_invoice", input: { invoice_id: a.invoice_id, method: "PAYPAL", payment_id: a.transaction_id, amount: { currency_code: "USD", value: a.amount.toFixed(2) }, note: `Allocation reviewed in the command center: ${usd(a.amount)} of payment ${a.transaction_id} applied to ${a.invoice_number}` } })),
    };
  }
  const lines = allocations.map((a) => {
    const r = recorded.find((x) => s(x.input.invoice_id) === a.invoice_id && s(x.input.payment_id) === a.transaction_id);
    return `- ${usd(a.amount)} of ${a.transaction_id} -> ${a.invoice_number}: ${outcomeLine(r, (o) => `recorded, status ${s(o.status)}`)}`;
  });
  const ok = recorded.filter((r) => !r.denied && !r.error).length;
  return { type: "text", text: `Recorded ${ok} of ${allocations.length} allocation(s) you reviewed:\n${lines.join("\n")}` };
}

function reconcilePlaybook(turn: Turn): Action {
  const explicit = parseAllocations(turn.userText);
  if (explicit.length) return allocationsPlaybook(turn, explicit);
  const matched = first(turn, "match_payments");
  if (!matched) return { type: "calls", calls: [{ toolName: "match_payments", input: {} }] };
  const matches = arr(matched.output.matches);
  const unmatched = arr(matched.output.unmatched);
  const confident = matches.filter((m) => n(m.confidence) >= 0.6 && s(m.action) !== "review");
  const low = matches.filter((m) => n(m.confidence) < 0.6 || s(m.action) === "review");
  const recorded = [...has(turn, "record_payment_for_invoice"), ...has(turn, "record_refund_for_invoice")];
  if (confident.length && recorded.length === 0) {
    const calls: Action["type"] extends "calls" ? never : Array<{ toolName: string; input: J }> = [];
    for (const m of confident) {
      for (const a of arr(m.allocations)) {
        if (s(m.action) === "record_refund") calls.push({ toolName: "record_refund_for_invoice", input: { invoice_id: s(a.invoice_id), method: "PAYPAL", refund_id: s(m.transaction_id), amount: { currency_code: "USD", value: n(a.amount).toFixed(2) }, note: `Matched refund ${s(m.transaction_id)} (${Math.round(n(m.confidence) * 100)}% confidence): ${s(m.reasoning)}` } });
        else calls.push({ toolName: "record_payment_for_invoice", input: { invoice_id: s(a.invoice_id), method: "PAYPAL", payment_id: s(m.transaction_id), amount: { currency_code: "USD", value: n(a.amount).toFixed(2) }, note: `Matched ${s(m.rule, s(m.kind))} payment from ${s(m.payer_email)} (${Math.round(n(m.confidence) * 100)}% confidence): ${s(m.reasoning)}` } });
      }
    }
    return { type: "calls", calls };
  }
  if (matches.length === 0 && unmatched.length === 0) return { type: "text", text: "Everything is reconciled - every successful PayPal payment is already linked to an invoice." };
  const lines = confident.map((m) => {
    const allocs = arr(m.allocations).map((a) => {
      const r = recorded.find((x) => s(x.input.invoice_id) === s(a.invoice_id) && s(x.input.payment_id) === s(m.transaction_id));
      return `${s(a.invoice_number)} ${usd(n(a.amount))}${a.closes ? " (paid in full)" : " (partial)"}: ${outcomeLine(r, (o) => `recorded, status ${s(o.status)}`)}`;
    });
    return `- ${usd(n(m.amount))} from ${s(m.payer_email)} -> ${allocs.join("; ")}. ${s(m.reasoning)}`;
  });
  const lowLines = low.map((m) => `- ${usd(n(m.amount))} from ${s(m.payer_email ?? "unknown")} [${s(m.rule, s(m.kind))}]: ${s(m.reasoning)} (${Math.round(n(m.confidence) * 100)}% - left for you)`);
  const unLines = unmatched.map((u) => `- ${usd(n(u.amount))} from ${s(u.payer_email, "unknown")}${u.memo ? ` "${s(u.memo)}"` : ""}: ${s(u.reason)}`);
  return { type: "text", text: `Reconciliation: ${confident.length} payment(s) matched and recorded.\n${lines.join("\n")}${lowLines.length ? `\n\nNeeds your eyes:\n${lowLines.join("\n")}` : ""}${unLines.length ? `\n\nUnmatched:\n${unLines.join("\n")}` : ""}` };
}

function submitEvidencePlaybook(turn: Turn, id: string): Action {
  const drafted = first(turn, "draft_dispute_evidence");
  if (!drafted) return { type: "calls", calls: [{ toolName: "draft_dispute_evidence", input: { dispute_id: id } }] };
  if (drafted.error) return { type: "text", text: `I could not build the evidence pack for ${id}: ${drafted.error}` };
  const submitted = first(turn, "submit_dispute_evidence");
  if (!submitted) return { type: "calls", calls: [{ toolName: "submit_dispute_evidence", input: { dispute_id: id, notes: s(drafted.output.draft).slice(0, 2000) } }] };
  return {
    type: "text",
    text: `Evidence pack for ${id}${drafted.output.invoice_number ? ` (${s(drafted.output.invoice_number)})` : ""}: ${outcomeLine(submitted, (o) => `submitted to PayPal via the Disputes API ${s(o.channel)} endpoint (HTTP ${n(o.http_status)}), evidence type ${s(o.evidence_type)}${o.tracking ? ` with ${s(j(o.tracking).carrier_name)} tracking ${s(j(o.tracking).tracking_number)}` : ""}`)}.\n\nWhat I sent:\n${s(drafted.output.draft)}`,
  };
}

function disputesPlaybook(turn: Turn): Action {
  const ids = parseDisputeIds(turn.userText);
  if (/\b(submit|send|file|respond)\b/i.test(turn.userText) && ids.length === 1) return submitEvidencePlaybook(turn, ids[0]);
  const listed = first(turn, "list_disputes");
  if (!listed) return { type: "calls", calls: [{ toolName: "list_disputes", input: {} }] };
  const open = arr(listed.output.items).filter((d) => s(d.status) !== "RESOLVED");
  if (open.length === 0) return { type: "text", text: "No open disputes. Nothing to do." };
  const limit = n(j(turn.policy.disputes).autoAcceptUnder, 20);
  const acted = [...has(turn, "accept_dispute_claim"), ...has(turn, "draft_dispute_evidence")];
  if (acted.length === 0) {
    return {
      type: "calls",
      calls: open.map((d) => {
        const amount = n(j(d.dispute_amount).value);
        const id = s(d.dispute_id);
        // The toolkit validates accept_dispute_claim.note against ^[A-Za-z0-9_-]{1,255}$ (no spaces).
        return amount < limit
          ? { toolName: "accept_dispute_claim", input: { dispute_id: id, note: `Accepted_per_policy_under_${Math.round(limit)}_auto-accept_limit_refund_issued_with_apologies` } }
          : { toolName: "draft_dispute_evidence", input: { dispute_id: id } };
      }),
    };
  }
  // Drafted packs go to PayPal next, unless the policy reserves submission for the user ("never").
  const drafts = acted.filter((x) => x.toolName === "draft_dispute_evidence" && !x.error && !s(x.output.next_step).startsWith("Already submitted"));
  const submits = has(turn, "submit_dispute_evidence");
  if (drafts.length && submits.length === 0 && s(j(turn.policy.disputes).submitEvidence, "ask") !== "never") {
    return { type: "calls", calls: drafts.map((x) => ({ toolName: "submit_dispute_evidence", input: { dispute_id: s(x.input.dispute_id), notes: s(x.output.draft).slice(0, 2000) } })) };
  }
  const lines = open.map((d) => {
    const id = s(d.dispute_id);
    const amount = n(j(d.dispute_amount).value);
    const r = acted.find((x) => s(x.input.dispute_id) === id);
    const sub = submits.find((x) => s(x.input.dispute_id) === id);
    const buyer = s(j(arr(d.disputed_transactions)[0]?.buyer).email);
    if (r?.toolName === "accept_dispute_claim") return `- ${id} ${usd(amount)} from ${buyer} (${s(d.reason)}): ${outcomeLine(r, (o) => `accepted, ${usd(n(j(o.refunded).value, amount))} refunded`)}`;
    const drafted = outcomeLine(r, () => `over the ${usd(limit)} auto-accept limit, so I built an evidence pack${d.seller_response_due_date ? ` (respond by ${s(d.seller_response_due_date).slice(0, 10)})` : ""}`);
    const sent = sub ? `; ${outcomeLine(sub, (o) => `submitted to PayPal via ${s(o.channel)} (HTTP ${n(o.http_status)})`)}` : r && !r.error ? "; submission left to you (policy: disputes.submitEvidence = never)" : "";
    return `- ${id} ${usd(amount)} from ${buyer} (${s(d.reason)}): ${drafted}${sent}`;
  });
  const draft = acted.find((x) => x.toolName === "draft_dispute_evidence" && !x.error);
  return { type: "text", text: `Disputes reviewed (${open.length} open):\n${lines.join("\n")}${draft ? `\n\nEvidence pack:\n${s(draft.output.draft)}` : ""}` };
}

function trackingPlaybook(turn: Turn): Action {
  const { number, carrier } = parseTracking(turn.userText);
  const ids = parseInvoiceNumbers(turn.userText);
  const query = ids[0] ?? parseClient(turn.userText) ?? "";
  if (!number) return { type: "text", text: "I need the tracking number (and carrier) to add shipment tracking, e.g. \"Shipped the brand book for Northwind, UPS 1Z999AA10123456784\"." };
  if (!first(turn, "lookup_customer")) return { type: "calls", calls: [{ toolName: "lookup_customer", input: { query } }] };
  const c = customerFrom(turn, query);
  const invoice = (ids[0] ? c.invoices.find((i) => s(i.invoice_number) === ids[0]) : undefined) ?? c.invoices.find((i) => arr(i.transactions).length > 0) ?? c.invoices[0];
  const txn = arr(invoice?.transactions)[0];
  const created = first(turn, "create_shipment_tracking");
  if (!created) {
    if (!txn) return { type: "text", text: `I could not find a paid PayPal transaction for ${query || "that client"} to attach the tracking to. Tracking is attached per transaction; once the invoice is paid I can add it.` };
    return { type: "calls", calls: [{ toolName: "create_shipment_tracking", input: { transaction_id: s(txn.transaction_id), tracking_number: number, carrier: carrier ?? "OTHER", status: "SHIPPED" } }] };
  }
  return { type: "text", text: `${outcomeLine(created, (o) => `Added ${s(o.carrier, carrier ?? "")} tracking ${s(o.tracking_number, number)} (${s(o.status, "SHIPPED")}) to transaction ${s(txn?.transaction_id)}${invoice ? ` for ${s(invoice.invoice_number)}` : ""}`)}. PayPal will show delivery status to the buyer, which also protects you if a dispute is opened.` };
}

function subscriptionPlaybook(turn: Turn): Action {
  const client = parseClient(turn.userText) ?? "Client";
  const amount = parseAmount(turn.userText) ?? 1500;
  const unit = /\bweek/i.test(turn.userText) ? "WEEK" : /\byear|annual/i.test(turn.userText) ? "YEAR" : "MONTH";
  if (!first(turn, "lookup_customer")) return { type: "calls", calls: [{ toolName: "lookup_customer", input: { query: client } }] };
  const c = customerFrom(turn, client);
  const label = c.business ?? `${c.given_name} ${c.surname}`;
  const product = first(turn, "create_product");
  if (!product) return { type: "calls", calls: [{ toolName: "create_product", input: { name: `${label} - design retainer`, type: "SERVICE", description: `Recurring design retainer for ${label}` } }] };
  if (product.error || product.denied) return { type: "text", text: `Could not create the retainer product: ${product.error ?? product.denied}` };
  const plan = first(turn, "create_subscription_plan");
  if (!plan) {
    return {
      type: "calls",
      calls: [
        {
          toolName: "create_subscription_plan",
          input: {
            product_id: s(product.output.id),
            name: `${label} retainer - ${usd(amount)}/${unit.toLowerCase()}`,
            description: `Recurring retainer billed every ${unit.toLowerCase()}`,
            billing_cycles: [{ frequency: { interval_unit: unit, interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: amount.toFixed(2), currency_code: "USD" } } }],
            payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 },
          },
        },
      ],
    };
  }
  if (plan.error || plan.denied) return { type: "text", text: `Could not create the plan: ${plan.error ?? plan.denied}` };
  const sub = first(turn, "create_subscription");
  if (!sub) {
    return {
      type: "calls",
      calls: [
        {
          toolName: "create_subscription",
          input: {
            plan_id: s(plan.output.id),
            subscriber: { name: { given_name: c.given_name, surname: c.surname }, email_address: c.email },
            application_context: { brand_name: s(turn.merchant.businessName, "Vigo Design Studio"), user_action: "SUBSCRIBE_NOW", return_url: "https://example.com/retainer/approved", cancel_url: "https://example.com/retainer/cancelled" },
          },
        },
      ],
    };
  }
  const approve = arr(sub.output.links).find((l) => s(l.rel) === "approve");
  return { type: "text", text: `${outcomeLine(sub, (o) => `Retainer set up for ${label}: plan ${s(plan.output.id)} at ${usd(amount)} per ${unit.toLowerCase()}, subscription ${s(o.id)} (${s(o.status)})`)}.${approve ? `\n\nSend ${c.email} this approval link to activate it: ${s(approve.href)}` : ""}` };
}

function refundPlaybook(turn: Turn): Action {
  const ids = parseInvoiceNumbers(turn.userText);
  const client = parseClient(turn.userText);
  const amount = parseAmount(turn.userText);
  const query = ids[0] ?? client ?? "";
  if (!query) return { type: "text", text: "Which invoice or client should I refund? e.g. \"Refund $600 to Acme for INV-0001\"." };
  if (!first(turn, "lookup_customer")) return { type: "calls", calls: [{ toolName: "lookup_customer", input: { query } }] };
  const c = customerFrom(turn, query);
  const invoice = (ids[0] ? c.invoices.find((i) => s(i.invoice_number) === ids[0]) : undefined) ?? c.invoices.find((i) => arr(i.transactions).some((t) => s(t.type) === "PAYMENT"));
  const txn = arr(invoice?.transactions).find((t) => s(t.type) === "PAYMENT");
  if (!invoice || !txn) return { type: "text", text: `I could not find a paid PayPal transaction for ${query} to refund.` };
  const value = amount ?? n(txn.amount);
  const r = first(turn, "create_refund");
  if (!r) return { type: "calls", calls: [{ toolName: "create_refund", input: { capture_id: s(txn.capture_id, s(txn.transaction_id)), amount: { currency_code: "USD", value: value.toFixed(2) }, invoice_id: s(invoice.invoice_id), note_to_payer: `Refund for ${s(invoice.invoice_number)} as agreed.` } }] };
  return { type: "text", text: `Refund of ${usd(value)} on ${s(invoice.invoice_number)} (${c.business ?? c.email}): ${outcomeLine(r, (o) => `${s(o.status, "COMPLETED")}, refund id ${s(o.id)}`)}.` };
}

function overridePlaybook(turn: Turn): Action {
  const ids = parseInvoiceNumbers(turn.userText);
  const t = turn.userText.toLowerCase();
  const override = /\b(pause|stop)\b/.test(t) ? "paused" : /\baggressive\b/.test(t) ? "aggressive" : /\bgentle\b/.test(t) ? "gentle" : "default";
  if (ids.length === 0) return { type: "text", text: "Tell me which invoice(s), e.g. \"Pause chasing INV-0003\"." };
  const done = has(turn, "set_chase_override");
  if (done.length === 0) return { type: "calls", calls: ids.map((id) => ({ toolName: "set_chase_override", input: { invoice_id: id, override } })) };
  return { type: "text", text: `Chasing set to "${override}" for ${ids.join(", ")}. ${override === "paused" ? "I will not send reminders for these until you resume." : ""}` };
}

function promisePlaybook(turn: Turn): Action {
  const text = turn.userText;
  const ids = parseInvoiceNumbers(text);
  const client = parseClient(text) ?? text.match(/^([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)*)\s+(?:says|said|replied|wrote|promised|will)/)?.[1];
  const classified = first(turn, "classify_client_reply");
  if (!classified) return { type: "calls", calls: [{ toolName: "classify_client_reply", input: { text, invoice_id: ids[0] } }] };
  const kind = s(classified.output.kind);
  const payBy = s(classified.output.pay_by);
  if (kind === "paid-claim") return { type: "text", text: `The client says payment was already sent (${s(classified.output.evidence)}). Say "reconcile payments" and I will look for it among the unlinked PayPal payments.` };
  if (kind === "dispute") return { type: "text", text: `This reads like an objection, not a promise (${s(classified.output.evidence)}). I have not changed the chase; tell me how you want to respond, or say "review disputes" if a PayPal dispute was opened.` };
  if (kind !== "promise" || !payBy) return { type: "text", text: `I could not find a date to record${kind === "promise" ? " (the client promised but gave no date)" : ""}. Tell me the invoice and the date, e.g. "Acme will pay INV-0001 by 2026-10-20".` };
  let invoiceId = ids[0];
  if (!invoiceId) {
    if (!first(turn, "lookup_customer")) return client ? { type: "calls", calls: [{ toolName: "lookup_customer", input: { query: client } }] } : { type: "text", text: "Which client or invoice is this about? e.g. \"Acme says they will pay INV-0001 by the 20th\"." };
    const c = customerFrom(turn, client);
    const open = c.invoices.filter((i) => n(i.due) > 0 && ["UNPAID", "SENT", "PARTIALLY_PAID", "PAYMENT_PENDING"].includes(s(i.status))).sort((a, b) => s(a.due_date).localeCompare(s(b.due_date)));
    if (!open.length) return { type: "text", text: `${client ?? "That client"} has no open invoice to record a promise against.` };
    invoiceId = s(open[0].invoice_id);
  }
  const recorded = first(turn, "record_promise");
  if (!recorded) {
    const amount = classified.output.amount !== undefined && classified.output.amount !== null ? n(classified.output.amount) : undefined;
    return { type: "calls", calls: [{ toolName: "record_promise", input: { invoice_id: invoiceId, pay_by: payBy, ...(amount ? { amount } : {}), source: /\b(client|they|she|he|replied|says|said|wrote)\b/i.test(text) ? "client_reply" : "user", quote: text.slice(0, 300) } }] };
  }
  const o = recorded.output;
  return { type: "text", text: outcomeLine(recorded, () => `Recorded: ${s(o.client)} will pay ${o.promise && j(o.promise).amount ? usd(n(j(o.promise).amount)) : `the ${usd(n(o.balance_due))} balance`} on ${s(o.invoice_number)} by ${payBy}. Chasing is ${s(o.chasing)}; if the money has not arrived by then the next reminder escalates one stage and says so (promises.brokenEscalates). The grid shows the promise on the invoice.`) };
}

function statusPlaybook(turn: Turn): Action {
  const r = first(turn, "summarize_receivables");
  if (!r) return { type: "calls", calls: [{ toolName: "summarize_receivables", input: {} }] };
  const o = r.output;
  const oldest = arr(o.oldest_overdue).map((x) => `${s(x.invoice_number)} ${s(x.client)} ${usd(n(x.due))} (${n(x.overdue_days)}d)`).join(", ");
  return { type: "text", text: `Receivables: ${usd(n(o.outstanding))} outstanding across ${n(o.open_invoices)} open invoices; ${usd(n(o.overdue))} of that is overdue (${n(o.overdue_invoices)} invoices). Collected ${usd(n(o.collected_last_30_days))} in the last 30 days. ${n(o.open_disputes)} open dispute(s), ${n(o.unlinked_payments)} payment(s) not yet matched to an invoice.${oldest ? `\n\nOldest overdue: ${oldest}.` : ""}\n\nSay "run collections", "reconcile payments" or "review disputes" and I will handle them under your policy.` };
}

const HELP = `I am Chaser, your receivables agent on PayPal. Try:
- "I finished the logo package for Acme Corp, $1,200, net 15" - creates and sends an invoice
- "Run collections" - chases overdue invoices under your policy
- "Reconcile payments" - matches unlinked PayPal payments to invoices
- "Review disputes" - accepts small ones, builds and submits evidence packs for big ones (your policy decides if it asks first)
- "Record these payment allocations: <transaction> -> INV-0015 $900.00" - records what you reviewed in the match grid
- "Shipped the brand book for Northwind, UPS 1Z999AA10123456784" - adds tracking
- "Set up a $1,500 monthly retainer for Northwind Traders" - creates a subscription
- "Acme says they will pay INV-0001 by the 20th" - records a promise to pay; chasing pauses, a broken promise escalates
- "Refund $120 on INV-0007" / "Pause chasing INV-0003" / "What's outstanding?"`;

export function plan(turn: Turn): Action {
  switch (detectIntent(turn.userText)) {
    case "invoice":
      return invoicePlaybook(turn);
    case "collections":
      return collectionsPlaybook(turn);
    case "reconcile":
      return reconcilePlaybook(turn);
    case "disputes":
      return disputesPlaybook(turn);
    case "tracking":
      return trackingPlaybook(turn);
    case "subscription":
      return subscriptionPlaybook(turn);
    case "refund":
      return refundPlaybook(turn);
    case "override":
      return overridePlaybook(turn);
    case "status":
      return statusPlaybook(turn);
    case "promise":
      return promisePlaybook(turn);
    default:
      return { type: "text", text: HELP };
  }
}

/* ---------------- LanguageModelV3 implementation ---------------- */

const USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

let callSeq = 0;

export class MockPlannerModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "chaser-mock";
  readonly modelId = "rule-based-planner";
  readonly supportedUrls = {};

  constructor(private readonly delayMs = 12) {}

  private decide(options: LanguageModelV3CallOptions): Action {
    const turn = parseTurn(options.prompt);
    const action = plan(turn);
    if (action.type === "calls") {
      const available = new Set((options.tools ?? []).map((t) => t.name));
      const calls = action.calls.filter((c) => available.size === 0 || available.has(c.toolName));
      if (calls.length === 0) return { type: "text", text: `I wanted to call ${action.calls.map((c) => c.toolName).join(", ")} but those tools are not available.` };
      return { type: "calls", calls };
    }
    return action;
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const action = this.decide(options);
    if (action.type === "text") {
      return { content: [{ type: "text", text: action.text }], finishReason: { unified: "stop", raw: "stop" }, usage: USAGE, warnings: [] };
    }
    return {
      content: action.calls.map((c) => ({ type: "tool-call" as const, toolCallId: `call_${++callSeq}`, toolName: c.toolName, input: JSON.stringify(c.input) })),
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
      usage: USAGE,
      warnings: [],
    };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const action = this.decide(options);
    const delay = this.delayMs;
    const parts: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }];
    if (action.type === "text") {
      const id = `txt_${++callSeq}`;
      parts.push({ type: "text-start", id });
      for (const chunk of action.text.match(/[^\s]+\s*|\s+/g) ?? [action.text]) parts.push({ type: "text-delta", id, delta: chunk });
      parts.push({ type: "text-end", id });
      parts.push({ type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: "stop" } });
    } else {
      for (const c of action.calls) {
        const id = `call_${++callSeq}`;
        const input = JSON.stringify(c.input);
        parts.push({ type: "tool-input-start", id, toolName: c.toolName });
        parts.push({ type: "tool-input-delta", id, delta: input });
        parts.push({ type: "tool-input-end", id });
        parts.push({ type: "tool-call", toolCallId: id, toolName: c.toolName, input });
      }
      parts.push({ type: "finish", usage: USAGE, finishReason: { unified: "tool-calls", raw: "tool-calls" } });
    }
    let i = 0;
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async pull(controller) {
        if (i >= parts.length) {
          controller.close();
          return;
        }
        const part = parts[i++];
        if (delay > 0 && part.type === "text-delta") await new Promise((r) => setTimeout(r, delay));
        controller.enqueue(part);
      },
    });
    return { stream };
  }
}
