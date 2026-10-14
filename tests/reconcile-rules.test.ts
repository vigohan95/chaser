/**
 * The newer matcher rules on hand-built cases: fee-adjusted (net of a PayPal fee), refunds, duplicates, overpayments,
 * ambiguous pairs, currency, memo typos and stacked memo'd instalments. The benchmark test covers the aggregate.
 */
import { describe, expect, it } from "vitest";
import { feeBand, matchTransactions, memoRefers } from "@/lib/agent/reconcile";
import { buildInvoices, CLIENTS } from "@/lib/paypal/fixtures";
import type { Invoice, Transaction } from "@/lib/paypal/types";

const now = new Date("2026-10-13T12:00:00Z");
const invoices = buildInvoices(now);
const byNo = (n: string) => invoices.find((i) => i.invoice_number === n)!;
const tx = (over: Partial<Transaction>): Transaction => ({ id: "T1", date: now.toISOString(), type: "PAYMENT", amount: 100, fee: 0, currency: "USD", status: "S", ...over });

describe("memoRefers", () => {
  it("accepts the number with any punctuation and inv/invoice + digits, never bare numbers", () => {
    for (const memo of ["INV-0013", "inv 0013", "Invoice #INV-0013", "inv0013 thanks", "Inv. 0013", "invoice 13", "paying inv-0013"]) expect(memoRefers(memo, "INV-0013"), memo).toBe(true);
    expect(memoRefers("INV-00130", "INV-0013")).toBe(false);
    expect(memoRefers("0013", "INV-0013")).toBe(false);
    expect(memoRefers("", "INV-0013")).toBe(false);
    expect(memoRefers("B-0007", "B-0007")).toBe(true);
  });
});

describe("fee_adjusted", () => {
  it("matches a balance net of a PayPal fee (2.9% + 0.30 .. 3.49% + 0.49) and reports the fee gap", () => {
    expect(feeBand(1000)).toEqual({ min: 29.3, max: 35.39 });
    const inv13 = byNo("INV-0013"); // Harbor, 1350 due
    const { matches } = matchTransactions([tx({ amount: 1310.5, payer_email: CLIENTS.harbor.email })], invoices); // 1350 - (2.9% + 0.30)
    expect(matches[0]).toMatchObject({ kind: "fee_adjusted", rule: "fee_adjusted", action: "record_payment", fee_gap: 39.5 });
    expect(matches[0].allocations).toEqual([{ invoice_id: inv13.id, invoice_number: "INV-0013", amount: 1310.5, closes: false }]);
    // the transaction's own fee field also qualifies
    const own = matchTransactions([tx({ amount: 1300, fee: 50, payer_email: CLIENTS.harbor.email })], invoices).matches[0];
    expect(own.rule).toBe("fee_adjusted");
    // outside the band it is a plain partial
    expect(matchTransactions([tx({ amount: 1250, payer_email: CLIENTS.harbor.email })], invoices).matches[0].rule).toBe("partial");
  });
});

describe("refund", () => {
  it("links an unlinked refund to the payer's paid invoice and asks for record_refund_for_invoice", () => {
    const r = matchTransactions([tx({ type: "REFUND", amount: -2100, payer_email: CLIENTS.pinecrest.email, memo: "refund INV-0007" })], invoices).matches[0];
    expect(r).toMatchObject({ kind: "refund", rule: "refund", action: "record_refund", confidence: 0.95 });
    expect(r.allocations[0]).toMatchObject({ invoice_number: "INV-0007", amount: 2100 });
    const single = matchTransactions([tx({ type: "REFUND", amount: -500, payer_email: CLIENTS.northwind.email })], invoices).matches[0];
    expect(single).toMatchObject({ rule: "refund", confidence: 0.85 }); // Northwind's only paid invoice
    const { unmatched } = matchTransactions([tx({ type: "REFUND", amount: -50, payer_email: "nobody@x.example" })], invoices);
    expect(unmatched[0].reason).toMatch(/no paid invoice/);
  });
});

describe("duplicate and overpayment", () => {
  it("flags a same-amount repeat within 3 days of an applied payment for review, never recording it", () => {
    const first = tx({ id: "A", amount: 1350, payer_email: CLIENTS.harbor.email, date: new Date(now.getTime() - 86_400_000).toISOString() });
    const second = tx({ id: "B", amount: 1350, payer_email: CLIENTS.harbor.email });
    const { matches } = matchTransactions([first, second], invoices);
    expect(matches.find((m) => m.transaction_id === "A")).toMatchObject({ rule: "payer_exact" });
    expect(matches.find((m) => m.transaction_id === "B")).toMatchObject({ rule: "duplicate", action: "review", related_transaction_id: "A", allocations: [] });
    // a different currency is not a duplicate
    const eur = matchTransactions([first, { ...second, currency: "EUR" }], invoices).matches.find((m) => m.transaction_id === "B");
    expect(eur).toBeUndefined();
  });
  it("treats a payment slightly over exactly one balance as a rounded-up overpayment", () => {
    const m = matchTransactions([tx({ amount: 1360, payer_email: CLIENTS.harbor.email })], invoices).matches[0];
    expect(m).toMatchObject({ rule: "overpayment", action: "record_payment" });
    expect(m.allocations).toEqual([{ invoice_id: byNo("INV-0013").id, invoice_number: "INV-0013", amount: 1350, closes: true }]);
    expect(m.reasoning).toContain("$10.00 over");
  });
});

describe("ambiguous, currency and stacked memo instalments", () => {
  const twin = (): Invoice[] => [byNo("INV-0013"), { ...byNo("INV-0004"), due: 1350, total: 1350 }]; // two Harbor invoices with the same balance
  it("shows an equal-balance pair for review instead of guessing", () => {
    const m = matchTransactions([tx({ amount: 1350, payer_email: CLIENTS.harbor.email })], twin()).matches[0];
    expect(m).toMatchObject({ rule: "ambiguous", action: "review", confidence: 0.5 });
    expect(m.allocations[0].invoice_number).toBe("INV-0013"); // oldest due date shown
    const memo = matchTransactions([tx({ amount: 1350, payer_email: CLIENTS.harbor.email, memo: "INV-0013" })], twin()).matches[0];
    expect(memo.rule).toBe("memo_exact");
  });
  it("does not match across currencies and says why", () => {
    const { matches, unmatched } = matchTransactions([tx({ amount: 1350, currency: "EUR", payer_email: CLIENTS.harbor.email })], invoices);
    expect(matches).toEqual([]);
    expect(unmatched[0].reason).toMatch(/another currency/);
  });
  it("lets two memo'd instalments land on the same invoice in one run, the second closing it", () => {
    const a = tx({ id: "A", amount: 1000, payer_email: CLIENTS.harbor.email, memo: "INV-0013 part 1" });
    const b = tx({ id: "B", amount: 350, payer_email: CLIENTS.harbor.email, memo: "INV-0013 part 2" });
    const { matches } = matchTransactions([a, b], invoices);
    expect(matches.map((m) => [m.transaction_id, m.rule, m.allocations[0].amount, m.allocations[0].closes])).toEqual([
      ["A", "partial_memo", 1000, false],
      ["B", "memo_exact", 350, true],
    ]);
  });
  it("memo from another payer's email still wins over amount-only", () => {
    const m = matchTransactions([tx({ amount: 1350, payer_email: "marcus.personal@mail.example", memo: "INV-0013 from my own account" })], invoices).matches[0];
    expect(m).toMatchObject({ rule: "memo_other_payer", confidence: 0.85, action: "record_payment" });
  });
});
