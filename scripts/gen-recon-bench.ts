/*
 * Build the labelled reconciliation fixture: `npx tsx scripts/gen-recon-bench.ts` -> tests/fixtures/recon-bench.json
 *
 * Deterministic (fixed `now`, ids derived from the scenario name) so the labels are reviewable in a diff. Every
 * transaction carries the rule and allocation set a correct matcher should produce; the scorer in
 * src/lib/agent/recon-bench.ts turns that into precision / recall per rule.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BenchFile, BenchLabel, BenchRule } from "../src/lib/agent/recon-bench";
import { txnId } from "../src/lib/paypal/fixtures";
import type { Client, Invoice, Transaction } from "../src/lib/paypal/types";
import { round2 } from "../src/lib/paypal/types";

const NOW = new Date("2026-10-13T12:00:00Z");
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();
const day = (daysAgo: number) => iso(daysAgo).slice(0, 10);

const C: Record<string, Client> = {
  alder: { business: "Alder & Co", given_name: "Mia", surname: "Alder", email: "ap@alder.example" },
  birch: { business: "Birch Media", given_name: "Noah", surname: "Birch", email: "noah@birchmedia.example" },
  cedar: { business: "Cedar Dental", given_name: "Ava", surname: "Cedar", email: "office@cedardental.example" },
  dune: { business: "Dune Outfitters", given_name: "Leo", surname: "Dune", email: "finance@dune.example" },
  elm: { business: "Elm Street Cafe", given_name: "Zoe", surname: "Elm", email: "zoe@elmcafe.example" },
  fern: { business: "Fern Architects", given_name: "Ian", surname: "Fern", email: "accounts@fern.example" },
  grove: { business: "Grove Fitness", given_name: "Eli", surname: "Grove", email: "eli@grovefit.example" },
  hazel: { business: "Hazel Legal LLP", given_name: "Ada", surname: "Hazel", email: "billing@hazellegal.example" },
  iris: { business: "Iris Florals", given_name: "Kai", surname: "Iris", email: "kai@irisflorals.example" },
  juno: { business: "Juno Robotics", given_name: "Sam", surname: "Juno", email: "ap@junorobotics.example" },
  kestrel: { business: "Kestrel GmbH", given_name: "Lena", surname: "Kestrel", email: "buchhaltung@kestrel.example" },
  lark: { business: "Lark Studio", given_name: "Rae", surname: "Lark", email: "rae@larkstudio.example" },
};

const invoices: Invoice[] = [];
let seq = 0;
function inv(client: keyof typeof C, total: number, opts: { dueDaysAgo: number; status?: Invoice["status"]; paid?: number; currency?: string; name?: string } ): Invoice {
  seq += 1;
  const number = `B-${String(seq).padStart(4, "0")}`;
  const paid = opts.paid ?? (opts.status === "PAID" ? total : 0);
  const status = opts.status ?? (paid >= total ? "PAID" : paid > 0 ? "PARTIALLY_PAID" : "UNPAID");
  const i: Invoice = {
    id: `INV2-BENCH-${number}`,
    invoice_number: number,
    status,
    client: C[client],
    items: [{ name: opts.name ?? `Work item ${number}`, quantity: 1, unit_amount: total }],
    currency: opts.currency ?? "USD",
    total,
    paid,
    refunded: 0,
    due: round2(Math.max(0, total - paid)),
    invoice_date: day(opts.dueDaysAgo + 15),
    due_date: day(opts.dueDaysAgo),
    paid_at: status === "PAID" ? day(Math.max(0, opts.dueDaysAgo - 2)) : undefined,
    reminders: [],
    chase_override: "default",
    links: {},
  };
  invoices.push(i);
  return i;
}

/** The digits of an invoice number, for memos written the way clients write them ("inv 0002"). */
const digits = (i: Invoice) => i.invoice_number.replace(/^\D+/, "");

