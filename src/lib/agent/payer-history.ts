/**
 * Payer history: what each client's own PayPal invoices say about how they pay.
 *
 * Pure functions over the invoices and transactions Chaser already lists (mock or sandbox), used by the
 * cadence planner (adaptive stages), the invoice grid (predicted pay date + risk band) and the agent's
 * lookup_customer tool. The history is PayPal's record (payments.transactions[].payment_date, Transaction Search),
 * never something the model is asked to estimate.
 */
import type { Invoice, Transaction } from "../paypal/types";
import { isOpenInvoice } from "../paypal/types";

export type RiskBand = "reliable" | "typical" | "late-risk" | "unknown";

export interface PayerProfile {
  email: string;
  /** Paid invoices with a known payment date. */
  sample: number;
  /** Payment date minus due date, in days; negative = paid early. */
  median_days_late: number;
  mean_days_late: number;
  /** Share of paid invoices that settled after their due date. */
  late_rate: number;
  /** Payment date minus invoice date, in days. */
  median_days_to_pay: number;
  /** Reminders Chaser had to send per paid invoice. */
  reminders_avg: number;
  band: RiskBand;
  /** One-line basis for the band, quoted in the ledger and the grid tooltip. */
  basis: string;
}

export interface Prediction {
  /** yyyy-mm-dd: due date shifted by the payer's median lateness (the due date itself when there is no history). */
  predicted_pay_date: string;
  /** Days between today and the predicted date; negative when the prediction has already passed. */
  days_until_predicted: number;
  risk: RiskBand;
  basis: string;
}

const DAY = 86_400_000;
const BAND_MIN_SAMPLE = 2;
/** Days past the payer's own predicted date after which an open invoice is treated as late-risk regardless of band. */
export const PAST_PREDICTION_GRACE_DAYS = 7;

const dayOf = (s: string) => Math.floor(new Date(s.length === 10 ? s + "T00:00:00Z" : s).getTime() / DAY);
const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** The date an invoice was settled: the last successful PayPal payment linked to it, else PayPal's paid_at. */
export function payDateFor(inv: Invoice, transactions: Transaction[]): string | undefined {
  const linked = transactions.filter((t) => t.type === "PAYMENT" && t.status === "S" && (t.invoice_id === inv.id || t.allocations?.some((a) => a.invoice_id === inv.id)));
  if (linked.length) return linked.map((t) => t.date).sort().at(-1);
  return inv.paid_at;
}

function isSettled(inv: Invoice): boolean {
  return inv.paid > 0 && !isOpenInvoice(inv) && inv.status !== "DRAFT" && inv.status !== "CANCELLED";
}

export function payerProfiles(invoices: Invoice[], transactions: Transaction[]): Map<string, PayerProfile> {
  const byEmail = new Map<string, Array<{ late: number; toPay: number; reminders: number }>>();
  for (const inv of invoices) {
    if (!isSettled(inv)) continue;
    const paidAt = payDateFor(inv, transactions);
    if (!paidAt) continue;
    const key = inv.client.email.toLowerCase();
    const list = byEmail.get(key) ?? [];
    list.push({ late: dayOf(paidAt) - dayOf(inv.due_date), toPay: dayOf(paidAt) - dayOf(inv.invoice_date), reminders: inv.reminders.length });
    byEmail.set(key, list);
  }
  const out = new Map<string, PayerProfile>();
  for (const [email, obs] of byEmail) {
    const lates = obs.map((o) => o.late);
    const sample = obs.length;
    const med = median(lates);
    const mean = lates.reduce((a, b) => a + b, 0) / sample;
    const lateRate = lates.filter((d) => d > 0).length / sample;
    const reminders = obs.reduce((a, o) => a + o.reminders, 0) / sample;
    let band: RiskBand = "typical";
    if (sample >= BAND_MIN_SAMPLE && lateRate >= 0.5 && med >= 5) band = "late-risk";
    else if (sample >= BAND_MIN_SAMPLE && lateRate <= 0.25 && med <= 0) band = "reliable";
    const lateWord = med > 0 ? `${Math.round(med)} days late` : med < 0 ? `${Math.abs(Math.round(med))} days early` : "on the due date";
    const basis = `${sample} paid invoice${sample === 1 ? "" : "s"}: median ${lateWord}, ${Math.round(lateRate * 100)}% paid late, ${reminders.toFixed(1)} reminders each${sample < BAND_MIN_SAMPLE ? " (too few to band)" : ""}`;
    out.set(email, { email, sample, median_days_late: med, mean_days_late: Math.round(mean * 10) / 10, late_rate: Math.round(lateRate * 100) / 100, median_days_to_pay: median(obs.map((o) => o.toPay)), reminders_avg: Math.round(reminders * 10) / 10, band, basis });
  }
  return out;
}

export function unknownProfile(email: string): PayerProfile {
  return { email, sample: 0, median_days_late: 0, mean_days_late: 0, late_rate: 0, median_days_to_pay: 0, reminders_avg: 0, band: "unknown", basis: "no paid invoices on record" };
}

export function profileFor(email: string, invoices: Invoice[], transactions: Transaction[]): PayerProfile {
  return payerProfiles(invoices, transactions).get(email.toLowerCase()) ?? unknownProfile(email);
}

/** Predicted pay date and risk band for one open invoice, from its payer's profile. */
export function predictInvoice(inv: Pick<Invoice, "due_date" | "client">, profile: PayerProfile, now: Date): Prediction {
  const shift = profile.sample ? Math.round(profile.median_days_late) : 0;
  const predictedDay = dayOf(inv.due_date) + shift;
  const today = Math.floor(now.getTime() / DAY);
  const daysUntil = predictedDay - today;
  let risk = profile.band;
  let basis = profile.sample ? `${profile.basis}; expected ${shift === 0 ? "on the due date" : shift > 0 ? `${shift} days after due` : `${-shift} days before due`}` : "no payment history for this client; prediction = due date";
  if (daysUntil <= -PAST_PREDICTION_GRACE_DAYS && risk !== "late-risk") {
    risk = "late-risk";
    basis += `; ${-daysUntil} days past this client's own pattern`;
  }
  return { predicted_pay_date: new Date(predictedDay * DAY).toISOString().slice(0, 10), days_until_predicted: daysUntil, risk, basis };
}
