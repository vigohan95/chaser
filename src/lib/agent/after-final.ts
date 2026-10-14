/**
 * After the final notice: the policy decides what happens next instead of the chase going quiet.
 *   write_off    small balances (under collections.afterFinal.writeOffUnder): cancel the invoice, needs approval
 *   settlement   a discounted replacement invoice (settlementOfferPercent off), needs approval
 *   handoff      a hand-off pack (statement of account + chase history + evidence) for a collector, lawyer or dispute
 * Pure planner; execution is the resolve_after_final tool, gated by the policy engine.
 */
import type { AfterFinalKind, Invoice } from "../paypal/types";
import { isOpenInvoice, money, round2 } from "../paypal/types";
import type { Policy } from "../policy/schema";
import { highestStageSent, overdueDays } from "./chase";
import { promiseStatus } from "./promise";

export interface AfterFinalProposal {
  invoice_id: string;
  invoice_number: string;
  client: string;
  email: string;
  amount_due: number;
  currency: string;
  overdue_days: number;
  final_sent_at: string;
  days_since_final: number;
  resolution: AfterFinalKind;
  /** Settlement: what the client would pay. */
  offer_amount?: number;
  offer_percent?: number;
  why: string;
  rule: string;
}

export function finalSentAt(inv: Pick<Invoice, "reminders">): string | undefined {
  return inv.reminders.filter((r) => r.stage === "final").map((r) => r.at).sort().at(-1);
}

export function daysSinceFinal(inv: Pick<Invoice, "reminders">, now: Date): number | undefined {
  const at = finalSentAt(inv);
  return at ? Math.floor((now.getTime() - new Date(at).getTime()) / 86_400_000) : undefined;
}

/** The decision for one invoice that is past its final notice (no waiting-period check; see planAfterFinal). */
export function decideAfterFinal(inv: Pick<Invoice, "due">, policy: Policy): { resolution: AfterFinalKind; offer_amount?: number; offer_percent?: number; why: string; rule: string } {
  const af = policy.collections.afterFinal;
  if (inv.due < af.writeOffUnder) {
    return { resolution: "write_off", why: `balance ${money(inv.due)} is under the ${money(af.writeOffUnder)} write-off threshold`, rule: "collections.afterFinal.writeOffUnder" };
  }
  if (af.settlementOfferPercent > 0 && inv.due <= af.settlementMaxBalance) {
    const offer = round2(inv.due * (1 - af.settlementOfferPercent / 100));
    return { resolution: "settlement", offer_amount: offer, offer_percent: af.settlementOfferPercent, why: `balance ${money(inv.due)} is at or under ${money(af.settlementMaxBalance)}, so a ${af.settlementOfferPercent}% settlement (${money(offer)}) is offered before hand-off`, rule: "collections.afterFinal.settlementOfferPercent" };
  }
  return { resolution: "handoff", why: af.settlementOfferPercent > 0 ? `balance ${money(inv.due)} is above the ${money(af.settlementMaxBalance)} settlement ceiling, so it goes to hand-off` : "settlement offers are off, so it goes to hand-off", rule: "collections.afterFinal.handoff" };
}

/** Open invoices whose final notice is at least waitDays old, not paused, not under a promise, not yet resolved. */
export function planAfterFinal(invoices: Invoice[], policy: Policy, now: Date): AfterFinalProposal[] {
  const out: AfterFinalProposal[] = [];
  for (const inv of invoices) {
    if (!isOpenInvoice(inv) || inv.chase_override === "paused" || inv.resolution) continue;
    if (highestStageSent(inv) !== "final") continue;
    const since = daysSinceFinal(inv, now);
    if (since === undefined || since < policy.collections.afterFinal.waitDays) continue;
    if (promiseStatus(inv, now, policy) === "open") continue;
    const d = decideAfterFinal(inv, policy);
    out.push({
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      client: inv.client.business ?? `${inv.client.given_name} ${inv.client.surname}`,
      email: inv.client.email,
      amount_due: inv.due,
      currency: inv.currency,
      overdue_days: overdueDays(inv, now),
      final_sent_at: finalSentAt(inv)!,
      days_since_final: since,
      ...d,
      why: `final notice sent ${since} days ago (wait ${policy.collections.afterFinal.waitDays}); ${d.why}`,
    });
  }
  return out.sort((a, b) => b.amount_due - a.amount_due);
}
