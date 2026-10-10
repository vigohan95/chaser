/**
 * Partial / split reconciliation keeps one PayPal transaction per payment: allocations accumulate on it, the
 * unapplied remainder stays visible to the matcher and the grid, and nothing synthetic is invented.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { matchTransactions } from "@/lib/agent/reconcile";
import { runOnce } from "@/lib/agent/run";
import { mockExecute } from "@/lib/paypal/mock";
import { CLIENTS } from "@/lib/paypal/fixtures";
import { unappliedAmount } from "@/lib/paypal/types";
import { getStore, resetStore } from "@/lib/store";

const now = new Date("2026-10-10T12:00:00Z");
const inv = (n: string) => getStore().mock.invoices.find((i) => i.invoice_number === n)!;
const vireoPayment = () => getStore().mock.transactions.find((t) => t.payer_email === CLIENTS.vireo.email && t.amount === 1400)!;

beforeEach(() => resetStore(now));

describe("unappliedAmount", () => {
  it("is the full amount for an unlinked payment, zero once PayPal linked it, and the remainder after allocations", () => {
    expect(unappliedAmount(vireoPayment())).toBe(1400);
    expect(unappliedAmount({ ...vireoPayment(), invoice_id: "x" })).toBe(0);
    expect(unappliedAmount({ ...vireoPayment(), allocations: [{ invoice_id: "a", invoice_number: "INV-0016", amount: 400 }] })).toBe(1000);
    expect(unappliedAmount({ ...vireoPayment(), type: "REFUND", amount: -5 })).toBe(0);
  });
});

describe("split recording on one transaction", () => {
  it("accumulates allocations, links the transaction only when fully applied, and leaves the rest for the matcher", async () => {
    const t = vireoPayment();
    const before = getStore().mock.transactions.length;
    await mockExecute("record_payment_for_invoice", { invoice_id: inv("INV-0016").id, method: "PAYPAL", payment_id: t.id, amount: { currency_code: "USD", value: "400.00" } });
    expect(getStore().mock.transactions.length).toBe(before); // no synthetic transaction
    expect(t.allocations).toEqual([{ invoice_id: inv("INV-0016").id, invoice_number: "INV-0016", amount: 400 }]);
    expect(t.invoice_id).toBeUndefined();
    expect(unappliedAmount(t)).toBe(1000);
    expect(inv("INV-0016")).toMatchObject({ status: "PARTIALLY_PAID", due: 100 });

    // the matcher now proposes the remainder: 900 closes INV-0015, 100 closes INV-0016
    const { matches } = matchTransactions(getStore().mock.transactions, getStore().mock.invoices);
    const m = matches.find((x) => x.transaction_id === t.id)!;
    expect(m.amount).toBe(1000);
    expect(m.kind).toBe("combined");
    expect(m.allocations.map((a) => [a.invoice_number, a.amount]).sort()).toEqual([
      ["INV-0015", 900],
      ["INV-0016", 100],
    ]);

    await mockExecute("record_payment_for_invoice", { invoice_id: inv("INV-0015").id, method: "PAYPAL", payment_id: t.id, amount: { currency_code: "USD", value: "900.00" } });
    await mockExecute("record_payment_for_invoice", { invoice_id: inv("INV-0016").id, method: "PAYPAL", payment_id: t.id, amount: { currency_code: "USD", value: "100.00" } });
    expect(t.allocations?.length).toBe(3);
    expect(unappliedAmount(t)).toBe(0);
    expect(t.invoice_id).toBe(inv("INV-0016").id); // first allocation's invoice once fully applied
    expect(inv("INV-0015").status).toBe("PAID");
    expect(inv("INV-0016").status).toBe("PAID");
  });

  it("the agent's own reconcile run produces the same single-transaction result", async () => {
    await runOnce("Reconcile payments", { unattended: true });
    const t = vireoPayment();
    expect(t.allocations?.map((a) => a.invoice_number).sort()).toEqual(["INV-0015", "INV-0016"]);
    expect(unappliedAmount(t)).toBe(0);
    expect(getStore().mock.transactions.filter((x) => unappliedAmount(x) > 0)).toEqual([]);
  });
});