const transactions: Transaction[] = [];
const labels: BenchLabel[] = [];
function pay(scenario: string, name: string, client: Client | { email: string; name: string }, amount: number, opts: { daysAgo?: number; memo?: string; fee?: number; currency?: string; invoice_id?: string; type?: Transaction["type"] }, rule: BenchRule, allocations: Array<[Invoice, number]>, note?: string) {
  const id = txnId(`bench-${name}`);
  const email = "email" in client ? client.email : undefined;
  const payerName = "given_name" in client ? `${client.given_name} ${client.surname}` : (client as { name: string }).name;
  transactions.push({ id, date: iso(opts.daysAgo ?? 2), type: opts.type ?? "PAYMENT", amount, fee: opts.fee ?? 0, currency: opts.currency ?? "USD", status: "S", payer_email: email, payer_name: payerName, memo: opts.memo, invoice_id: opts.invoice_id });
  labels.push({ transaction_id: id, scenario, rule, allocations: allocations.map(([i, a]) => ({ invoice_number: i.invoice_number, amount: round2(a) })), note });
  return id;
}

/* ---------------- invoices ---------------- */
// Alder: three open, one paid
const a1 = inv("alder", 1200, { dueDaysAgo: 20 });
const a2 = inv("alder", 450, { dueDaysAgo: 12 });
const a3 = inv("alder", 2750, { dueDaysAgo: 5 });
const a4 = inv("alder", 800, { dueDaysAgo: 40, status: "PAID" });
// Birch: open invoices of different sizes (combined / partial)
const b1 = inv("birch", 600, { dueDaysAgo: 30 });
const b2 = inv("birch", 900, { dueDaysAgo: 18 });
const b3 = inv("birch", 1500, { dueDaysAgo: 9 });
inv("birch", 320, { dueDaysAgo: 2 });
// Cedar: two invoices with the same balance (ambiguous) + one odd one
const c1 = inv("cedar", 750, { dueDaysAgo: 25 });
inv("cedar", 750, { dueDaysAgo: 6 });
const c3 = inv("cedar", 1310.5, { dueDaysAgo: 3 });
// Dune: net-of-fee payers
const d1 = inv("dune", 1000, { dueDaysAgo: 10 });
const d2 = inv("dune", 2400, { dueDaysAgo: 4 });
inv("dune", 199, { dueDaysAgo: 1 });
// Elm: partially paid + paid (refund target)
const e1 = inv("elm", 1800, { dueDaysAgo: 15, paid: 800 });
const e2 = inv("elm", 540, { dueDaysAgo: 35, status: "PAID" });
const e3 = inv("elm", 260, { dueDaysAgo: 0 });
// Fern: large single open invoice + two paid
const f1 = inv("fern", 6400, { dueDaysAgo: 8 });
inv("fern", 1250, { dueDaysAgo: 60, status: "PAID" });
const f3 = inv("fern", 980, { dueDaysAgo: 45, status: "PAID" });
// Grove: combos that are ambiguous (300+500 = 800 = 350+450)
const g1 = inv("grove", 300, { dueDaysAgo: 22 });
const g2 = inv("grove", 500, { dueDaysAgo: 20 });
inv("grove", 350, { dueDaysAgo: 14 });
const g4 = inv("grove", 450, { dueDaysAgo: 7 });
// Hazel: USD; Kestrel: EUR only (currency scenario)
const h2 = inv("hazel", 3000, { dueDaysAgo: 3 });
const k1 = inv("kestrel", 2000, { dueDaysAgo: 11, currency: "EUR" });
// Iris: small invoices (duplicates, overpayment)
inv("iris", 120, { dueDaysAgo: 16 });
inv("iris", 85, { dueDaysAgo: 9 });
const i3 = inv("iris", 120, { dueDaysAgo: 50, status: "PAID" });
// Juno: nothing open, one paid (off-invoice / refund)
const j1 = inv("juno", 4200, { dueDaysAgo: 70, status: "PAID" });
inv("juno", 1500, { dueDaysAgo: 100, status: "PAID" });

