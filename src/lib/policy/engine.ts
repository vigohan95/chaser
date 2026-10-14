import type { Dispute, Invoice } from "../paypal/types";
import { round2 } from "../paypal/types";
import type { Policy } from "./schema";
import { promiseStatus } from "../agent/promise";
import { decideAfterFinal } from "../agent/after-final";

export type Decision = "allow" | "approve" | "deny";

export interface Evaluation {
  decision: Decision;
  reason: string;
  /** Short human label for the audit timeline / approval card. */
  summary: string;
  /** The policy field (JSON path into the policy) the decision came from, so the approval ledger can cite it. */
  rule: string;
}

export interface EvaluationContext {
  policy: Policy;
  invoices: Invoice[];
  disputes: Dispute[];
  now?: Date;
}

/** Tools that only read state. They never need approval. */
export const READ_ONLY_PREFIXES = ["list_", "get_", "search_", "show_", "generate_invoice_qr_code", "generate_invoice_number", "propose_", "match_", "lookup_", "draft_", "summarize_", "classify_"];

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_PREFIXES.some((p) => name.startsWith(p));
}

type Input = Record<string, unknown>;

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function amountOf(input: Input): number | undefined {
  const a = input.amount;
  if (a && typeof a === "object") return num((a as Input).value);
  return num(a);
}

function invoiceTotal(input: Input): number {
  const items = Array.isArray(input.items) ? (input.items as Input[]) : [];
  let total = 0;
  for (const it of items) {
    const qty = num(it.quantity) ?? 1;
    const unit = it.unit_amount && typeof it.unit_amount === "object" ? num((it.unit_amount as Input).value) : num(it.unit_amount);
    total += qty * (unit ?? 0);
  }
  total += num(input.shipping_cost) ?? 0;
  return round2(total);
}

function findInvoice(ctx: EvaluationContext, id: unknown): Invoice | undefined {
  if (typeof id !== "string") return undefined;
  return ctx.invoices.find((i) => i.id === id || i.invoice_number === id);
}

function findDispute(ctx: EvaluationContext, id: unknown): Dispute | undefined {
  if (typeof id !== "string") return undefined;
  return ctx.disputes.find((d) => d.id === id);
}

function fmt(n: number, ccy: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: ccy }).format(n);
}

/**
 * Decide whether a tool call may run, needs a human, or is refused.
 * Pure: no I/O, so it is trivially unit-testable and safe to call from the AI SDK's `toolApproval` hook.
 */
