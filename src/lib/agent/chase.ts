import type { ChaseStage, Invoice, Transaction } from "../paypal/types";
import { isOpenInvoice, money } from "../paypal/types";
import type { Policy } from "../policy/schema";
import { payerProfiles, predictInvoice, unknownProfile, type PayerProfile, type RiskBand } from "./payer-history";

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
  /** Payer-history signal behind the stage (see payer-history.ts). */
  risk: RiskBand;
  predicted_pay_date: string;
  /** The effective day thresholds after the history / override shift. */
  thresholds: { friendly: number; firm: number; final: number };
  /** Why this stage now, in one line, citing the numbers; `rule` is the policy field it rests on. */
  why: string;
  rule: string;
}

const ORDER: ChaseStage[] = ["none", "friendly", "firm", "final"];

export function overdueDays(inv: Pick<Invoice, "due_date">, now: Date): number {
  const due = new Date(inv.due_date + "T00:00:00Z").getTime();
  return Math.floor((now.getTime() - due) / 86_400_000);
}

/** Day shift applied to every stage threshold: per-invoice override plus (when the policy says so) the payer's history. */
export function cadenceShift(policy: Policy, override: Invoice["chase_override"] = "default", band: RiskBand = "unknown"): { shift: number; history: number; rule: string } {
  const r = policy.reminders;
  const base = override === "aggressive" ? -Math.min(r.friendlyAfterDays, 2) : override === "gentle" ? 5 : 0;
  const history = r.adaptToHistory ? (band === "late-risk" ? -r.historyShiftDays : band === "reliable" ? r.historyShiftDays : 0) : 0;
  return { shift: base + history, history, rule: history !== 0 ? "reminders.adaptToHistory" : override !== "default" ? "invoice.chase_override" : "reminders" };
}

/** Effective thresholds for an invoice after the shift (friendly never earlier than day 1). */
export function thresholdsFor(policy: Policy, override: Invoice["chase_override"] = "default", band: RiskBand = "unknown") {
  const r = policy.reminders;
  const { shift } = cadenceShift(policy, override, band);
  return { friendly: Math.max(1, r.friendlyAfterDays + shift), firm: Math.max(1, r.firmAfterDays + shift), final: Math.max(1, r.finalAfterDays + shift) };
}

/** Which stage an invoice is due for, given how overdue it is (and, optionally, how its payer usually pays). */
export function stageFor(days: number, policy: Policy, override: Invoice["chase_override"] = "default", band: RiskBand = "unknown"): ChaseStage {
  const t = thresholdsFor(policy, override, band);
  if (days >= t.final) return "final";
  if (days >= t.firm) return "firm";
  if (days >= t.friendly) return "friendly";
  return "none";
}

export function highestStageSent(inv: Pick<Invoice, "reminders">): ChaseStage {
  let best: ChaseStage = "none";
  for (const r of inv.reminders) if (ORDER.indexOf(r.stage) > ORDER.indexOf(best)) best = r.stage;
  return best;
}

/** One line explaining the stage decision with the policy numbers behind it. */
export function explainStage(stage: ChaseStage, days: number, policy: Policy, inv: Pick<Invoice, "chase_override" | "client">, profile: PayerProfile): { why: string; rule: string } {
  const r = policy.reminders;
  const { history, rule } = cadenceShift(policy, inv.chase_override, profile.band);
  const t = thresholdsFor(policy, inv.chase_override, profile.band);
  const base = stage === "final" ? r.finalAfterDays : stage === "firm" ? r.firmAfterDays : r.friendlyAfterDays;
  const eff = stage === "final" ? t.final : stage === "firm" ? t.firm : t.friendly;
  const who = inv.client.business ?? inv.client.email;
  if (stage === "none") return { why: `day ${days}: friendly at day ${t.friendly}`, rule };
  const parts = [`${stage} at day ${days} (threshold ${eff}`];
  if (eff !== base) parts.push(`${history !== 0 ? `${base} ${history < 0 ? "-" : "+"} ${Math.abs(history)}` : `shifted from ${base}`} for ${inv.chase_override !== "default" ? `chasing=${inv.chase_override}` : `a ${profile.band} payer`}`);
  let why = parts.join(", ") + ")";
  if (history !== 0) why += `: ${who} ${profile.basis}`;
  return { why, rule };
}

/** Pure planner: which open invoices should receive which reminder right now. */
export function planCollections(invoices: Invoice[], policy: Policy, now: Date, merchant = "Han", transactions: Transaction[] = []): ChaseProposal[] {
  const out: ChaseProposal[] = [];
  const profiles = payerProfiles(invoices, transactions);
  for (const inv of invoices) {
    if (!isOpenInvoice(inv) || inv.chase_override === "paused") continue;
    const days = overdueDays(inv, now);
    const profile = profiles.get(inv.client.email.toLowerCase()) ?? unknownProfile(inv.client.email);
    const stage = stageFor(days, policy, inv.chase_override, profile.band);
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
      risk: predictInvoice(inv, profile, now).risk,
      predicted_pay_date: predictInvoice(inv, profile, now).predicted_pay_date,
      thresholds: thresholdsFor(policy, inv.chase_override, profile.band),
      ...explainStage(stage, days, policy, inv, profile),
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