/* ---------------- transactions ---------------- */
// memo_exact (8): clean and typo'd memos, same payer, amount = balance
pay("memo_exact", "me1", C.alder, 1200, { memo: a1.invoice_number }, "memo_exact", [[a1, 1200]]);
pay("memo_exact", "me2", C.alder, 450, { memo: `Payment for inv ${digits(a2)}, thanks` }, "memo_exact", [[a2, 450]]);
pay("memo_exact", "me3", C.birch, 900, { memo: `Invoice #${b2.invoice_number}` }, "memo_exact", [[b2, 900]]);
pay("memo_exact", "me4", C.cedar, 1310.5, { memo: `inv${digits(c3)} settled` }, "memo_exact", [[c3, 1310.5]]);
pay("memo_exact", "me5", C.dune, 2400, { memo: `INVOICE ${d2.invoice_number} - dune outfitters` }, "memo_exact", [[d2, 2400]]);
pay("memo_exact", "me6", C.elm, 260, { memo: `Inv. ${digits(e3)} coffee cart graphics` }, "memo_exact", [[e3, 260]]);
pay("memo_exact", "me7", C.hazel, 3000, { memo: `Inv #${digits(h2)}` }, "memo_exact", [[h2, 3000]]);
pay("memo_exact", "me8", C.cedar, 750, { memo: `inv-${digits(c1)} (older one)` }, "memo_exact", [[c1, 750]], "memo disambiguates two equal balances");

// memo_other_payer (3): invoice named, paid from another email
pay("memo_other_payer", "mo1", { email: "mia.alder@gmail.example", name: "Mia Alder" }, 2750, { memo: `${a3.invoice_number} paying from personal account` }, "memo_other_payer", [[a3, 2750]]);
pay("memo_other_payer", "mo2", { email: "parent@birchholdings.example", name: "Birch Holdings" }, 1500, { memo: `invoice ${b3.invoice_number} on behalf of Birch Media` }, "memo_other_payer", [[b3, 1500]]);
pay("memo_other_payer", "mo3", { email: "eli.grove@icloud.example", name: "Eli Grove" }, 450, { memo: `INV ${digits(g4)}` }, "memo_other_payer", [[g4, 450]]);

// partial_memo (4)
pay("partial_memo", "pm1", C.fern, 2000, { memo: `${f1.invoice_number} first instalment` }, "partial_memo", [[f1, 2000]]);
pay("partial_memo", "pm2", C.fern, 2000, { memo: `${f1.invoice_number} second instalment`, daysAgo: 1 }, "partial_memo", [[f1, 2000]], "same amount within 3 days, but the memo names the invoice");
pay("partial_memo", "pm3", C.elm, 500, { memo: `inv ${digits(e1)} - part` }, "partial_memo", [[e1, 500]]);
pay("partial_memo", "pm4", C.birch, 100, { memo: `Invoice ${b1.invoice_number} deposit` }, "partial_memo", [[b1, 100]]);

// payer_exact (10): fresh invoices so earlier scenarios do not claim them
const pe: Array<[keyof typeof C, number]> = [["alder", 333], ["birch", 2222], ["dune", 1775], ["elm", 640], ["fern", 410], ["grove", 905], ["hazel", 5200], ["iris", 61.5], ["cedar", 1998.99], ["juno", 870]];
void h2;
pe.forEach(([client, amount], k) => {
  const i = inv(client, amount, { dueDaysAgo: 4 + k });
  pay("payer_exact", `pe${k + 1}`, C[client], amount, { memo: k % 3 === 0 ? undefined : "thanks" }, "payer_exact", [[i, amount]]);
});

