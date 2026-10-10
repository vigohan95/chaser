import type { ChaseStage, Invoice } from "../paypal/types";
import { isOpenInvoice, money } from "../paypal/types";
import type { Policy } from "../policy/schema";

export interface ChaseProposal {
  invoice_id: string;
  invoice_number: string;
  client: string;
  email: string;
  amount_due: number;
  currency: string;
  overdue_days: number;
  stage: Exclude<ChaseStage, "none">;
  reminders_sent: number;
  last_reminder_at?: string;
  pay_link?: string;
  items: string;
  draft: { subject: string; note: string };
}

const ORDER: ChaseStage[] = ["none", "friendly", "firm", "final"];

export function overdueDays(inv: Pick<Invoice, "due_date">, now: Date): number {
  const due = new Date(inv.due_date + "T00:00:00Z").getTime();
  return Math.floor((now.getTime() - due) / 86_400_000);
}

/** Which stage an invoice is due for, given how overdue it is. */
export function stageFor(days: number, policy: Policy, override: Invoice["chase_override"] = "default"): ChaseStage {
  const r = policy.reminders;
  const shift = override === "aggressive" ? -Math.min(r.friendlyAfterDays, 2) : override === "gentle" ? 5 : 0;
  if (days >= r.finalAfterDays + shift) return "final";
  if (days >= r.firmAfterDays + shift) return "firm";
  if (days >= r.friendlyAfterDays + shift) return "friendly";
  return "none";
}

export function highestStageSent(inv: Pick<Invoice, "reminders">): ChaseStage {
  let best: ChaseStage = "none";
  for (const r of inv.reminders) if (ORDER.indexOf(r.stage) > ORDER.indexOf(best)) best = r.stage;
  return best;
}

/** Pure planner: which open invoices should receive which reminder right now. */
export function planCollections(invoices: Invoice[], policy: Policy, now: Date, merchant = "Han"): ChaseProposal[] {
  const out: ChaseProposal[] = [];
  for (const inv of invoices) {
    if (!isOpenInvoice(inv) || inv.chase_override === "paused") continue;
    const days = overdueDays(inv, now);
    const stage = stageFor(days, policy, inv.chase_override);
    if (stage === "none") continue;
    if (ORDER.indexOf(stage) <= ORDER.indexOf(highestStageSent(inv))) continue;
    if (inv.reminders.length >= policy.reminders.maxReminders) continue;
    const last = inv.reminders.at(-1);
    if (last && (now.getTime() - new Date(last.at).getTime()) / 86_400_000 < policy.reminders.minDaysBetweenReminders) continue;
    out.push({
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      client: inv.client.business ?? `${inv.client.given_name} ${inv.client.surname}`,
      email: inv.client.email,
      amount_due: inv.due,
      currency: inv.currency,
      overdue_days: days,
      stage,
      reminders_sent: inv.reminders.length,
      last_reminder_at: last?.at,
      pay_link: inv.links.pay,
      items: inv.items.map((i) => i.name).join(", "),
      draft: draftReminder(inv, stage, days, merchant),
    });
  }
  return out.sort((a, b) => b.overdue_days - a.overdue_days);
}

/** Template reminder used by the mock planner and offered to the LLM as a starting point. */
export function draftReminder(inv: Invoice, stage: Exclude<ChaseStage, "none">, days: number, merchant: string): { subject: string; note: string } {
  const first = inv.client.given_name;
  const amt = money(inv.due, inv.currency);
  const work = inv.items.map((i) => i.name).join(", ");
  const pay = inv.links.pay ? `\n\nPay securely here: ${inv.links.pay}` : "";
  switch (stage) {
    case "friendly":
      return {
        subject: `Quick nudge: invoice ${inv.invoice_number} (${amt})`,
        note: `Hi ${first},\n\nHope the ${work} is working out well. Invoice ${inv.invoice_number} for ${amt} was due on ${inv.due_date} - this may have slipped through, so here is the link again.${pay}\n\nThanks,\n${merchant}`,
      };
    case "firm":
      return {
        subject: `Overdue: invoice ${inv.invoice_number} - ${amt}, ${days} days past due`,
        note: `Hi ${first},\n\nInvoice ${inv.invoice_number} (${work}) for ${amt} is now ${days} days past its ${inv.due_date} due date. Could you let me know when payment will be made, or if anything is blocking it on your side?${pay}\n\nBest,\n${merchant}`,
      };
    case "final":
      return {
        subject: `Final notice: invoice ${inv.invoice_number} - ${amt}`,
        note: `Hi ${first},\n\nThis is a final reminder for invoice ${inv.invoice_number} (${work}), ${amt}, now ${days} days overdue. If I do not hear back within 5 business days I will have to pause further work and apply the late fee in our agreement. I would much rather sort this out - reply here or pay via the link.${pay}\n\nRegards,\n${merchant}`,
      };
  }
}