export function evaluateAction(tool: string, rawInput: unknown, ctx: EvaluationContext): Evaluation {
  const input: Input = rawInput && typeof rawInput === "object" ? (rawInput as Input) : {};
  const { policy } = ctx;
  const ccy = policy.currency;
  const now = ctx.now ?? new Date();

  if (policy.approvals.neverAllow.includes(tool)) {
    return { decision: "deny", reason: `Policy: "${tool}" is on the never-allow list.`, summary: tool, rule: "approvals.neverAllow" };
  }
  if (isReadOnlyTool(tool)) {
    return { decision: "allow", reason: "Read-only tool.", summary: tool, rule: "read-only" };
  }
  if (policy.approvals.alwaysAsk.includes(tool)) {
    return { decision: "approve", reason: `Policy: "${tool}" always needs your approval.`, summary: tool, rule: "approvals.alwaysAsk" };
  }

  switch (tool) {
    case "create_invoice": {
      const total = invoiceTotal(input);
      const summary = `Create invoice for ${fmt(total, ccy)}`;
      if (total >= policy.approvals.invoicesOver) {
        return { decision: "approve", reason: `Invoice total ${fmt(total, ccy)} is at or above your ${fmt(policy.approvals.invoicesOver, ccy)} approval threshold.`, summary, rule: "approvals.invoicesOver" };
      }
      return { decision: "allow", reason: `Invoice total ${fmt(total, ccy)} is under the ${fmt(policy.approvals.invoicesOver, ccy)} threshold.`, summary, rule: "approvals.invoicesOver" };
    }

    case "send_invoice": {
      const inv = findInvoice(ctx, input.invoice_id);
      const summary = `Send invoice ${inv?.invoice_number ?? String(input.invoice_id ?? "")}`;
      if (inv && inv.total >= policy.approvals.invoicesOver) {
        return { decision: "approve", reason: `Invoice total ${fmt(inv.total, ccy)} is at or above your ${fmt(policy.approvals.invoicesOver, ccy)} approval threshold.`, summary, rule: "approvals.invoicesOver" };
      }
      return { decision: "allow", reason: "Sending an invoice moves no money.", summary, rule: "approvals.invoicesOver" };
    }

    case "send_invoice_reminder": {
      const inv = findInvoice(ctx, input.invoice_id);
      const summary = `Remind ${inv?.client.business ?? inv?.client.email ?? "client"} about ${inv?.invoice_number ?? String(input.invoice_id ?? "")}`;
      if (!inv) return { decision: "allow", reason: "Reminder for an invoice not in the local view; allowed (no money moves).", summary, rule: "reminders" };
      if (inv.chase_override === "paused") {
        return { decision: "deny", reason: `Chasing is paused for ${inv.invoice_number}.`, summary, rule: "invoice.chase_override" };
      }
      if (policy.promises.pauseChasing && promiseStatus(inv, now, policy) === "open") {
        return { decision: "deny", reason: `${inv.client.business ?? inv.client.email} promised to pay ${inv.invoice_number} by ${inv.promise!.pay_by}; chasing is paused until then (grace ${policy.promises.graceDays} day${policy.promises.graceDays === 1 ? "" : "s"}).`, summary, rule: "promises.pauseChasing" };
      }
      if (inv.reminders.length >= policy.reminders.maxReminders) {
        return { decision: "deny", reason: `${inv.invoice_number} already received ${inv.reminders.length} reminders (max ${policy.reminders.maxReminders}).`, summary, rule: "reminders.maxReminders" };
      }
      const last = inv.reminders.at(-1);
      if (last) {
        const days = (now.getTime() - new Date(last.at).getTime()) / 86_400_000;
        if (days < policy.reminders.minDaysBetweenReminders) {
          return { decision: "deny", reason: `Last reminder for ${inv.invoice_number} was ${days.toFixed(1)} days ago (min gap ${policy.reminders.minDaysBetweenReminders} days).`, summary, rule: "reminders.minDaysBetweenReminders" };
        }
      }
      return { decision: "allow", reason: `Within reminder cadence (${inv.reminders.length}/${policy.reminders.maxReminders} sent).`, summary, rule: "reminders.maxReminders" };
    }

    case "record_payment_for_invoice": {
      const inv = findInvoice(ctx, input.invoice_id);
      const amt = amountOf(input);
      const summary = `Record ${amt !== undefined ? fmt(amt, ccy) : "payment"} on ${inv?.invoice_number ?? String(input.invoice_id ?? "")}`;
      if (!inv) return { decision: "approve", reason: "Cannot verify the invoice locally; please confirm.", summary, rule: "reconciliation" };
      if (amt === undefined) {
        return policy.reconciliation.autoRecordExactMatches
          ? { decision: "allow", reason: "Recording full payment of the invoice balance.", summary, rule: "reconciliation.autoRecordExactMatches" }
          : { decision: "approve", reason: "Auto-recording is off in your policy.", summary, rule: "reconciliation.autoRecordExactMatches" };
      }
      const tol = policy.reconciliation.amountTolerance;
      if (amt > inv.due + tol) {
        return { decision: "approve", reason: `${fmt(amt, ccy)} exceeds the ${fmt(inv.due, ccy)} still due on ${inv.invoice_number}.`, summary, rule: "reconciliation.amountTolerance" };
      }
      if (Math.abs(amt - inv.due) <= tol) {
        return policy.reconciliation.autoRecordExactMatches
          ? { decision: "allow", reason: "Exact match of the outstanding balance.", summary, rule: "reconciliation.autoRecordExactMatches" }
          : { decision: "approve", reason: "Auto-recording exact matches is off in your policy.", summary, rule: "reconciliation.autoRecordExactMatches" };
      }
      return policy.reconciliation.autoRecordPartials
        ? { decision: "allow", reason: `Partial payment (${fmt(amt, ccy)} of ${fmt(inv.due, ccy)} due).`, summary, rule: "reconciliation.autoRecordPartials" }
        : { decision: "approve", reason: "Auto-recording partial payments is off in your policy.", summary, rule: "reconciliation.autoRecordPartials" };
    }

    case "record_refund_for_invoice":
    case "create_refund": {
      const amt = amountOf(input);
      const inv = findInvoice(ctx, input.invoice_id);
      const summary = `Refund ${amt !== undefined ? fmt(amt, ccy) : "full amount"}${inv ? ` on ${inv.invoice_number}` : ""}`;
      if (amt === undefined) {
        return { decision: "approve", reason: "Full refunds always need your approval.", summary, rule: "approvals.refundsOver" };
      }
      if (amt >= policy.approvals.refundsOver) {
        return { decision: "approve", reason: `Refund ${fmt(amt, ccy)} is at or above your ${fmt(policy.approvals.refundsOver, ccy)} approval threshold.`, summary, rule: "approvals.refundsOver" };
      }
      return { decision: "allow", reason: `Refund ${fmt(amt, ccy)} is under the ${fmt(policy.approvals.refundsOver, ccy)} threshold.`, summary, rule: "approvals.refundsOver" };
    }

    case "accept_dispute_claim": {
      const d = findDispute(ctx, input.dispute_id);
      const summary = `Accept dispute ${String(input.dispute_id ?? "")}${d ? ` (${fmt(d.amount, d.currency)})` : ""}`;
      if (!d) return { decision: "approve", reason: "Dispute not in the local view; please confirm.", summary, rule: "disputes.autoAcceptUnder" };
      if (d.amount < policy.disputes.autoAcceptUnder) {
        return { decision: "allow", reason: `${fmt(d.amount, d.currency)} is under your ${fmt(policy.disputes.autoAcceptUnder, ccy)} auto-accept limit.`, summary, rule: "disputes.autoAcceptUnder" };
      }
      return { decision: "approve", reason: `${fmt(d.amount, d.currency)} is at or above your ${fmt(policy.disputes.autoAcceptUnder, ccy)} auto-accept limit.`, summary, rule: "disputes.autoAcceptUnder" };
    }

    case "submit_dispute_evidence": {
      const d = findDispute(ctx, input.dispute_id);
      const summary = `Submit evidence pack for dispute ${String(input.dispute_id ?? "")}${d ? ` (${fmt(d.amount, d.currency)})` : ""}`;
      const mode = policy.disputes.submitEvidence;
      if (mode === "never") return { decision: "deny", reason: "Policy: evidence submission is reserved for you (disputes.submitEvidence = never).", summary, rule: "disputes.submitEvidence" };
      if (mode === "auto") return { decision: "allow", reason: "Policy: evidence packs go to PayPal without asking (disputes.submitEvidence = auto).", summary, rule: "disputes.submitEvidence" };
      return { decision: "approve", reason: "Evidence sent to PayPal is a statement made on your behalf; review the pack before it goes (disputes.submitEvidence = ask).", summary, rule: "disputes.submitEvidence" };
    }

    case "create_shipment_tracking":
    case "update_shipment_tracking":
      return { decision: "allow", reason: "Adding tracking moves no money and protects you in disputes.", summary: `Add tracking ${String(input.tracking_number ?? "")}`, rule: "default-allow" };

    case "create_product":
    case "create_subscription_plan":
    case "create_subscription":
    case "setup_invoice_auto_reminders":
    case "update_invoicing":
    case "create_conditional_rules_for_invoice":
      return { decision: "allow", reason: "Sets up billing; the client still has to approve any charge.", summary: tool.replaceAll("_", " "), rule: "default-allow" };

    case "set_chase_override": {
      return { decision: "allow", reason: "Local setting only.", summary: `Set chasing to ${String(input.override ?? "")}`, rule: "default-allow" };
    }

    case "resolve_after_final": {
      const inv = findInvoice(ctx, input.invoice_id);
      const kind = String(input.resolution ?? "");
      const af = policy.collections.afterFinal;
      const label = kind === "write_off" ? "Write off" : kind === "settlement" ? "Offer a settlement on" : "Build the hand-off pack for";
      const summary = `${label} ${inv?.invoice_number ?? String(input.invoice_id ?? "")}${inv ? ` (${fmt(inv.due, ccy)} outstanding)` : ""}`;
      if (!inv) return { decision: "approve", reason: "Cannot verify the invoice locally; please confirm.", summary, rule: "collections.afterFinal" };
      if (kind === "write_off") {
        if (inv.due >= af.writeOffUnder) return { decision: "deny", reason: `${fmt(inv.due, ccy)} is not under your ${fmt(af.writeOffUnder, ccy)} write-off threshold (collections.afterFinal.writeOffUnder).`, summary, rule: "collections.afterFinal.writeOffUnder" };
        return { decision: "approve", reason: `A write-off takes ${fmt(inv.due, ccy)} off your books and cancels ${inv.invoice_number} on PayPal; under the ${fmt(af.writeOffUnder, ccy)} threshold, but it always needs your approval.`, summary, rule: "collections.afterFinal.writeOffUnder" };
      }
      if (kind === "settlement") {
        if (af.settlementOfferPercent <= 0) return { decision: "deny", reason: "Settlement offers are off in your policy (collections.afterFinal.settlementOfferPercent = 0).", summary, rule: "collections.afterFinal.settlementOfferPercent" };
        const offer = decideAfterFinal(inv, { ...policy, collections: { afterFinal: { ...af, settlementMaxBalance: Number.MAX_SAFE_INTEGER, writeOffUnder: 0 } } }).offer_amount ?? inv.due;
        return { decision: "approve", reason: `Offering ${af.settlementOfferPercent}% off (${fmt(offer, ccy)} instead of ${fmt(inv.due, ccy)}) gives money away; a new discounted invoice is created and sent only when you approve.`, summary, rule: "collections.afterFinal.settlementOfferPercent" };
      }
      if (kind === "handoff") {
        return af.handoff === "auto"
          ? { decision: "allow", reason: "The hand-off pack moves no money; your policy builds it without asking (collections.afterFinal.handoff = auto).", summary, rule: "collections.afterFinal.handoff" }
          : { decision: "approve", reason: "The hand-off pack pauses chasing and is what you send to a collector or a court; review it first (collections.afterFinal.handoff = ask).", summary, rule: "collections.afterFinal.handoff" };
      }
      return { decision: "deny", reason: `Unknown resolution "${kind}".`, summary, rule: "collections.afterFinal" };
    }

    case "record_promise": {
      const inv = findInvoice(ctx, input.invoice_id);
      const payBy = typeof input.pay_by === "string" ? input.pay_by : "";
      const amt = num(input.amount);
      const summary = `Record promise: ${inv?.client.business ?? inv?.client.email ?? "client"} pays ${amt !== undefined ? fmt(amt, ccy) : "the balance"} on ${inv?.invoice_number ?? String(input.invoice_id ?? "")} by ${payBy}`;
      const day = new Date(payBy + "T00:00:00Z").getTime();
      if (!payBy || Number.isNaN(day)) return { decision: "deny", reason: "A promise needs a date (yyyy-mm-dd).", summary, rule: "promises.maxDays" };
      const daysOut = Math.ceil((day - now.getTime()) / 86_400_000);
      if (daysOut < 0) return { decision: "deny", reason: `${payBy} is in the past.`, summary, rule: "promises.maxDays" };
      if (daysOut > policy.promises.maxDays) return { decision: "approve", reason: `${payBy} is ${daysOut} days out, beyond your ${policy.promises.maxDays}-day limit for pausing a chase on a promise.`, summary, rule: "promises.maxDays" };
      if (inv && amt !== undefined && amt > inv.due + policy.reconciliation.amountTolerance) return { decision: "approve", reason: `${fmt(amt, ccy)} promised exceeds the ${fmt(inv.due, ccy)} due on ${inv.invoice_number}; please confirm.`, summary, rule: "promises.maxDays" };
      return { decision: "allow", reason: `Promise ${daysOut} day${daysOut === 1 ? "" : "s"} out, within promises.maxDays = ${policy.promises.maxDays}; chasing pauses until ${payBy}${policy.promises.brokenEscalates ? " and escalates if it is not kept" : ""}.`, summary, rule: "promises.maxDays" };
    }

    default:
      return { decision: "approve", reason: `No policy rule for "${tool}"; defaulting to ask.`, summary: tool, rule: "default-ask" };
  }
}
