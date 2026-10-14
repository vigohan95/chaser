/**
 * Statement of account (per client) and the hand-off pack (per invoice), as Markdown. Pure functions over what Chaser
 * already knows: invoices and line items, payments, reminders with their subjects, promises, PayPal's viewed flag and
 * the payer's history. The same text is shown on the approval card, downloaded from the UI and returned by the tools.
 */
import type { Invoice, Transaction } from "../paypal/types";
import { isOpenInvoice, money, round2 } from "../paypal/types";
import type { Policy } from "../policy/schema";
import { overdueDays } from "./chase";
import { payDateFor, profileFor } from "./payer-history";
import { describePromise, promiseStatus } from "./promise";

export interface StatementContext {
  invoices: Invoice[];
  transactions: Transaction[];
  now: Date;
  merchant: { businessName: string; givenName: string; surname: string; email: string };
  policy: Policy;
}

export type AgingBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";

export function agingBucket(days: number): AgingBucket {
  return days <= 0 ? "current" : days <= 30 ? "1-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+";
}

export interface Statement {
  client: { business?: string; name: string; email: string };
  open_invoices: number;
  total_open: number;
  total_overdue: number;
  buckets: Record<AgingBucket, number>;
  markdown: string;
}

const d = (iso: string | undefined) => (iso ? iso.slice(0, 10) : "");

