/**
 * Promise to pay: a client says "I'll pay by the 20th"; the agent records it, chasing pauses until then, and a
 * broken promise escalates the next reminder one stage with the promise cited.
 *
 * Pure helpers: a small classifier for pasted client replies (date + amount + intent), and the derived status of a
 * recorded promise (open / kept / broken) so nothing has to be mutated when the client pays or the date passes.
 */
import type { Invoice, PromiseToPay } from "../paypal/types";
import { isOpenInvoice } from "../paypal/types";
import type { Policy } from "../policy/schema";

const DAY = 86_400_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WORD_NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, couple: 2, few: 3 };

const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Resolve a date phrase relative to `now` (UTC). Returns yyyy-mm-dd or undefined. */
export function parsePayBy(text: string, now: Date): string | undefined {
  const t = text.toLowerCase();
  const today = utcDay(now);
  const y = now.getUTCFullYear();
  let m: RegExpMatchArray | null;

  if ((m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : y;
    const ms = Date.UTC(year, Number(m[1]) - 1, Number(m[2]));
    return iso(!m[3] && ms < today - 30 * DAY ? Date.UTC(year + 1, Number(m[1]) - 1, Number(m[2])) : ms);
  }
  const monthDay = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/) ?? t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:,?\s+(\d{4}))?\b/);
  if (monthDay) {
    const monthFirst = MONTHS.includes(monthDay[1]);
    const month = MONTHS.indexOf(monthFirst ? monthDay[1] : monthDay[2]);
    const day = Number(monthFirst ? monthDay[2] : monthDay[1]);
    const year = monthDay[3] ? Number(monthDay[3]) : y;
    let ms = Date.UTC(year, month, day);
    if (!monthDay[3] && ms < today - 30 * DAY) ms = Date.UTC(year + 1, month, day);
    return iso(ms);
  }
  if ((m = t.match(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/))) {
    const day = Number(m[1]);
    let ms = Date.UTC(y, now.getUTCMonth(), day);
    if (ms < today) ms = Date.UTC(y, now.getUTCMonth() + 1, day);
    return iso(ms);
  }
  if (/\btomorrow\b/.test(t)) return iso(today + DAY);
  if (/\btoday\b|\bright now\b|\bthis afternoon\b/.test(t)) return iso(today);
  if ((m = t.match(/\b(?:next\s+|this\s+|on\s+|by\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/))) {
    const target = WEEKDAYS.indexOf(m[1]);
    const delta = (target - now.getUTCDay() + 7) % 7 || 7;
    return iso(today + (t.includes(`next ${m[1]}`) && delta < 7 ? delta + 7 : delta) * DAY);
  }
  if (/\bend of (?:the |this )?month\b|\bmonth[- ]end\b/.test(t)) return iso(Date.UTC(y, now.getUTCMonth() + 1, 0));
  if (/\bend of (?:the |this )?week\b/.test(t)) return iso(today + ((5 - now.getUTCDay() + 7) % 7 || 7) * DAY);
  if (/\bnext week\b/.test(t)) return iso(today + 7 * DAY);
  if (/\bnext month\b/.test(t)) return iso(today + 30 * DAY);
  if ((m = t.match(/\b(?:in|within)\s+(\d+|a|an|one|two|three|four|five|six|seven|ten|a couple of|a few)\s+(day|week|business day|working day)s?\b/))) {
    const n = Number(m[1]) || WORD_NUM[m[1].replace(/^a (couple|few)( of)?$/, "$1")] || 1;
    const days = m[2].startsWith("week") ? n * 7 : m[2].includes("day") && m[2] !== "day" ? Math.ceil(n * 7 / 5) : n;
    return iso(today + days * DAY);
  }
  return undefined;
}

export type ReplyKind = "promise" | "paid-claim" | "dispute" | "unknown";

export interface ReplyClassification {
  kind: ReplyKind;
  /** yyyy-mm-dd when the reply names a date. */
  pay_by?: string;
  /** Amount promised; undefined = the whole balance. */
  amount?: number;
  /** The phrase the decision rests on. */
  evidence: string;
}

/** Classify a pasted client reply. Rule-based on purpose: the result is shown to the user and recorded as data. */
export function classifyReply(text: string, now: Date): ReplyClassification {
  const t = text.toLowerCase();
  const date = parsePayBy(text, now);
  const amountMatch = text.match(/\$\s?([\d,]+(?:\.\d{1,2})?)/) ?? text.match(/\b([\d,]+(?:\.\d{1,2})?)\s?(?:usd|dollars)\b/i);
  const amount = amountMatch ? Number(amountMatch[1].replace(/,/g, "")) : undefined;
  const dispute = t.match(/\b(dispute|disput|chargeback|not (?:happy|satisfied)|refuse|won'?t be paying|will not pay|wrong amount|overcharged|never (?:ordered|received)|didn'?t (?:order|receive))\b/);
  if (dispute) return { kind: "dispute", evidence: dispute[0] };
  const paid = t.match(/\b(already paid|have paid|has been paid|paid (?:it|this|that|you|yesterday|last week|on)|sent (?:the )?(?:payment|money|transfer)|payment (?:was |has been )?(?:sent|made|went out)|transferred)\b/);
  if (paid && !date) return { kind: "paid-claim", amount, evidence: paid[0] };
  const promise = t.match(/\b(will pay|'ll pay|going to pay|can pay|pay (?:it|this|that|you|the (?:rest|balance|remainder|invoice))|payment (?:will|should) (?:go out|be made|be sent|arrive|land)|sending|will send|goes out|settle|wire|transfer|get (?:it|this) paid|pay by|pays on|promised?|should be with you|process(?:ing)? (?:it|this|payment))\b/);
  if (date && (promise || /\bpay/.test(t))) return { kind: "promise", pay_by: date, amount, evidence: `${promise?.[0] ?? "pay"} ... ${date}` };
  if (promise && !date) return { kind: "promise", amount, evidence: `${promise[0]} (no date given)` };
  return { kind: "unknown", pay_by: date, amount, evidence: "" };
}

export type PromiseStatus = "open" | "kept" | "broken";

/** Derived, never stored: a promise is kept when the balance moved by the promised amount (or the invoice closed), broken after pay_by + grace. */
export function promiseStatus(inv: Pick<Invoice, "promise" | "due" | "status">, now: Date, policy: Pick<Policy, "promises">): PromiseStatus | undefined {
  const p = inv.promise;
  if (!p) return undefined;
  if (!isOpenInvoice(inv) || inv.due <= 0) return "kept";
  if (p.amount !== undefined && inv.due <= p.balance_at_record - p.amount + 0.01) return "kept";
  const deadline = utcDay(new Date(p.pay_by + "T00:00:00Z")) + policy.promises.graceDays * DAY;
  return utcDay(now) > deadline ? "broken" : "open";
}

export function describePromise(p: PromiseToPay, status: PromiseStatus): string {
  const amt = p.amount !== undefined ? `$${p.amount.toFixed(2)} ` : "";
  return status === "kept" ? `promise kept (${amt}by ${p.pay_by})` : status === "broken" ? `promise broken: ${amt}by ${p.pay_by}, not received` : `promised ${amt}by ${p.pay_by}`;
}
