import type { ChaseStage, Invoice, Transaction } from "../paypal/types";
import { isOpenInvoice, money } from "../paypal/types";
import type { Policy } from "../policy/schema";
import { payerProfiles, predictInvoice, unknownProfile, type PayerProfile, type RiskBand } from "./payer-history";
import { promiseStatus } from "./promise";

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
  /** Set when the stage was escalated because a recorded promise to pay was broken. */
  broken_promise?: { pay_by: string; amount?: number };
  /** PayPal's detail.viewed_by_recipient for this invoice (undefined when the source does not carry it). */
  viewed?: boolean;
  /** reminder: the normal stage reminder; resend: the invoice was never opened, so re-deliver it and check the address. */
  channel: "reminder" | "resend";
  /** The policy field behind a non-default channel (reminders.unviewedStrategy); `rule` stays the field behind the stage. */
  channel_rule?: string;
}

/** Should this reminder be a re-delivery instead of a chase? Only when PayPal says the invoice was never opened. */
export function unviewedResend(inv: Pick<Invoice, "viewed_by_recipient">, days: number, policy: Policy): boolean {
  const r = policy.reminders;
  return r.viewedAware && r.unviewedStrategy === "resend" && inv.viewed_by_recipient === false && days >= r.unviewedAfterDays;
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
    const pstatus = promiseStatus(inv, now, policy);
    if (pstatus === "open" && policy.promises.pauseChasing) continue;
    let stage = stageFor(days, policy, inv.chase_override, profile.band);
    const sent = highestStageSent(inv);
    let broken: ChaseProposal["broken_promise"];
    if (pstatus === "broken" && policy.promises.brokenEscalates && inv.promise) {
      // One stage above whatever was sent last, and never below what the calendar says.
      const next = ORDER[Math.min(ORDER.indexOf(sent) + 1, ORDER.length - 1)];
      if (ORDER.indexOf(next) > ORDER.indexOf(stage)) stage = next;
      broken = { pay_by: inv.promise.pay_by, amount: inv.promise.amount };
    }
    if (stage === "none") continue;
    if (ORDER.indexOf(stage) <= ORDER.indexOf(sent)) continue;
    const resend = !broken && unviewedResend(inv, days, policy);
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
      draft: resend ? draftResend(inv, stage, days, merchant) : draftReminder(inv, stage, days, merchant, broken, inv.viewed_by_recipient === true && policy.reminders.viewedAware),
      risk: predictInvoice(inv, profile, now).risk,
      predicted_pay_date: predictInvoice(inv, profile, now).predicted_pay_date,
      thresholds: thresholdsFor(policy, inv.chase_override, profile.band),
      ...(broken
        ? { why: `promise to pay${broken.amount !== undefined ? ` ${money(broken.amount, inv.currency)}` : ""} by ${broken.pay_by} was not kept (grace ${policy.promises.graceDays} day${policy.promises.graceDays === 1 ? "" : "s"}); escalated from ${sent} to ${stage} (promises.brokenEscalates)`, rule: "promises.brokenEscalates" }
        : resend
          ? { why: `${explainStage(stage, days, policy, inv, profile).why}; PayPal shows the invoice was never opened (viewed_by_recipient = false) after ${days} days, so it is re-delivered with an address check instead of a ${stage} reminder (reminders.unviewedStrategy = resend)`, rule: explainStage(stage, days, policy, inv, profile).rule }
          : explainStage(stage, days, policy, inv, profile)),
      broken_promise: broken,
      viewed: inv.viewed_by_recipient,
      channel: resend ? "resend" : "reminder",
      channel_rule: resend ? "reminders.unviewedStrategy" : undefined,
    });
  }
  return out.sort((a, b) => b.overdue_days - a.overdue_days);
}

/** Template reminder used by the mock planner and offered to the LLM as a starting point. */
/**
 * Re-delivery for an invoice PayPal says was never opened: same stage words in the subject (so the reminder count and
 * stage inference still apply), but the body asks whether it reached the right person instead of pressing harder.
 */
