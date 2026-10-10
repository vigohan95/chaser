import type { Dispute, Invoice } from "../paypal/types";
import { round2 } from "../paypal/types";
import type { Policy } from "./schema";

export type Decision = "allow" | "approve" | "deny";

export interface Evaluation {
  decision: Decision;
  reason: string;
  /** Short human label for the audit timeline / approval card. */
  summary: string;
}

export interface EvaluationContext {
  policy: Policy;
  invoices: Invoice[];
  disputes: Dispute[];
  now?: Date;
}

/** Tools that only read state. They never need approval. */
export const READ_ONLY_PREFIXES = ["list_", "get_", "search_", "show_", "generate_invoice_qr_code", "generate_invoice_number", "propose_", "match_", "lookup_", "draft_", "summarize_"];

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
    return { decision: "deny", reason: `Policy: "${tool}" is on the never-allow list.`, summary: tool };
  }
  if (isReadOnlyTool(tool)) {
    return { decision: "allow", reason: "Read-only tool.", summary: tool };
  }
  if (policy.approvals.alwaysAsk.includes(tool)) {
    return { decision: "approve", reason: `Policy: "${tool}" always needs your approval.`, summary: tool };
  }

  switch (tool) {
    case "create_invoice": {
      const total = invoiceTotal(input);
      const summary = `Create invoice for ${fmt(total, ccy)}`;
      if (total >= policy.approvals.invoicesOver) {
        return { decision: "approve", reason: `Invoice total ${fmt(total, ccy)} is at or above your ${fmt(policy.approvals.invoicesOver, ccy)} approval threshold.`, summary };
      }
      return { decision: "allow", reason: `Invoice total ${fmt(total, ccy)} is under the ${fmt(policy.approvals.invoicesOver, ccy)} threshold.`, summary };
    }

    case "send_invoice": {
      const inv = findInvoice(ctx, input.invoice_id);
      const summary = `Send invoice ${inv?.invoice_number ?? String(input.invoice_id ?? "")}`;
      if (inv && inv.total >= policy.approvals.invoicesOver) {
        return { decision: "approve", reason: `Invoice total ${fmt(inv.total, ccy)} is at or above your ${fmt(policy.approvals.invoicesOver, ccy)} approval threshold.`, summary };
      }
      return { decision: "allow", reason: "Sending an invoice moves no money.", summary };
    }

    case "send_invoice_reminder": {
      const inv = findInvoice(ctx, input.invoice_id);
      const summary = `Remind ${inv?.client.business ?? inv?.client.email ?? "client"} about ${inv?.invoice_number ?? String(input.invoice_id ?? "")}`;
      if (!inv) return { decision: "allow", reason: "Reminder for an invoice not in the local view; allowed (no money moves).", summary };
      if (inv.chase_override === "paused") {
        return { decision: "deny", reason: `Chasing is paused for ${inv.invoice_number}.`, summary };
      }
      if (inv.reminders.length >= policy.reminders.maxReminders) {
        return { decision: "deny", reason: `${inv.invoice_number} already received ${inv.reminders.length} reminders (max ${policy.reminders.maxReminders}).`, summary };
      }
      const last = inv.reminders.at(-1);
      if (last) {
        const days = (now.getTime() - new Date(last.at).getTime()) / 86_400_000;
        if (days < policy.reminders.minDaysBetweenReminders) {
          return { decision: "deny", reason: `Last reminder for ${inv.invoice_number} was ${days.toFixed(1)} days ago (min gap ${policy.reminders.minDaysBetweenReminders} days).`, summary };
        }
      }
      return { decision: "allow", reason: `Within reminder cadence (${inv.reminders.length}/${policy.reminders.maxReminders} sent).`, summary };
    }

    case "record_payment_for_invoice": {
      const inv = findInvoice(ctx, input.invoice_id);
      const amt = amountOf(input);
      const summary = `Record ${amt !== undefined ? fmt(amt, ccy) : "payment"} on ${inv?.invoice_number ?? String(input.invoice_id ?? "")}`;
      if (!inv) return { decision: "approve", reason: "Cannot verify the invoice locally; please confirm.", summary };
      if (amt === undefined) {
        return policy.reconciliation.autoRecordExactMatches
          ? { decision: "allow", reason: "Recording full payment of the invoice balance.", summary }
          : { decision: "approve", reason: "Auto-recording is off in your policy.", summary };
      }
      const tol = policy.reconciliation.amountTolerance;
      if (amt > inv.due + tol) {
        return { decision: "approve", reason: `${fmt(amt, ccy)} exceeds the ${fmt(inv.due, ccy)} still due on ${inv.invoice_number}.`, summary };
      }
      if (Math.abs(amt - inv.due) <= tol) {
        return policy.reconciliation.autoRecordExactMatches
          ? { decision: "allow", reason: "Exact match of the outstanding balance.", summary }
          : { decision: "approve", reason: "Auto-recording exact matches is off in your policy.", summary };
      }
      return policy.reconciliation.autoRecordPartials
        ? { decision: "allow", reason: `Partial payment (${fmt(amt, ccy)} of ${fmt(inv.due, ccy)} due).`, summary }
        : { decision: "approve", reason: "Auto-recording partial payments is off in your policy.", summary };
    }

    case "record_refund_for_invoice":
    case "create_refund": {
      const amt = amountOf(input);
      const inv = findInvoice(ctx, input.invoice_id);
      const summary = `Refund ${amt !== undefined ? fmt(amt, ccy) : "full amount"}${inv ? ` on ${inv.invoice_number}` : ""}`;
      if (amt === undefined) {
        return { decision: "approve", reason: "Full refunds always need your approval.", summary };
      }
      if (amt >= policy.approvals.refundsOver) {
        return { decision: "approve", reason: `Refund ${fmt(amt, ccy)} is at or above your ${fmt(policy.approvals.refundsOver, ccy)} approval threshold.`, summary };
      }
      return { decision: "allow", reason: `Refund ${fmt(amt, ccy)} is under the ${fmt(policy.approvals.refundsOver, ccy)} threshold.`, summary };
    }

    case "accept_dispute_claim": {
      const d = findDispute(ctx, input.dispute_id);
      const summary = `Accept dispute ${String(input.dispute_id ?? "")}${d ? ` (${fmt(d.amount, d.currency)})` : ""}`;
      if (!d) return { decision: "approve", reason: "Dispute not in the local view; please confirm.", summary };
      if (d.amount < policy.disputes.autoAcceptUnder) {
        return { decision: "allow", reason: `${fmt(d.amount, d.currency)} is under your ${fmt(policy.disputes.autoAcceptUnder, ccy)} auto-accept limit.`, summary };
      }
      return { decision: "approve", reason: `${fmt(d.amount, d.currency)} is at or above your ${fmt(policy.disputes.autoAcceptUnder, ccy)} auto-accept limit.`, summary };
    }

    case "create_shipment_tracking":
    case "update_shipment_tracking":
      return { decision: "allow", reason: "Adding tracking moves no money and protects you in disputes.", summary: `Add tracking ${String(input.tracking_number ?? "")}` };

    case "create_product":
    case "create_subscription_plan":
    case "create_subscription":
    case "setup_invoice_auto_reminders":
    case "update_invoicing":
    case "create_conditional_rules_for_invoice":
      return { decision: "allow", reason: "Sets up billing; the client still has to approve any charge.", summary: tool.replaceAll("_", " ") };

    case "set_chase_override": {
      return { decision: "allow", reason: "Local setting only.", summary: `Set chasing to ${String(input.override ?? "")}` };
    }

    default:
      return { decision: "approve", reason: `No policy rule for "${tool}"; defaulting to ask.`, summary: tool };
  }
}
