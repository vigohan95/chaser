/**
 * Serverless state model: a client snapshot hydrated per request must be the store that the whole agent loop
 * (model, policy gate, tool execution, audit) writes to, and the process-global store must stay untouched.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { runOnce } from "@/lib/agent/run";
import { statePayload, withSnapshot } from "@/lib/api";
import { buildInvoices, FIRST_FREE_SEQ } from "@/lib/paypal/fixtures";
import { createStore, getStore, hydrateSnapshot, resetStore, runWithStore } from "@/lib/store";

beforeEach(() => {
  resetStore(new Date());
});

describe("hydrateSnapshot", () => {
  it("falls back to fresh demo data for garbage", () => {
    expect(hydrateSnapshot(undefined).mock.invoices.length).toBe(FIRST_FREE_SEQ - 1);
    expect(hydrateSnapshot({ mock: {} }).mock.invoices.length).toBe(FIRST_FREE_SEQ - 1);
    expect(hydrateSnapshot("nope").audit.length).toBe(1);
  });
  it("round-trips a serialized store and re-validates the policy", () => {
    const s = createStore();
    s.policy.disputes.autoAcceptUnder = 75;
    const before = s.mock.invoices[0].reminders.length;
    s.mock.invoices[0].reminders.push({ at: new Date().toISOString(), stage: "firm" });
    const h = hydrateSnapshot(JSON.parse(JSON.stringify(s)));
    expect(h.policy.disputes.autoAcceptUnder).toBe(75);
    expect(h.mock.invoices[0].reminders.length).toBe(before + 1);
    const broken = JSON.parse(JSON.stringify(s));
    broken.policy = { reminders: { maxReminders: -5 } };
    expect(hydrateSnapshot(broken).policy.reminders.maxReminders).toBe(4);
  });
});

describe("request-scoped store through the agent loop", () => {
  it("mutates only the hydrated snapshot, not the global store", async () => {
    const snapshot = JSON.parse(JSON.stringify(createStore()));
    const result = await withSnapshot({ snapshot }, async (store) => {
      expect(getStore()).toBe(store);
      const r = await runOnce("Run collections", { unattended: true });
      expect(r.toolCalls.filter((t) => t === "send_invoice_reminder").length).toBeGreaterThanOrEqual(6);
      const payload = await statePayload();
      return { store, payload };
    });
    const scopedReminders = result.store.mock.invoices.reduce((a, i) => a + i.reminders.length, 0);
    const globalReminders = getStore().mock.invoices.reduce((a, i) => a + i.reminders.length, 0);
    expect(scopedReminders).toBeGreaterThan(globalReminders);
    expect(globalReminders).toBe(buildInvoices(new Date()).reduce((a, i) => a + i.reminders.length, 0)); // untouched fixtures
    expect(result.store.audit.some((a) => a.tool === "send_invoice_reminder")).toBe(true);
    expect(getStore().audit.length).toBe(1);
    expect(result.payload.view.version).toBe(result.store.version);
    expect(result.payload.snapshot).toBe(result.store);
  });

  it("isolates two concurrent visitors", async () => {
    const a = createStore();
    const b = createStore();
    await Promise.all([
      runWithStore(a, () => runOnce("Reconcile payments", { unattended: true })),
      runWithStore(b, () => runOnce("Review disputes", { unattended: true })),
    ]);
    expect(a.mock.invoices.find((i) => i.invoice_number === "INV-0013")?.status).toBe("PAID");
    expect(b.mock.invoices.find((i) => i.invoice_number === "INV-0013")?.status).toBe("UNPAID");
    expect(b.mock.disputes.find((d) => d.id === "PP-D-MOCK-00015")?.status).toBe("RESOLVED");
    expect(a.mock.disputes.find((d) => d.id === "PP-D-MOCK-00015")?.status).toBe("OPEN_INQUIRIES");
    expect(getStore().audit.length).toBe(1);
  });
});
