/**
 * Sandbox/live PayPal via the official PayPal Agent Toolkit (@paypal/agent-toolkit 1.11.0).
 *
 * The toolkit's `getTools()` returns Vercel AI SDK v4-style tools ({ description, parameters, execute }).
 * We reuse the zod `parameters` + descriptions verbatim and re-wrap them for AI SDK v7 in tools.ts.
 */
import { ALL_TOOLS_ENABLED, PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import type { z } from "zod";
import { paypalEnv } from "../env";
import { submitDisputeEvidence, type EvidenceSubmission } from "./rest";
import type { Dispute, Invoice, InvoiceStatus, Transaction } from "./types";
import { round2 } from "./types";

export interface RawTool {
  description: string;
  parameters: z.ZodTypeAny;
  execute: (input: unknown, options: { toolCallId: string; messages: unknown[] }) => Promise<string>;
}

let cache: { key: string; toolkit: PayPalAgentToolkit; tools: Record<string, RawTool> } | undefined;

/** Instantiating the toolkit does no network I/O, so dummy credentials are fine for schema access in mock mode. */
export function getRawTools(): Record<string, RawTool> {
  const { clientId, clientSecret, sandbox } = paypalEnv();
  const key = `${clientId}|${sandbox}`;
  if (cache && cache.key === key) return cache.tools;
  const toolkit = new PayPalAgentToolkit({
    clientId: clientId || "mock-client-id",
    clientSecret: clientSecret || "mock-client-secret",
    configuration: { actions: ALL_TOOLS_ENABLED, context: { sandbox } },
  });
  const tools = toolkit.getTools() as unknown as Record<string, RawTool>;
  cache = { key, toolkit, tools };
  return tools;
}

export class PayPalApiError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
  }
}

/** Run a toolkit tool against the PayPal sandbox and return parsed JSON (the toolkit returns JSON strings). */
export async function liveExecute(tool: string, input: unknown): Promise<unknown> {
  if (tool === "submit_dispute_evidence") {
    // Not in the toolkit: Disputes API provide-evidence / send-message over plain REST.
    const i = (input ?? {}) as { dispute_id: string; stage?: string } & EvidenceSubmission;
    let stage = i.stage;
    if (!stage) {
      const d = (await liveExecute("get_dispute", { dispute_id: i.dispute_id })) as { dispute_life_cycle_stage?: string };
      stage = d.dispute_life_cycle_stage;
    }
    return submitDisputeEvidence(i.dispute_id, { evidence_type: i.evidence_type, notes: i.notes, tracking: i.tracking }, stage);
  }
  const raw = getRawTools()[tool];
  if (!raw) throw new PayPalApiError(`Unknown PayPal tool "${tool}"`);
  const text = await raw.execute(input, { toolCallId: "", messages: [] });
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* some tools return plain text */
  }
  if (parsed && typeof parsed === "object" && "error" in (parsed as object)) {
    const err = (parsed as { error: { message?: string } }).error;
    throw new PayPalApiError(err?.message ?? "PayPal error", parsed);
  }
  return parsed;
}

/* ---------- mappers from PayPal REST shapes to the command-center domain ---------- */

type J = Record<string, unknown>;
const j = (v: unknown): J => (v && typeof v === "object" ? (v as J) : {});
const s = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const n = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);

export function mapInvoice(pp: unknown): Invoice {
  const o = j(pp);
  const detail = j(o.detail);
  const recipient = j((o.primary_recipients as unknown[] | undefined)?.[0]);
  const billing = j(recipient.billing_info);
  const name = j(billing.name);
  const items = ((o.items as unknown[] | undefined) ?? []).map((it) => {
    const x = j(it);
    return { name: s(x.name, "Item"), description: s(x.description) || undefined, quantity: n(x.quantity) || 1, unit_amount: n(j(x.unit_amount).value) };
  });
  const total = n(j(o.amount).value) || round2(items.reduce((a, i) => a + i.quantity * i.unit_amount, 0));
  const paid = n(j(j(o.payments).paid_amount).value);
  const refunded = n(j(j(o.refunds).refund_amount).value);
  const dueAmt = o.due_amount !== undefined ? n(j(o.due_amount).value) : round2(Math.max(0, total - paid));
  const links = ((o.links as unknown[] | undefined) ?? []).map(j);
  const id = s(o.id);
  const view = s(links.find((l) => l.rel === "self")?.href) || `https://www.sandbox.paypal.com/invoice/p/#${id}`;
  const pay = s(links.find((l) => l.rel === "payer-view")?.href) || `https://www.sandbox.paypal.com/invoice/payerView/details/${id}`;
  const currency = s(detail.currency_code, "USD");
  return {
    id,
    invoice_number: s(detail.invoice_number, id),
    status: s(o.status, "DRAFT") as InvoiceStatus,
    client: { business: s(billing.business_name) || undefined, given_name: s(name.given_name, "Client"), surname: s(name.surname), email: s(billing.email_address) },
    items,
    currency,
    total,
    paid,
    refunded,
    due: dueAmt,
    invoice_date: s(detail.invoice_date).slice(0, 10),
    due_date: s(j(detail.payment_term).due_date, s(detail.invoice_date)).slice(0, 10),
    reference: s(detail.reference) || undefined,
    note: s(detail.note) || undefined,
    reminders: [],
    chase_override: "default",
    links: { view, pay },
  };
}

export function mapTransaction(pp: unknown): Transaction {
  const o = j(pp);
  const info = j(o.transaction_info);
  const payer = j(o.payer_info);
  const amount = n(j(info.transaction_amount).value);
  const code = s(info.transaction_event_code);
  const type: Transaction["type"] = code.startsWith("T11") || amount < 0 ? "REFUND" : code.startsWith("T01") ? "FEE" : "PAYMENT";
  return {
    id: s(info.transaction_id),
    date: s(info.transaction_initiation_date),
    type,
    amount,
    fee: -n(j(info.fee_amount).value),
    currency: s(j(info.transaction_amount).currency_code, "USD"),
    status: (s(info.transaction_status, "S") as Transaction["status"]),
    payer_email: s(payer.email_address) || undefined,
    payer_name: s(j(payer.payer_name).alternate_full_name) || [s(j(payer.payer_name).given_name), s(j(payer.payer_name).surname)].filter(Boolean).join(" ") || undefined,
    memo: s(info.transaction_note) || s(info.transaction_subject) || undefined,
    invoice_id: s(info.invoice_id) || undefined,
    capture_id: s(info.paypal_reference_id) || s(info.transaction_id) || undefined,
  };
}

export function mapDispute(pp: unknown): Dispute {
  const o = j(pp);
  const tx = j((o.disputed_transactions as unknown[] | undefined)?.[0]);
  const buyer = j(tx.buyer);
  return {
    id: s(o.dispute_id),
    transaction_id: s(tx.seller_transaction_id),
    invoice_id: s(tx.invoice_number) || undefined,
    amount: n(j(o.dispute_amount).value),
    currency: s(j(o.dispute_amount).currency_code, "USD"),
    reason: s(o.reason, "OTHER"),
    status: s(o.status, "OPEN_INQUIRIES") as Dispute["status"],
    created: s(o.create_time),
    seller_response_due: s(o.seller_response_due_date) || undefined,
    buyer_email: s(buyer.email),
    buyer_name: s(buyer.name) || undefined,
    outcome: (s(j(o.dispute_outcome).outcome_code) || undefined) as Dispute["outcome"],
    life_cycle_stage: (s(o.dispute_life_cycle_stage) || undefined) as Dispute["life_cycle_stage"],
  };
}