export function buildStatement(email: string, ctx: StatementContext): Statement | undefined {
  const mine = ctx.invoices.filter((i) => i.client.email.toLowerCase() === email.toLowerCase() && i.status !== "DRAFT" && i.status !== "CANCELLED");
  if (!mine.length) return undefined;
  const c = mine[0].client;
  const open = mine.filter(isOpenInvoice).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const paid = mine.filter((i) => !isOpenInvoice(i)).sort((a, b) => b.invoice_date.localeCompare(a.invoice_date)).slice(0, 10);
  const buckets: Record<AgingBucket, number> = { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  for (const i of open) buckets[agingBucket(overdueDays(i, ctx.now))] = round2(buckets[agingBucket(overdueDays(i, ctx.now))] + i.due);
  const totalOpen = round2(open.reduce((a, i) => a + i.due, 0));
  const totalOverdue = round2(open.filter((i) => overdueDays(i, ctx.now) > 0).reduce((a, i) => a + i.due, 0));
  const profile = profileFor(email, ctx.invoices, ctx.transactions);
  const ccy = open[0]?.currency ?? mine[0].currency;
  const lines: string[] = [];
  lines.push(`# Statement of account - ${c.business ?? `${c.given_name} ${c.surname}`}`);
  lines.push(``);
  lines.push(`From ${ctx.merchant.businessName} (${ctx.merchant.givenName} ${ctx.merchant.surname}, ${ctx.merchant.email}) to ${c.given_name} ${c.surname} <${c.email}>. As of ${d(ctx.now.toISOString())}. Amounts in ${ccy}.`);
  lines.push(``);
  lines.push(`**Balance due: ${money(totalOpen, ccy)}** across ${open.length} open invoice${open.length === 1 ? "" : "s"}; ${money(totalOverdue, ccy)} of it is past due.`);
  lines.push(``);
  lines.push(`| Aging | current | 1-30 days | 31-60 | 61-90 | 90+ |`);
  lines.push(`|---|---:|---:|---:|---:|---:|`);
  lines.push(`| Amount | ${money(buckets.current, ccy)} | ${money(buckets["1-30"], ccy)} | ${money(buckets["31-60"], ccy)} | ${money(buckets["61-90"], ccy)} | ${money(buckets["90+"], ccy)} |`);
  lines.push(``);
  lines.push(`## Open invoices`);
  lines.push(``);
  if (!open.length) lines.push(`None. Thank you.`);
  else {
    lines.push(`| Invoice | Issued | Due | Days | Work | Total | Paid | Balance | Status | Pay |`);
    lines.push(`|---|---|---|---:|---|---:|---:|---:|---|---|`);
    for (const i of open) {
      const days = overdueDays(i, ctx.now);
      const extras = [i.promise && promiseStatus(i, ctx.now, ctx.policy) ? describePromise(i.promise, promiseStatus(i, ctx.now, ctx.policy)!) : "", i.reminders.length ? `${i.reminders.length} reminder${i.reminders.length === 1 ? "" : "s"}` : ""].filter(Boolean).join("; ");
      lines.push(`| ${i.invoice_number} | ${i.invoice_date} | ${i.due_date} | ${days > 0 ? `${days} overdue` : `due in ${-days}`} | ${i.items.map((x) => x.name).join(", ")} | ${money(i.total, i.currency)} | ${money(i.paid, i.currency)} | **${money(i.due, i.currency)}** | ${i.status.replaceAll("_", " ").toLowerCase()}${extras ? ` (${extras})` : ""} | ${i.links.pay ? `[pay](${i.links.pay})` : ""} |`);
    }
    lines.push(``);
    lines.push(`One payment of **${money(totalOpen, ccy)}** settles everything above; any invoice can also be paid on its own link.`);
  }
  lines.push(``);
  lines.push(`## Recently settled`);
  lines.push(``);
  if (!paid.length) lines.push(`No settled invoices on record.`);
  else {
    lines.push(`| Invoice | Issued | Due | Paid on | Total | Status |`);
    lines.push(`|---|---|---|---|---:|---|`);
    for (const i of paid) lines.push(`| ${i.invoice_number} | ${i.invoice_date} | ${i.due_date} | ${d(payDateFor(i, ctx.transactions)) || "-"} | ${money(i.total, i.currency)} | ${i.status.replaceAll("_", " ").toLowerCase()} |`);
  }
  lines.push(``);
  lines.push(`Payment record: ${profile.basis}.`);
  lines.push(``);
  lines.push(`_Generated by Chaser from PayPal invoice and payment records. Questions: ${ctx.merchant.email}._`);
  return { client: { business: c.business, name: `${c.given_name} ${c.surname}`, email: c.email }, open_invoices: open.length, total_open: totalOpen, total_overdue: totalOverdue, buckets, markdown: lines.join("\n") };
}

/** Everything a collector, a lawyer or a PayPal dispute case needs about one invoice, plus the client's statement. */
export function buildHandoffPack(inv: Invoice, ctx: StatementContext): string {
  const days = overdueDays(inv, ctx.now);
  const payments = ctx.transactions.filter((t) => t.type === "PAYMENT" && t.status === "S" && (t.invoice_id === inv.id || t.allocations?.some((a) => a.invoice_id === inv.id)));
  const profile = profileFor(inv.client.email, ctx.invoices, ctx.transactions);
  const ps = promiseStatus(inv, ctx.now, ctx.policy);
  const lines: string[] = [];
  lines.push(`# Hand-off pack - invoice ${inv.invoice_number} (${money(inv.due, inv.currency)} outstanding)`);
  lines.push(``);
  lines.push(`Prepared ${d(ctx.now.toISOString())} by Chaser for ${ctx.merchant.businessName}. Debtor: ${inv.client.business ?? ""} ${inv.client.given_name} ${inv.client.surname} <${inv.client.email}>. PayPal invoice id \`${inv.id}\`${inv.links.view ? ` ([view](${inv.links.view}))` : ""}.`);
  lines.push(``);
  lines.push(`## 1. The debt`);
  lines.push(``);
  lines.push(`- Invoice ${inv.invoice_number} issued ${inv.invoice_date}, due ${inv.due_date}, now **${days} days past due**; status ${inv.status.replaceAll("_", " ").toLowerCase()}.`);
  lines.push(`- Total ${money(inv.total, inv.currency)}, paid ${money(inv.paid, inv.currency)}, refunded ${money(inv.refunded, inv.currency)}, **balance ${money(inv.due, inv.currency)}**.${inv.reference ? ` Reference: ${inv.reference}.` : ""}`);
  lines.push(`- Work invoiced: ${inv.items.map((i) => `${i.quantity} x ${i.name}${i.description ? ` (${i.description})` : ""} at ${money(i.unit_amount, inv.currency)}`).join("; ")}.`);
  if (inv.note) lines.push(`- Terms on the invoice: ${inv.note}`);
  lines.push(``);
  lines.push(`## 2. Payments received`);
  lines.push(``);
  if (!payments.length) lines.push(`None against this invoice.`);
  else for (const t of payments) lines.push(`- ${d(t.date)}: ${money(t.amount, t.currency)} (PayPal transaction ${t.id}${t.memo ? `, memo "${t.memo}"` : ""})${t.allocations?.length ? `, of which ${money(t.allocations.find((a) => a.invoice_id === inv.id)?.amount ?? 0, t.currency)} applied here` : ""}`);
  lines.push(``);
  lines.push(`## 3. Chase history`);
  lines.push(``);
  if (!inv.reminders.length) lines.push(`No reminders sent.`);
  else for (const r of inv.reminders) lines.push(`- ${d(r.at)}: ${r.stage} reminder sent through PayPal${r.subject ? ` - "${r.subject}"` : ""}`);
  if (inv.promise && ps) lines.push(`- ${d(inv.promise.recorded_at)}: client ${describePromise(inv.promise, ps)}${inv.promise.quote ? ` - "${inv.promise.quote}"` : ""} (status: ${ps})`);
  if (inv.viewed_by_recipient !== undefined) lines.push(`- PayPal invoice-viewed flag: ${inv.viewed_by_recipient ? "the recipient opened the invoice" : "never opened by the recipient"}.`);
  lines.push(`- Payer record across all their invoices: ${profile.basis}.`);
  lines.push(``);
  lines.push(`## 4. Evidence available`);
  lines.push(``);
  lines.push(`- PayPal invoice ${inv.id} (line items, dates, recipient) and its send / reminder log.`);
  lines.push(`- Payment records above (PayPal transaction ids).`);
  lines.push(`- To attach by hand: the signed proposal or contract, delivery confirmation / final files, written approvals and correspondence.`);
  lines.push(``);
  lines.push(`## 5. Suggested next steps`);
  lines.push(``);
  lines.push(`1. Send the statement of account below with a 7-day deadline and the single pay link.`);
  lines.push(`2. If unpaid, pass this pack to a collections agency or file a small-claims / money claim with the invoice, the chase log and the payment record.`);
  lines.push(`3. Keep the PayPal invoice open until the matter is closed (cancelling it removes the pay link).`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  const st = buildStatement(inv.client.email, ctx);
  if (st) lines.push(st.markdown.replace(/^# /, "## Appendix: "));
  return lines.join("\n");
}
