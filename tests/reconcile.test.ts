import { describe, expect, it } from "vitest";
import { matchTransactions } from "@/lib/agent/reconcile";
import { buildInvoices, buildTransactions, CLIENTS } from "@/lib/paypal/fixtures";
import type { Transaction } from "@/lib/paypal/types";

const now = new Date("2026-10-08T12:00:00Z");
const invoices = buildInvoices(now);
const transactions = buildTransactions(now, invoices);

describe("matchTransactions on the demo book", () => {
  const { matches, unmatched } = matchTransactions(transactions, invoices);
  const byPayer = (email: string) => matches.find((m) => m.payer_email === email)!;

  it("ignores payments PayPal already linked", () => {
    expect(matches.length + unmatched.length).toBe(3);
  });
  it("finds the exact match (same payer, amount == balance)", () => {
    const m = byPayer(CLIENTS.harbor.email);
    expect(m.kind).toBe("exact");
    expect(m.confidence).toBeGreaterThanOrEqual(0.95);
    expect(m.allocations).toEqual([{ invoice_id: expect.any(String), invoice_number: "INV-0013", amount: 1350, closes: true }]);
  });
  it("treats a smaller payment from a known payer as partial on the oldest open invoice", () => {
    const m = byPayer(CLIENTS.solstice.email);
    expect(m.kind).toBe("partial");
    expect(m.allocations[0]).toMatchObject({ invoice_number: "INV-0014", amount: 300, closes: false });
    expect(m.reasoning).toContain("memo says so");
  });
  it("splits one payment across several invoices when the sum matches", () => {
    const m = byPayer(CLIENTS.vireo.email);
    expect(m.kind).toBe("combined");
    expect(m.allocations.map((a) => a.invoice_number).sort()).toEqual(["INV-0015", "INV-0016"]);
    expect(m.allocations.reduce((a, x) => a + x.amount, 0)).toBe(1400);
    expect(m.allocations.every((a) => a.closes)).toBe(true);
  });
  it("leaves nothing unmatched in the demo data", () => {
    expect(unmatched).toEqual([]);
  });
});

describe("matchTransactions edge cases", () => {
  const tx = (over: Partial<Transaction>): Transaction => ({ id: "T1", date: now.toISOString(), type: "PAYMENT", amount: 100, fee: 0, currency: "USD", status: "S", ...over });

  it("uses an invoice number in the memo as the strongest signal", () => {
    const { matches } = matchTransactions([tx({ amount: 750, payer_email: CLIENTS.acme.email, memo: "paying inv-0009 thanks" })], invoices);
    expect(matches[0]).toMatchObject({ kind: "exact", confidence: 0.99 });
    expect(matches[0].allocations[0].invoice_number).toBe("INV-0009");
  });
  it("flags amount-only matches from unknown payers at low confidence", () => {
    const { matches } = matchTransactions([tx({ amount: 1350, payer_email: "someone@else.example" })], invoices);
    expect(matches[0]).toMatchObject({ kind: "amount-only", confidence: 0.4 });
  });
  it("reports unmatched payments with a reason", () => {
    const { matches, unmatched } = matchTransactions([tx({ amount: 77.77, payer_email: "someone@else.example" })], invoices);
    expect(matches).toEqual([]);
    expect(unmatched[0]).toMatchObject({ transaction_id: "T1", amount: 77.77 });
  });
  it("skips refunds, pending and already-linked transactions", () => {
    const { matches, unmatched } = matchTransactions([tx({ type: "REFUND", amount: -10 }), tx({ id: "T2", status: "P", amount: 1350, payer_email: CLIENTS.harbor.email }), tx({ id: "T3", invoice_id: "x", amount: 1350, payer_email: CLIENTS.harbor.email })], invoices);
    expect(matches).toEqual([]);
    expect(unmatched).toEqual([]);
  });
  it("does not double-allocate an invoice across two payments", () => {
    const { matches } = matchTransactions([tx({ id: "A", amount: 1350, payer_email: CLIENTS.harbor.email }), tx({ id: "B", amount: 1350, payer_email: CLIENTS.harbor.email })], invoices);
    const numbers = matches.flatMap((m) => m.allocations.map((a) => a.invoice_number));
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