// fee_adjusted (6): net of 2.9% + 0.30, 3.49% + 0.49, and with the transaction's own fee field
const fa = [
  { client: "dune", gross: 1000, net: round2(1000 - (1000 * 0.029 + 0.3)) },
  { client: "alder", gross: 2300, net: round2(2300 - (2300 * 0.0349 + 0.49)) },
  { client: "birch", gross: 4000, net: round2(4000 - (4000 * 0.032 + 0.4)) },
  { client: "elm", gross: 150, net: round2(150 - (150 * 0.029 + 0.3)) },
  { client: "grove", gross: 999.99, net: round2(999.99 - (999.99 * 0.0349 + 0.49)) },
  { client: "hazel", gross: 12000, net: round2(12000 - (12000 * 0.029 + 0.3)) },
] as const;
fa.forEach((f, k) => {
  const i = k === 0 ? d1 : inv(f.client, f.gross, { dueDaysAgo: 6 + k });
  pay("fee_adjusted", `fa${k + 1}`, C[f.client], f.net, { fee: k === 2 ? round2(f.gross - f.net) : 0, memo: k === 1 ? "net of fees" : undefined }, "fee_adjusted", [[i, f.net]]);
});

// combined (6)
const cb1 = inv("juno", 700, { dueDaysAgo: 14 });
const cb2 = inv("juno", 1100, { dueDaysAgo: 12 });
pay("combined", "cb1", C.juno, 1800, { memo: "two invoices" }, "combined", [[cb1, 700], [cb2, 1100]]);
const cb3 = inv("iris", 40, { dueDaysAgo: 30 });
const cb4 = inv("iris", 55, { dueDaysAgo: 28 });
const cb5 = inv("iris", 77, { dueDaysAgo: 26 });
pay("combined", "cb2", C.iris, 172, {}, "combined", [[cb3, 40], [cb4, 55], [cb5, 77]]);
const cb6 = inv("cedar", 2100, { dueDaysAgo: 13 });
const cb7 = inv("cedar", 3300, { dueDaysAgo: 2 });
pay("combined", "cb3", C.cedar, 5400, { memo: "Oct + Nov" }, "combined", [[cb6, 2100], [cb7, 3300]]);
const cb8 = inv("fern", 150, { dueDaysAgo: 21 });
const cb9 = inv("fern", 275, { dueDaysAgo: 19 });
pay("combined", "cb4", C.fern, 425, {}, "combined", [[cb8, 150], [cb9, 275]]);
const cb10 = inv("hazel", 800, { dueDaysAgo: 9 });
const cb11 = inv("hazel", 1200, { dueDaysAgo: 8 });
const cb12 = inv("hazel", 1600, { dueDaysAgo: 7 });
pay("combined", "cb5", C.hazel, 3600, {}, "combined", [[cb10, 800], [cb11, 1200], [cb12, 1600]]);
const cb13 = inv("alder", 2050, { dueDaysAgo: 3 });
const cb14 = inv("alder", 1950, { dueDaysAgo: 1 });
pay("combined", "cb6", C.alder, 4000, { memo: "both" }, "combined", [[cb13, 2050], [cb14, 1950]]);

// partial (6): no memo, less than the oldest open balance
const pa1 = inv("dune", 5000, { dueDaysAgo: 17 });
pay("partial", "pa1", C.dune, 1250, {}, "partial", [[pa1, 1250]]);
const pa2 = inv("juno", 3100, { dueDaysAgo: 24 });
pay("partial", "pa2", C.juno, 600, { memo: "part payment" }, "partial", [[pa2, 600]]);
const pa3 = inv("elm", 2200, { dueDaysAgo: 19 });
pay("partial", "pa3", C.elm, 1100, {}, "partial", [[pa3, 1100]]);
const pa4 = inv("birch", 7600, { dueDaysAgo: 33 });
pay("partial", "pa4", C.birch, 3800, { memo: "half now" }, "partial", [[pa4, 3800]]);
const pa5 = inv("grove", 1240, { dueDaysAgo: 27 });
pay("partial", "pa5", C.grove, 240, {}, "partial", [[pa5, 240]]);
const pa6 = inv("iris", 460, { dueDaysAgo: 36 });
pay("partial", "pa6", C.iris, 400, {}, "partial", [[pa6, 400]]);

