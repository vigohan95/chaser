/**
 * Viewed-aware chasing: PayPal's Invoicing v2 `detail.viewed_by_recipient` decides between a firmer reminder and a
 * re-delivery with an address check. Verified in the sandbox (docs/sandbox-evidence/VIEWED-BY-RECIPIENT.md): the
 * field is present on every invoice and false on all of ours, so the branch is data-driven and off when the field is absent.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { draftReminder, draftResend, planCollections, unviewedResend } from "@/lib/agent/chase";
import { runOnce } from "@/lib/agent/run";
import { buildInvoices, buildTransactions } from "@/lib/paypal/fixtures";
import { mapInvoice } from "@/lib/paypal/live";
import { mockExecute } from "@/lib/paypal/mock";
import { DEFAULT_POLICY, parsePolicy } from "@/lib/policy/schema";
import { getStore, resetStore } from "@/lib/store";

const now = new Date("2026-10-13T12:00:00Z");
const invoices = buildInvoices(now);
const transactions = buildTransactions(now, invoices);
const byNo = (n: string) => invoices.find((i) => i.invoice_number === n)!;

describe("mapInvoice / fixtures carry viewed_by_recipient", () => {
  it("reads the Invoicing v2 field and leaves it undefined when absent", () => {
    const base = { id: "INV2-X", status: "SENT", detail: { invoice_number: "INV-9", invoice_date: "2026-09-01" }, amount: { value: "100.00" } };
    expect(mapInvoice({ ...base, detail: { ...base.detail, viewed_by_recipient: false } }).viewed_by_recipient).toBe(false);
    expect(mapInvoice({ ...base, detail: { ...base.detail, viewed_by_recipient: true } }).viewed_by_recipient).toBe(true);
    expect(mapInvoice(base).viewed_by_recipient).toBeUndefined();
    // the sandbox shape recorded on 2026-10-14: present and false on every sent invoice
    expect(mapInvoice({ id: "INV2-SUGV-GSTF-ZGG2-P5P8", status: "SENT", detail: { invoice_number: "INV-0010", invoice_date: "2026-08-26", viewed_by_recipient: false, payment_term: { term_type: "NO_DUE_DATE" } }, amount: { value: "420.00" } }).viewed_by_recipient).toBe(false);
  });
  it("demo data: most open invoices were opened, a few never were, drafts carry no flag", () => {
    expect(byNo("INV-0001").viewed_by_recipient).toBe(true);
    expect(byNo("INV-0002").viewed_by_recipient).toBe(false);
    expect(byNo("INV-0017").viewed_by_recipient).toBeUndefined(); // draft
  });
  it("the mock get_invoice response is sandbox-shaped (detail.viewed_by_recipient)", async () => {
    resetStore(now);
    const pp = (await mockExecute("get_invoice", { invoice_id: "INV-0002" })) as { detail: { viewed_by_recipient?: boolean } };
    expect(pp.detail.viewed_by_recipient).toBe(false);
  });
});

describe("unviewedResend + planCollections", () => {
  it("re-delivers a never-opened invoice once it is unviewedAfterDays overdue, cites reminders.unviewedStrategy, and keeps the stage", () => {
    expect(unviewedResend({ viewed_by_recipient: false }, 5, DEFAULT_POLICY)).toBe(true);
    expect(unviewedResend({ viewed_by_recipient: false }, 4, DEFAULT_POLICY)).toBe(false);
    expect(unviewedResend({ viewed_by_recipient: true }, 30, DEFAULT_POLICY)).toBe(false);
    expect(unviewedResend({ viewed_by_recipient: undefined }, 30, DEFAULT_POLICY)).toBe(false); // field absent: no branch
    expect(unviewedResend({ viewed_by_recipient: false }, 30, parsePolicy({ reminders: { unviewedStrategy: "ignore" } }))).toBe(false);
    expect(unviewedResend({ viewed_by_recipient: false }, 30, parsePolicy({ reminders: { viewedAware: false } }))).toBe(false);

    const plan = planCollections(invoices, DEFAULT_POLICY, now, "Han", transactions);
    const p2 = plan.find((p) => p.invoice_number === "INV-0002")!; // 15 days overdue, never opened, late-risk payer -> firm by calendar (firm at 7, final at 18)
    expect(p2).toMatchObject({ channel: "resend", viewed: false, stage: "firm", rule: "reminders.adaptToHistory", channel_rule: "reminders.unviewedStrategy" });
    expect(p2.why).toContain("never opened (viewed_by_recipient = false) after 15 days");
    expect(p2.draft.subject).toBe("Resending: 15 days overdue: invoice INV-0002 ($2,400.00) - did this reach you?");
    expect(p2.draft.note).toContain("if hello@bluebird.example is not the best address");
    const p1 = plan.find((p) => p.invoice_number === "INV-0001")!; // opened
    expect(p1).toMatchObject({ channel: "reminder", viewed: true });
    expect(p1.draft.note).toContain("PayPal shows the invoice has been opened");
    const ignore = planCollections(invoices, parsePolicy({ reminders: { unviewedStrategy: "ignore" } }), now, "Han", transactions).find((p) => p.invoice_number === "INV-0002")!;
    expect(ignore).toMatchObject({ channel: "reminder", stage: "firm", channel_rule: undefined });
    expect(ignore.draft.subject).toContain("Overdue: invoice INV-0002");
  });
  it("a broken promise outranks the viewed signal; the resend subject still carries the stage words", () => {
    const inv = { ...byNo("INV-0014"), viewed_by_recipient: false }; // broken promise, 13 days overdue
    const [p] = planCollections([inv], DEFAULT_POLICY, now, "Han", transactions);
    expect(p).toMatchObject({ channel: "reminder", rule: "promises.brokenEscalates" });
    expect(draftResend(byNo("INV-0002"), "firm", 12, "Han").subject).toMatch(/^Resending: 12 days overdue/);
    expect(draftReminder(byNo("INV-0001"), "firm", 12, "Han", undefined, false).note).not.toContain("has been opened");
  });
});

describe("agent loop", () => {
  beforeEach(() => resetStore(new Date()));
  it("sends the re-delivery through send_invoice_reminder, records the stage, and the ledger cites the rule", async () => {
    const r = await runOnce("Run collections", { unattended: true });
    const inv2 = getStore().mock.invoices.find((i) => i.invoice_number === "INV-0002")!;
    expect(inv2.reminders.at(-1)?.subject).toContain("did this reach you?");
    expect(inv2.reminders.at(-1)?.stage).toBe("firm");
    expect(getStore().audit.find((a) => a.rule === "reminders.unviewedStrategy")?.action).toContain("INV-0002 Bluebird Studio: never opened on PayPal, re-delivered");
    expect(r.text).toContain("never opened on PayPal");
  });
});
