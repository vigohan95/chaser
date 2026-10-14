import { describe, expect, it } from "vitest";
import { draftReminder, highestStageSent, overdueDays, planCollections, stageFor } from "@/lib/agent/chase";
import { buildInvoices } from "@/lib/paypal/fixtures";
import { DEFAULT_POLICY, parsePolicy } from "@/lib/policy/schema";

const now = new Date("2026-10-08T12:00:00Z");
const invoices = buildInvoices(now);
const byNo = (n: string) => invoices.find((i) => i.invoice_number === n)!;

describe("stageFor", () => {
  it("maps overdue days to stages per policy", () => {
    expect(stageFor(0, DEFAULT_POLICY)).toBe("none");
    expect(stageFor(2, DEFAULT_POLICY)).toBe("none");
    expect(stageFor(3, DEFAULT_POLICY)).toBe("friendly");
    expect(stageFor(10, DEFAULT_POLICY)).toBe("firm");
    expect(stageFor(21, DEFAULT_POLICY)).toBe("final");
    expect(stageFor(40, DEFAULT_POLICY)).toBe("final");
  });
  it("shifts for gentle/aggressive overrides", () => {
    expect(stageFor(3, DEFAULT_POLICY, "gentle")).toBe("none");
    expect(stageFor(8, DEFAULT_POLICY, "gentle")).toBe("friendly");
    expect(stageFor(1, DEFAULT_POLICY, "aggressive")).toBe("friendly");
    expect(stageFor(8, DEFAULT_POLICY, "aggressive")).toBe("firm");
  });
});

describe("planCollections on the demo book", () => {
  const plan = planCollections(invoices, DEFAULT_POLICY, now);
  const stage = (n: string) => plan.find((p) => p.invoice_number === n)?.stage;

  it("escalates correctly", () => {
    expect(overdueDays(byNo("INV-0001"), now)).toBe(37);
    expect(stage("INV-0001")).toBe("final"); // friendly already sent 32 days ago
    expect(stage("INV-0002")).toBe("firm"); // 15 days, nothing sent
    expect(stage("INV-0003")).toBe("friendly"); // 5 days
    expect(stage("INV-0010")).toBeUndefined(); // 30 days, friendly+firm+final already sent: after-final territory
    expect(stage("INV-0006")).toBeUndefined(); // partially paid, 10 days, but the client promised the rest (promise open)
    expect(stage("INV-0013")).toBe("friendly");
    expect(stage("INV-0014")).toBe("firm");
  });
  it("skips not-yet-due, paid, draft and paused invoices", () => {
    expect(stage("INV-0004")).toBeUndefined(); // 2 days overdue < 3
    expect(stage("INV-0005")).toBeUndefined(); // not due
    expect(stage("INV-0007")).toBeUndefined(); // paid
    expect(stage("INV-0017")).toBeUndefined(); // draft
    const paused = invoices.map((i) => (i.invoice_number === "INV-0002" ? { ...i, chase_override: "paused" as const } : i));
    expect(planCollections(paused, DEFAULT_POLICY, now).find((p) => p.invoice_number === "INV-0002")).toBeUndefined();
  });
  it("respects max reminders and minimum gap", () => {
    const maxed = invoices.map((i) => (i.invoice_number === "INV-0001" ? { ...i, reminders: [...i.reminders, { at: "2026-09-20T00:00:00Z", stage: "firm" as const }, { at: "2026-09-25T00:00:00Z", stage: "firm" as const }, { at: "2026-09-30T00:00:00Z", stage: "firm" as const }] } : i));
    expect(planCollections(maxed, DEFAULT_POLICY, now).find((p) => p.invoice_number === "INV-0001")).toBeUndefined();
    const recent = invoices.map((i) => (i.invoice_number === "INV-0001" ? { ...i, reminders: [{ at: new Date(now.getTime() - 86_400_000).toISOString(), stage: "firm" as const }] } : i));
    expect(planCollections(recent, DEFAULT_POLICY, now).find((p) => p.invoice_number === "INV-0001")).toBeUndefined();
  });
  it("never re-sends the same or a lower stage", () => {
    expect(highestStageSent(byNo("INV-0010"))).toBe("final");
    const firmOnly = { ...byNo("INV-0010"), reminders: byNo("INV-0010").reminders.filter((r) => r.stage !== "final") };
    expect(highestStageSent(firmOnly)).toBe("firm");
    const tight = parsePolicy({ reminders: { finalAfterDays: 60 } });
    expect(planCollections([firmOnly], tight, now).find((p) => p.invoice_number === "INV-0010")).toBeUndefined();
    expect(planCollections([firmOnly], DEFAULT_POLICY, now)[0]?.stage).toBe("final");
  });
  it("orders by most overdue first and includes a usable draft", () => {
    expect(plan[0].invoice_number).toBe("INV-0001");
    const d = draftReminder(byNo("INV-0001"), "final", 37, "Han");
    expect(d.subject).toContain("Final notice");
    expect(d.note).toContain("Website redesign");
    expect(d.note).toContain("$4,800.00");
    expect(d.note).toContain(byNo("INV-0001").links.pay!);
  });
});
