import { z } from "zod";

/**
 * The user's chasing policy. "Policy is configuration": the agent may act freely inside these
 * bounds, must ask for approval at the edges, and is denied beyond them.
 */
export const PolicySchema = z.object({
  reminders: z.object({
    friendlyAfterDays: z.number().int().min(0).max(365).default(3),
    firmAfterDays: z.number().int().min(0).max(365).default(10),
    finalAfterDays: z.number().int().min(0).max(365).default(21),
    minDaysBetweenReminders: z.number().int().min(0).max(90).default(3),
    maxReminders: z.number().int().min(0).max(20).default(4),
    /** Shift the cadence by the payer's own PayPal history: habitual late payers get firm/final earlier, reliable payers later. */
    adaptToHistory: z.boolean().default(true),
    /** How many days the stages move for a late-risk (earlier) or reliable (later) payer when adaptToHistory is on. */
    historyShiftDays: z.number().int().min(0).max(30).default(3),
    /** Use PayPal's invoice-viewed signal (detail.viewed_by_recipient): an invoice never opened is re-delivered instead of chased harder. */
    viewedAware: z.boolean().default(true),
    /** Days overdue after which a never-opened invoice gets the unviewed strategy instead of a firm/final reminder. */
    unviewedAfterDays: z.number().int().min(0).max(90).default(5),
    /** resend: re-deliver with a "did this reach you / check the address" note; ignore: chase as if it had been opened. */
    unviewedStrategy: z.enum(["resend", "ignore"]).default("resend"),
  }),
  disputes: z.object({
    /** Disputes strictly under this amount are accepted automatically. */
    autoAcceptUnder: z.number().min(0).default(20),
    /** Evidence packs: "ask" shows the pack as an approval card, "auto" submits without asking, "never" blocks the agent from submitting. */
    submitEvidence: z.enum(["ask", "auto", "never"]).default("ask"),
  }),
  approvals: z.object({
    /** Refunds at or above this amount need a human. */
    refundsOver: z.number().min(0).default(500),
    /** New invoices at or above this amount need a human before sending. */
    invoicesOver: z.number().min(0).default(5000),
    /** Tools that always need a human regardless of amount. */
    alwaysAsk: z.array(z.string()).default(["cancel_sent_invoice", "delete_invoice", "cancel_subscription"]),
    /** Tools the agent may never run. */
    neverAllow: z.array(z.string()).default([]),
  }),
  promises: z.object({
    /** Stop reminders while a recorded promise to pay is open. */
    pauseChasing: z.boolean().default(true),
    /** Days after the promised date before the promise counts as broken. */
    graceDays: z.number().int().min(0).max(30).default(1),
    /** A broken promise moves the next reminder up one stage and cites the promise. */
    brokenEscalates: z.boolean().default(true),
    /** Promises further out than this need your approval to record. */
    maxDays: z.number().int().min(1).max(365).default(30),
  }),
  collections: z.object({
    /** What happens after the final notice, instead of the chase going quiet. */
    afterFinal: z.object({
      /** Days after the final notice before any of this is proposed. */
      waitDays: z.number().int().min(0).max(90).default(7),
      /** Balances strictly under this are proposed for write-off (cancel_sent_invoice; always needs your approval). */
      writeOffUnder: z.number().min(0).default(50),
      /** Discount offered on a replacement invoice; 0 turns settlement offers off. Needs your approval. */
      settlementOfferPercent: z.number().min(0).max(90).default(10),
      /** Settlement is only offered up to this balance; above it the invoice goes straight to hand-off. */
      settlementMaxBalance: z.number().min(0).default(1000),
      /** Hand-off pack (statement + chase history + evidence): "ask" shows it as an approval card, "auto" builds it unattended. */
      handoff: z.enum(["ask", "auto"]).default("ask"),
    }),
  }),
  reconciliation: z.object({
    /** Record exact matches (amount == due, same payer) without asking. */
    autoRecordExactMatches: z.boolean().default(true),
    /** Record partial payments without asking when the payer matches. */
    autoRecordPartials: z.boolean().default(true),
    /** Allowed absolute difference when comparing amounts. */
    amountTolerance: z.number().min(0).default(0.01),
  }),
  currency: z.string().length(3).default("USD"),
});

export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = PolicySchema.parse({
  reminders: {},
  disputes: {},
  approvals: {},
  promises: {},
  collections: { afterFinal: {} },
  reconciliation: {},
});

/** Parse a partial policy (e.g. from the UI) on top of the defaults. */
export function parsePolicy(input: unknown): Policy {
  const partial = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  return PolicySchema.parse({
    reminders: { ...DEFAULT_POLICY.reminders, ...(partial.reminders as object | undefined) },
    disputes: { ...DEFAULT_POLICY.disputes, ...(partial.disputes as object | undefined) },
    approvals: { ...DEFAULT_POLICY.approvals, ...(partial.approvals as object | undefined) },
    promises: { ...DEFAULT_POLICY.promises, ...(partial.promises as object | undefined) },
    collections: { afterFinal: { ...DEFAULT_POLICY.collections.afterFinal, ...((partial.collections as { afterFinal?: object } | undefined)?.afterFinal ?? {}) } },
    reconciliation: { ...DEFAULT_POLICY.reconciliation, ...(partial.reconciliation as object | undefined) },
    currency: partial.currency ?? DEFAULT_POLICY.currency,
  });
}
