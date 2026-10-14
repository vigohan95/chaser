import { describe, expect, it } from "vitest";
import { buildDisputes, buildInvoices, buildTransactions } from "@/lib/paypal/fixtures";
import { evaluateAction, isReadOnlyTool } from "@/lib/policy/engine";
import { DEFAULT_POLICY, parsePolicy, PolicySchema } from "@/lib/policy/schema";

const now = new Date("2026-10-08T12:00:00Z");
const invoices = buildInvoices(now);
const transactions = buildTransactions(now, invoices);
const disputes = buildDisputes(now, invoices, transactions);
const ctx = { policy: DEFAULT_POLICY, invoices, disputes, now };
const inv = (n: string) => invoices.find((i) => i.invoice_number === n)!;

describe("policy schema", () => {
  it("has sane defaults", () => {
    expect(DEFAULT_POLICY.reminders).toEqual({ friendlyAfterDays: 3, firmAfterDays: 10, finalAfterDays: 21, minDaysBetweenReminders: 3, maxReminders: 4, adaptToHistory: true, historyShiftDays: 3, viewedAware: true, unviewedAfterDays: 5, unviewedStrategy: "resend" });
    expect(DEFAULT_POLICY.disputes.autoAcceptUnder).toBe(20);
    expect(DEFAULT_POLICY.approvals.refundsOver).toBe(500);
  });
  it("merges partial input over defaults and validates", () => {
    const p = parsePolicy({ reminders: { firmAfterDays: 7 }, disputes: { autoAcceptUnder: 50 } });
    expect(p.reminders.firmAfterDays).toBe(7);
    expect(p.reminders.friendlyAfterDays).toBe(3);
    expect(p.disputes.autoAcceptUnder).toBe(50);
    expect(() => PolicySchema.parse({ ...DEFAULT_POLICY, reminders: { ...DEFAULT_POLICY.reminders, maxReminders: -1 } })).toThrow();
  });
});

