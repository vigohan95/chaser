/**
 * Match review: the editable allocation grid round-trips through the agent. Rows come from the same matcher the
 * agent uses; the message the grid sends is what the rule planner parses; recording goes through the policy gate.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { matchTransactions } from "@/lib/agent/reconcile";
import { runOnce } from "@/lib/agent/run";
import { allocationMessage, overAllocated, rowsFromResult } from "@/components/MatchReview";
import { parseAllocations, detectIntent } from "@/lib/llm/mock-model";
import { buildInvoices, buildTransactions, CLIENTS } from "@/lib/paypal/fixtures";
import { getStore, resetStore } from "@/lib/store";

const now = new Date("2026-10-10T12:00:00Z");
const invoices = buildInvoices(now);
const transactions = buildTransactions(now, invoices);
const result = matchTransactions(transactions, invoices);
const inv = (n: string) => getStore().mock.invoices.find((i) => i.invoice_number === n)!;

describe("rowsFromResult / allocationMessage / parseAllocations", () => {
  const rows = rowsFromResult(result, transactions, invoices);
  it("makes one editable line per allocation, with the invoice balance beside it", () => {
    expect(rows.length).toBe(4); // exact + partial + split(2)
    const split = rows.filter((r) => r.payer_email === CLIENTS.vireo.email);
    expect(split.map((r) => r.invoice_number).sort()).toEqual(["INV-0015", "INV-0016"]);
    expect(split.every((r) => r.payment === 1400 && r.kind === "combined")).toBe(true);
    expect(rows.find((r) => r.invoice_number === "INV-0014")).toMatchObject({ amount: 300, balance: 640, kind: "partial" });
  });
  it("round-trips the message into explicit allocations the planner records", () => {
    const msg = allocationMessage(rows);
    expect(msg.startsWith("Record these payment allocations: ")).toBe(true);
    expect(detectIntent(msg)).toBe("reconcile");
    const parsed = parseAllocations(msg);
    expect(parsed.length).toBe(4);
    expect(parsed.find((a) => a.invoice_number === "INV-0014")).toMatchObject({ amount: 300, invoice_id: rows.find((r) => r.invoice_number === "INV-0014")!.invoice_id });
    expect(parsed.every((a) => /^[A-Z0-9]{17}$/.test(a.transaction_id))).toBe(true);
    // without a bracketed id the number is used as the id (mock accepts both)
    expect(parseAllocations("Record these payment allocations: ABCDEFGHJKLMNPQ12 -> INV-0001 $1,234.50")[0]).toEqual({ transaction_id: "ABCDEFGHJKLMNPQ12", invoice_number: "INV-0001", invoice_id: "INV-0001", amount: 1234.5 });
  });
  it("flags a payment whose lines add up to more than the payment", () => {
    const edited = rows.map((r) => (r.invoice_number === "INV-0016" ? { ...r, amount: 600 } : r));
    const bad = overAllocated(edited);
    expect([...bad]).toEqual([rows.find((r) => r.invoice_number === "INV-0016")!.transaction_id]);
    expect(overAllocated(rows).size).toBe(0);
  });
});

describe("recording reviewed allocations through the agent (no keys)", () => {
  beforeEach(() => resetStore(now));

  it("records exactly the lines the user reviewed, including a changed split", async () => {
    const live = matchTransactions(getStore().mock.transactions, getStore().mock.invoices);
    const rows = rowsFromResult(live, getStore().mock.transactions, getStore().mock.invoices);
    // the human moves $100 of the Vireo split from INV-0016 to INV-0015? No: INV-0015 balance is 900, so give 1000/400 instead
    const edited = rows.map((r) => (r.invoice_number === "INV-0015" ? { ...r, amount: 1000 } : r.invoice_number === "INV-0016" ? { ...r, amount: 400 } : r));
    const r = await runOnce(allocationMessage(edited), { unattended: true });
    expect(r.toolCalls).toEqual(["record_payment_for_invoice", "record_payment_for_invoice", "record_payment_for_invoice", "record_payment_for_invoice"]);
    // $1000 on a $900 balance is over the amount due -> policy asks -> skipped in an unattended run
    expect(inv("INV-0015").status).toBe("UNPAID");
    expect(inv("INV-0016")).toMatchObject({ status: "PARTIALLY_PAID", due: 100 });
    expect(inv("INV-0013").status).toBe("PAID");
    expect(inv("INV-0014")).toMatchObject({ status: "PARTIALLY_PAID", due: 340 });
    expect(r.text).toMatch(/Recorded 3 of 4 allocation/);
    expect(getStore().audit.some((a) => a.decision === "approval-required" && a.rule === "reconciliation.amountTolerance")).toBe(true);
  });
});