// overpayment (3)
const ov1 = inv("cedar", 890, { dueDaysAgo: 29 });
pay("overpayment", "ov1", C.cedar, 900, { memo: "rounded up" }, "overpayment", [[ov1, 890]]);
const ov2 = inv("juno", 95, { dueDaysAgo: 31 });
pay("overpayment", "ov2", C.juno, 100, {}, "overpayment", [[ov2, 95]]);
const ov3 = inv("dune", 1480, { dueDaysAgo: 44 });
pay("overpayment", "ov3", C.dune, 1500, {}, "overpayment", [[ov3, 1480]]);

// ambiguous (4): equal balances, equal combinations
pay("ambiguous", "am1", C.cedar, 750, { daysAgo: 3 }, "ambiguous", [[c1, 750]], "B-0009 and B-0010 both $750; oldest shown for review");
pay("ambiguous", "am2", C.grove, 800, {}, "ambiguous", [[g1, 300], [g2, 500]], "300+500 or 350+450");
const am3a = inv("fern", 525, { dueDaysAgo: 41 });
inv("fern", 525, { dueDaysAgo: 2 });
pay("ambiguous", "am3", C.fern, 525, {}, "ambiguous", [[am3a, 525]]);
const am4a = inv("hazel", 330, { dueDaysAgo: 38 });
inv("hazel", 330, { dueDaysAgo: 37 });
pay("ambiguous", "am4", C.hazel, 330, { memo: "retainer" }, "ambiguous", [[am4a, 330]]);

// duplicate (4): same payer, same amount, within 3 days, the earlier one already applied by PayPal, nothing open for it
const dd1 = inv("juno", 640, { dueDaysAgo: 23, status: "PAID" });
transactions.push({ id: txnId("bench-dd1-first"), date: iso(3), type: "PAYMENT", amount: 640, fee: 0, currency: "USD", status: "S", payer_email: C.juno.email, payer_name: "Sam Juno", invoice_id: dd1.id });
pay("duplicate", "dd1", C.juno, 640, { daysAgo: 2 }, "duplicate", [], "repeat of the 640 applied to B-0057 two days earlier");
const dd2 = inv("elm", 1175, { dueDaysAgo: 12, status: "PAID" });
transactions.push({ id: txnId("bench-dd2-first"), date: iso(1), type: "PAYMENT", amount: 1175, fee: 0, currency: "USD", status: "S", payer_email: C.elm.email, payer_name: "Zoe Elm", invoice_id: dd2.id });
pay("duplicate", "dd2", C.elm, 1175, { daysAgo: 1, memo: "oops sent twice" }, "duplicate", []);
const dd3 = inv("grove", 2600, { dueDaysAgo: 5, status: "PAID" });
transactions.push({ id: txnId("bench-dd3-first"), date: iso(4), type: "PAYMENT", amount: 2600, fee: 0, currency: "USD", status: "S", payer_email: C.grove.email, payer_name: "Eli Grove", invoice_id: dd3.id });
pay("duplicate", "dd3", C.grove, 2600, { daysAgo: 2 }, "duplicate", []);
const dd4 = inv("hazel", 410, { dueDaysAgo: 15, status: "PAID" });
transactions.push({ id: txnId("bench-dd4-first"), date: iso(2), type: "PAYMENT", amount: 410, fee: 0, currency: "USD", status: "S", payer_email: C.hazel.email, payer_name: "Ada Hazel", invoice_id: dd4.id });
pay("duplicate", "dd4", C.hazel, 410, { daysAgo: 0 }, "duplicate", []);