describe("evaluateAction", () => {
  it("allows read-only tools", () => {
    for (const t of ["list_invoices", "get_invoice", "search_invoicing", "list_transactions", "list_disputes", "generate_invoice_qr_code", "propose_collections", "match_payments", "lookup_customer"]) {
      expect(isReadOnlyTool(t)).toBe(true);
      expect(evaluateAction(t, {}, ctx).decision).toBe("allow");
    }
  });

  it("gates invoice creation by amount", () => {
    const items = (v: number) => ({ currency_code: "USD", items: [{ name: "x", quantity: 1, unit_amount: { currency_code: "USD", value: v.toFixed(2) } }] });
    expect(evaluateAction("create_invoice", items(1200), ctx).decision).toBe("allow");
    expect(evaluateAction("create_invoice", items(5000), ctx).decision).toBe("approve");
    expect(evaluateAction("create_invoice", { ...items(2000), items: [{ name: "x", quantity: 3, unit_amount: { value: "2000" } }] }, ctx).decision).toBe("approve");
  });

  it("enforces reminder cadence", () => {
    expect(evaluateAction("send_invoice_reminder", { invoice_id: inv("INV-0002").id }, ctx).decision).toBe("allow");
    const paused = { ...inv("INV-0002"), chase_override: "paused" as const };
    expect(evaluateAction("send_invoice_reminder", { invoice_id: paused.id }, { ...ctx, invoices: [paused] })).toMatchObject({ decision: "deny", reason: expect.stringContaining("paused") });
    const maxed = { ...inv("INV-0002"), reminders: Array.from({ length: 4 }, (_, i) => ({ at: new Date(now.getTime() - (10 - i) * 86_400_000).toISOString(), stage: "firm" as const })) };
    expect(evaluateAction("send_invoice_reminder", { invoice_id: maxed.id }, { ...ctx, invoices: [maxed] }).decision).toBe("deny");
    const recent = { ...inv("INV-0002"), reminders: [{ at: new Date(now.getTime() - 1 * 86_400_000).toISOString(), stage: "friendly" as const }] };
    expect(evaluateAction("send_invoice_reminder", { invoice_id: recent.id }, { ...ctx, invoices: [recent] })).toMatchObject({ decision: "deny", reason: expect.stringContaining("days ago") });
    // accepts invoice numbers too
    expect(evaluateAction("send_invoice_reminder", { invoice_id: "INV-0003" }, ctx).decision).toBe("allow");
  });

  it("records payments inside the balance without asking, asks beyond it", () => {
    const id = inv("INV-0013").id; // due 1350
    expect(evaluateAction("record_payment_for_invoice", { invoice_id: id, method: "PAYPAL", amount: { currency_code: "USD", value: "1350.00" } }, ctx)).toMatchObject({ decision: "allow", reason: expect.stringContaining("Exact") });
    expect(evaluateAction("record_payment_for_invoice", { invoice_id: id, method: "PAYPAL", amount: { value: "300" } }, ctx)).toMatchObject({ decision: "allow", reason: expect.stringContaining("Partial") });
    expect(evaluateAction("record_payment_for_invoice", { invoice_id: id, method: "PAYPAL", amount: { value: "1400" } }, ctx).decision).toBe("approve");
    expect(evaluateAction("record_payment_for_invoice", { invoice_id: id, method: "PAYPAL" }, ctx).decision).toBe("allow");
    const strict = parsePolicy({ reconciliation: { autoRecordExactMatches: false, autoRecordPartials: false } });
    expect(evaluateAction("record_payment_for_invoice", { invoice_id: id, method: "PAYPAL", amount: { value: "1350" } }, { ...ctx, policy: strict }).decision).toBe("approve");
    expect(evaluateAction("record_payment_for_invoice", { invoice_id: "nope", method: "CASH" }, ctx).decision).toBe("approve");
  });

  it("gates refunds by amount and always asks for full refunds", () => {
    expect(evaluateAction("create_refund", { capture_id: "x", amount: { currency_code: "USD", value: "120.00" } }, ctx).decision).toBe("allow");
    expect(evaluateAction("create_refund", { capture_id: "x", amount: { value: "500" } }, ctx).decision).toBe("approve");
    expect(evaluateAction("create_refund", { capture_id: "x", amount: { value: "600" } }, ctx)).toMatchObject({ decision: "approve", reason: expect.stringContaining("$500.00") });
    expect(evaluateAction("create_refund", { capture_id: "x" }, ctx).decision).toBe("approve");
    expect(evaluateAction("record_refund_for_invoice", { invoice_id: inv("INV-0007").id, method: "PAYPAL", amount: { value: "50" } }, ctx).decision).toBe("allow");
  });

  it("auto-accepts small disputes only", () => {
    expect(evaluateAction("accept_dispute_claim", { dispute_id: "PP-D-MOCK-00015", note: "ok" }, ctx).decision).toBe("allow");
    expect(evaluateAction("accept_dispute_claim", { dispute_id: "PP-D-MOCK-00480", note: "ok" }, ctx).decision).toBe("approve");
    expect(evaluateAction("accept_dispute_claim", { dispute_id: "unknown", note: "ok" }, ctx).decision).toBe("approve");
    const generous = parsePolicy({ disputes: { autoAcceptUnder: 1000 } });
    expect(evaluateAction("accept_dispute_claim", { dispute_id: "PP-D-MOCK-00480", note: "ok" }, { ...ctx, policy: generous }).decision).toBe("allow");
  });

  it("honours always-ask, never-allow and unknown tools", () => {
    expect(evaluateAction("cancel_sent_invoice", { invoice_id: inv("INV-0002").id }, ctx).decision).toBe("approve");
    expect(evaluateAction("cancel_subscription", { subscription_id: "I-1" }, ctx).decision).toBe("approve");
    const locked = parsePolicy({ approvals: { neverAllow: ["create_refund"] } });
    expect(evaluateAction("create_refund", { capture_id: "x", amount: { value: "1" } }, { ...ctx, policy: locked }).decision).toBe("deny");
    expect(evaluateAction("some_future_tool", {}, ctx).decision).toBe("approve");
    expect(evaluateAction("create_shipment_tracking", { tracking_number: "1Z", transaction_id: "t" }, ctx).decision).toBe("allow");
    expect(evaluateAction("create_subscription", { plan_id: "P" }, ctx).decision).toBe("allow");
  });
});