export function draftResend(inv: Invoice, stage: Exclude<ChaseStage, "none">, days: number, merchant: string): { subject: string; note: string } {
  const first = inv.client.given_name;
  const amt = money(inv.due, inv.currency);
  const work = inv.items.map((i) => i.name).join(", ");
  const pay = inv.links.pay ? `\n\nPay securely here: ${inv.links.pay}` : "";
  const head = stage === "final" ? `Final notice (resent)` : stage === "firm" ? `Resending: ${days} days overdue` : `Resending`;
  return {
    subject: `${head}: invoice ${inv.invoice_number} (${amt}) - did this reach you?`,
    note: `Hi ${first},\n\nI am resending invoice ${inv.invoice_number} for ${amt} (${work}), due ${inv.due_date} and now ${days} days past due. PayPal shows it has not been opened yet, so I want to make sure it reached the right person: if ${inv.client.email} is not the best address for invoices, reply with the right contact and I will send it there (a QR code for the payment page is available too).${stage === "final" ? " If it has simply been missed, this is the final reminder before I pause further work as per our agreement." : ""}${pay}\n\nThanks,\n${merchant}`,
  };
}

export function draftReminder(inv: Invoice, stage: Exclude<ChaseStage, "none">, days: number, merchant: string, broken?: { pay_by: string; amount?: number }, viewed = false): { subject: string; note: string } {
  const first = inv.client.given_name;
  const amt = money(inv.due, inv.currency);
  const work = inv.items.map((i) => i.name).join(", ");
  const pay = inv.links.pay ? `\n\nPay securely here: ${inv.links.pay}` : "";
  const seen = viewed ? " PayPal shows the invoice has been opened, so I know it reached you." : "";
  if (broken) {
    const promised = broken.amount !== undefined ? money(broken.amount, inv.currency) : "payment";
    const tone = stage === "final" ? `This is now a final notice: if the balance is not settled within 5 business days I will have to pause further work and apply the late fee in our agreement.` : `Could you let me know today when it will go out, or whether anything is blocking it?`;
    return {
      subject: `${stage === "final" ? "Final notice" : "Overdue"}: invoice ${inv.invoice_number} - ${amt}, promised by ${broken.pay_by}`,
      note: `Hi ${first},\n\nYou let me know that ${promised} for invoice ${inv.invoice_number} (${work}) would be made by ${broken.pay_by}. It has not arrived, and the invoice is now ${days} days past its ${inv.due_date} due date with ${amt} outstanding. ${tone}${pay}\n\nRegards,\n${merchant}`,
    };
  }
  switch (stage) {
    case "friendly":
      return {
        subject: `Quick nudge: invoice ${inv.invoice_number} (${amt})`,
        note: `Hi ${first},\n\nHope the ${work} is working out well. Invoice ${inv.invoice_number} for ${amt} was due on ${inv.due_date} - this may have slipped through, so here is the link again.${pay}\n\nThanks,\n${merchant}`,
      };
    case "firm":
      return {
        subject: `Overdue: invoice ${inv.invoice_number} - ${amt}, ${days} days past due`,
        note: `Hi ${first},\n\nInvoice ${inv.invoice_number} (${work}) for ${amt} is now ${days} days past its ${inv.due_date} due date.${seen} Could you let me know when payment will be made, or if anything is blocking it on your side?${pay}\n\nBest,\n${merchant}`,
      };
    case "final":
      return {
        subject: `Final notice: invoice ${inv.invoice_number} - ${amt}`,
        note: `Hi ${first},\n\nThis is a final reminder for invoice ${inv.invoice_number} (${work}), ${amt}, now ${days} days overdue.${seen} If I do not hear back within 5 business days I will have to pause further work and apply the late fee in our agreement. I would much rather sort this out - reply here or pay via the link.${pay}\n\nRegards,\n${merchant}`,
      };
  }
}
