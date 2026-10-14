/**
 * Payer history -> predicted pay date + risk band -> adaptive cadence. The signal is PayPal's own record
 * (payment dates vs due dates on each client's paid invoices); the cadence shift is policy (reminders.adaptToHistory)
 * and every shifted stage is explained with the numbers.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cadenceShift, explainStage, planCollections, stageFor, thresholdsFor } from "@/lib/agent/chase";
import { payDateFor, payerProfiles, predictInvoice, profileFor, unknownProfile } from "@/lib/agent/payer-history";
import { runOnce } from "@/lib/agent/run";
import { buildInvoices, buildTransactions, CLIENTS } from "@/lib/paypal/fixtures";
import { mapInvoice } from "@/lib/paypal/live";
import { DEFAULT_POLICY, parsePolicy } from "@/lib/policy/schema";
import { getStore, resetStore } from "@/lib/store";

const now = new Date("2026-10-08T12:00:00Z");
const invoices = buildInvoices(now);
const transactions = buildTransactions(now, invoices);
const byNo = (n: string) => invoices.find((i) => i.invoice_number === n)!;

describe("payerProfiles on the demo book", () => {
  const profiles = payerProfiles(invoices, transactions);

  it("reads the payment date from the linked PayPal transaction, else from paid_at", () => {
    expect(payDateFor(byNo("INV-0021"), transactions)?.slice(0, 10)).toBe("2026-08-04"); // 65 days before now
    expect(payDateFor({ ...byNo("INV-0021"), id: "detached" }, transactions)).toBe("2026-08-04"); // falls back to paid_at
    expect(payDateFor(byNo("INV-0002"), transactions)).toBeUndefined();
  });

  it("bands Acme as late-risk from two late payments, Pinecrest as reliable, one-sample payers as typical", () => {
    const acme = profiles.get(CLIENTS.acme.email)!;
    expect(acme).toMatchObject({ sample: 2, late_rate: 1, band: "late-risk", reminders_avg: 1.5 });
    expect(acme.median_days_late).toBe(13.5); // 15 and 12 days late
    expect(acme.basis).toMatch(/2 paid invoices: median 14 days late, 100% paid late/);

    const pinecrest = profiles.get(CLIENTS.pinecrest.email)!;
    expect(pinecrest).toMatchObject({ sample: 2, late_rate: 0, band: "reliable" });
    expect(pinecrest.median_days_late).toBe(-6); // on time and 12 days early

    expect(profiles.get(CLIENTS.bluebird.email)).toMatchObject({ sample: 2, band: "late-risk", median_days_late: 7.5 });
    expect(profiles.get(CLIENTS.northwind.email)).toMatchObject({ sample: 1, band: "typical" });
    expect(profiles.get(CLIENTS.harbor.email)).toBeUndefined();
    expect(profileFor(CLIENTS.harbor.email, invoices, transactions)).toMatchObject({ band: "unknown", sample: 0 });
  });

  it("ignores open, draft and cancelled invoices and payments without a date", () => {
    const noHistory = payerProfiles(invoices.filter((i) => i.status !== "PAID" && i.status !== "PARTIALLY_REFUNDED"), transactions);
    expect(noHistory.size).toBe(0);
  });
});

describe("predictInvoice", () => {
  it("shifts the due date by the payer's median lateness and reports the risk band", () => {
    const acme = profileFor(CLIENTS.acme.email, invoices, transactions);
    const p = predictInvoice(byNo("INV-0009"), acme, now); // due 2026-10-15
    expect(p).toMatchObject({ predicted_pay_date: "2026-10-29", days_until_predicted: 21, risk: "late-risk" });
    expect(p.basis).toContain("expected 14 days after due");
    const pine = profileFor(CLIENTS.pinecrest.email, invoices, transactions);
    expect(predictInvoice({ due_date: "2026-10-20", client: CLIENTS.pinecrest }, pine, now)).toMatchObject({ predicted_pay_date: "2026-10-14", risk: "reliable" });
  });
  it("uses the due date when there is no history, and flags an invoice far past its own pattern as late-risk", () => {
    expect(predictInvoice(byNo("INV-0013"), unknownProfile(CLIENTS.harbor.email), now)).toMatchObject({ predicted_pay_date: byNo("INV-0013").due_date, risk: "unknown" });
    const north = profileFor(CLIENTS.northwind.email, invoices, transactions); // typical, pays on time
    const p = predictInvoice({ due_date: "2026-09-20", client: CLIENTS.northwind }, north, now); // 18 days past prediction
    expect(p.risk).toBe("late-risk");
    expect(p.basis).toContain("18 days past this client's own pattern");
  });
});

describe("adaptive cadence (reminders.adaptToHistory)", () => {
  it("moves the thresholds earlier for late-risk payers and later for reliable ones, and cites the rule", () => {
    expect(thresholdsFor(DEFAULT_POLICY)).toEqual({ friendly: 3, firm: 10, final: 21 });
    expect(thresholdsFor(DEFAULT_POLICY, "default", "late-risk")).toEqual({ friendly: 1, firm: 7, final: 18 });
    expect(thresholdsFor(DEFAULT_POLICY, "default", "reliable")).toEqual({ friendly: 6, firm: 13, final: 24 });
    expect(cadenceShift(DEFAULT_POLICY, "default", "late-risk")).toEqual({ shift: -3, history: -3, rule: "reminders.adaptToHistory" });
    expect(cadenceShift(DEFAULT_POLICY, "aggressive", "late-risk").shift).toBe(-5);
    expect(stageFor(8, DEFAULT_POLICY, "default", "late-risk")).toBe("firm");
    expect(stageFor(8, DEFAULT_POLICY, "default", "typical")).toBe("friendly");
    expect(stageFor(11, DEFAULT_POLICY, "default", "reliable")).toBe("friendly");
    const off = parsePolicy({ reminders: { adaptToHistory: false } });
    expect(thresholdsFor(off, "default", "late-risk")).toEqual({ friendly: 3, firm: 10, final: 21 });
    expect(cadenceShift(off, "default", "late-risk").rule).toBe("reminders");
  });

  it("explains a shifted stage with the policy numbers and the payer's record", () => {
    const acme = profileFor(CLIENTS.acme.email, invoices, transactions);
    const { why, rule } = explainStage("firm", 8, DEFAULT_POLICY, { chase_override: "default", client: CLIENTS.acme }, acme);
    expect(rule).toBe("reminders.adaptToHistory");
    expect(why).toBe("firm at day 8 (threshold 7, 10 - 3 for a late-risk payer): Acme Corp 2 paid invoices: median 14 days late, 100% paid late, 1.5 reminders each");
    expect(explainStage("friendly", 5, DEFAULT_POLICY, { chase_override: "default", client: CLIENTS.harbor }, unknownProfile(CLIENTS.harbor.email))).toEqual({ why: "friendly at day 5 (threshold 3)", rule: "reminders" });
  });

  it("planCollections carries the prediction, the band and the why per proposal", () => {
    const plan = planCollections(invoices, DEFAULT_POLICY, now, "Han", transactions);
    const bluebird = plan.find((p) => p.invoice_number === "INV-0002")!; // 15 days overdue, late-risk payer
    expect(bluebird).toMatchObject({ stage: "firm", risk: "late-risk", rule: "reminders.adaptToHistory", thresholds: { friendly: 1, firm: 7, final: 18 } });
    expect(bluebird.predicted_pay_date).toBe("2026-10-01"); // due 09-23 + median 7.5 -> 8 days
    const harbor = plan.find((p) => p.invoice_number === "INV-0013")!;
    expect(harbor).toMatchObject({ risk: "unknown", rule: "reminders", thresholds: { friendly: 3, firm: 10, final: 21 } });
    // a late-risk payer 8 days overdue is already at firm; the same invoice from an unknown payer is still friendly
    const eightDays = { ...byNo("INV-0002"), due_date: "2026-09-30" };
    expect(planCollections([eightDays, ...invoices.filter((i) => i.status === "PAID")], DEFAULT_POLICY, now, "Han", transactions)[0].stage).toBe("firm");
    expect(planCollections([{ ...eightDays, client: CLIENTS.harbor }], DEFAULT_POLICY, now, "Han", transactions)[0].stage).toBe("friendly");
  });
});

describe("sandbox mapper", () => {
  it("reads paid_at from Invoicing v2 payments.transactions[].payment_date", () => {
    const inv = mapInvoice({ id: "INV2-X", status: "PAID", detail: { invoice_number: "INV-9", invoice_date: "2026-09-01", payment_term: { due_date: "2026-09-16" } }, amount: { value: "100.00" }, payments: { paid_amount: { value: "100.00" }, transactions: [{ payment_date: "2026-09-20", amount: { value: "40.00" } }, { payment_date: "2026-09-25", amount: { value: "60.00" } }] } });
    expect(inv.paid_at).toBe("2026-09-25");
    expect(payerProfiles([{ ...inv, client: { given_name: "A", surname: "B", email: "a@b.c" } }], []).get("a@b.c")).toMatchObject({ sample: 1, median_days_late: 9 });
  });
});

describe("agent loop: the cadence decision reaches the ledger", () => {
  beforeEach(() => resetStore(now));
  it("audits each history-shifted stage with reminders.adaptToHistory and the numbers", async () => {
    const r = await runOnce("Run collections", { unattended: true });
    const shifted = getStore().audit.filter((a) => a.rule === "reminders.adaptToHistory" && a.actor === "policy");
    expect(shifted.length).toBeGreaterThanOrEqual(2); // Acme INV-0001 (final) and Bluebird INV-0002 / INV-0010
    // the run uses the real clock, so the stage depends on today's date; the shift and its direction do not
    expect(shifted.map((a) => a.action)).toEqual(expect.arrayContaining([expect.stringMatching(/^INV-0002 Bluebird Studio: (firm|final) stage brought forward by payer history$/)]));
    expect(shifted.find((a) => a.action.startsWith("INV-0002"))?.reason).toContain("Bluebird Studio 2 paid invoices: median 8 days late");
    expect(r.text).toContain("late-risk payer");
    const lookup = await runOnce("Set up a $1,500 monthly retainer for Acme Corp", { unattended: true });
    expect(lookup.toolCalls[0]).toBe("lookup_customer");
  });
});