// refund (5)
pay("refund", "rf1", C.juno, -4200, { type: "REFUND", memo: `Refund ${j1.invoice_number} project cancelled` }, "refund", [[j1, 4200]]);
pay("refund", "rf2", C.fern, -980, { type: "REFUND", memo: "refund" }, "refund", [[f3, 980]], "two paid invoices; amount equals one of them");
pay("refund", "rf3", C.elm, -540, { type: "REFUND" }, "refund", [[e2, 540]], "paid-in-full invoices for Elm: B-0015 (540) and the duplicate scenario's B-0058 (1150); amount picks B-0015");
pay("refund", "rf4", C.alder, -800, { type: "REFUND", memo: `inv ${digits(a4)} goodwill` }, "refund", [[a4, 800]]);
pay("refund", "rf5", C.iris, -120, { type: "REFUND", memo: `Refund for ${i3.invoice_number}` }, "refund", [[i3, 120]]);

// amount_only (3): unknown payer, amount equals exactly one open invoice
const ao1 = inv("birch", 1337, { dueDaysAgo: 10 });
pay("amount_only", "ao1", { email: "someone@unknown.example", name: "Unknown Payer" }, 1337, {}, "amount_only", [[ao1, 1337]]);
const ao2 = inv("grove", 2468, { dueDaysAgo: 11 });
pay("amount_only", "ao2", { email: "pay@processor.example", name: "Payment Processor" }, 2468, { memo: "transfer" }, "amount_only", [[ao2, 2468]]);
const ao3 = inv("dune", 3579, { dueDaysAgo: 12 });
pay("amount_only", "ao3", { email: "leo@personal.example", name: "Leo" }, 3579, {}, "amount_only", [[ao3, 3579]]);

// currency mismatch (3): Kestrel only has a EUR invoice; a EUR payment matches it, USD / GBP payments of the same number do not
pay("currency_mismatch", "cu0", C.kestrel, 2000, { currency: "EUR", memo: "Rechnung" }, "payer_exact", [[k1, 2000]], "same currency: a normal exact match");
pay("currency_mismatch", "cu1", C.kestrel, 2000, { currency: "USD", memo: "October" }, "unmatched", [], "USD payment equals the EUR 2,000 balance; not the same invoice");
pay("currency_mismatch", "cu2", C.kestrel, 2000, { currency: "GBP" }, "unmatched", []);

// known limit (2): two equal instalments on one invoice within three days and no memo. The second is reported as a
// possible duplicate for review (not recorded) although it is a legitimate second partial payment.
const kl1 = inv("lark", 5000, { dueDaysAgo: 48 });
pay("repeat_instalment", "kl1", C.lark, 1700, { daysAgo: 3 }, "partial", [[kl1, 1700]]);
pay("repeat_instalment", "kl2", C.lark, 1700, { daysAgo: 1 }, "partial", [[kl1, 1700]], "truth: a second instalment; the matcher reports a possible duplicate for review (known limit)");

// off-invoice (4): tips, unknown payers, client with nothing open
pay("off_invoice", "oi1", { email: "fan@random.example", name: "A Fan" }, 25, { memo: "coffee on me" }, "unmatched", []);
pay("off_invoice", "oi2", { email: "buyer@marketplace.example", name: "Marketplace Buyer" }, 49.99, { memo: "Order 8812" }, "unmatched", []);
pay("off_invoice", "oi3", { email: "nobody@nowhere.example", name: "Nobody" }, 777.77, {}, "unmatched", []);
pay("off_invoice", "oi4", C.juno, 12345.67, { memo: "advance for Q1" }, "unmatched", [], "known payer, no open invoice or combination fits");

/* ---------------- write ---------------- */
const file: BenchFile = { generated_at: new Date().toISOString(), now: NOW.toISOString(), invoices, transactions, labels };
const out = resolve(process.cwd(), "tests/fixtures/recon-bench.json");
mkdirSync(resolve(process.cwd(), "tests/fixtures"), { recursive: true });
writeFileSync(out, JSON.stringify(file, null, 2) + "\n");
console.log(`${invoices.length} invoices, ${transactions.length} transactions, ${labels.length} labelled -> ${out}`);
