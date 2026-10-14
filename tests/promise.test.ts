/**
 * Promise to pay: reply classifier -> record_promise -> chasing pauses -> broken promise escalates with the
 * promise cited. Status is derived (open / kept / broken), never stored.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { planCollections } from "@/lib/agent/chase";
import { classifyReply, parsePayBy, promiseStatus } from "@/lib/agent/promise";
import { runOnce } from "@/lib/agent/run";
import { detectIntent } from "@/lib/llm/mock-model";
import { buildInvoices, buildTransactions, CLIENTS } from "@/lib/paypal/fixtures";
import { evaluateAction } from "@/lib/policy/engine";
import { DEFAULT_POLICY, parsePolicy } from "@/lib/policy/schema";
import { getStore, resetStore } from "@/lib/store";

const now = new Date("2026-10-13T12:00:00Z"); // a Tuesday
const invoices = buildInvoices(now);
const transactions = buildTransactions(now, invoices);
const byNo = (n: string) => invoices.find((i) => i.invoice_number === n)!;
const plusDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10);

describe("parsePayBy", () => {
  it("resolves the date phrases clients actually write", () => {
    expect(parsePayBy("we'll pay by the 20th", now)).toBe("2026-10-20");
    expect(parsePayBy("payment goes out Oct 20", now)).toBe("2026-10-20");
    expect(parsePayBy("on the 20th of October", now)).toBe("2026-10-20");
    expect(parsePayBy("by 2026-11-02", now)).toBe("2026-11-02");
    expect(parsePayBy("by 10/20", now)).toBe("2026-10-20");
    expect(parsePayBy("tomorrow", now)).toBe("2026-10-14");
    expect(parsePayBy("end of month", now)).toBe("2026-10-31");
    expect(parsePayBy("next week", now)).toBe("2026-10-20");
    expect(parsePayBy("by Friday", now)).toBe("2026-10-16");
    expect(parsePayBy("next Friday", now)).toBe("2026-10-23");
    expect(parsePayBy("in 5 days", now)).toBe("2026-10-18");
    expect(parsePayBy("within two weeks", now)).toBe("2026-10-27");
    expect(parsePayBy("on the 5th", now)).toBe("2026-11-05"); // already passed this month -> next month
    expect(parsePayBy("thanks for the invoice", now)).toBeUndefined();
  });
});

describe("classifyReply", () => {
  it("separates promises, paid claims, objections and noise", () => {
    expect(classifyReply("Sorry for the delay, we'll pay the rest by the 20th.", now)).toMatchObject({ kind: "promise", pay_by: "2026-10-20", amount: undefined });
    expect(classifyReply("Sending $500 on Friday, the remainder next month", now)).toMatchObject({ kind: "promise", pay_by: "2026-10-16", amount: 500 });
    expect(classifyReply("We already paid this yesterday via PayPal", now)).toMatchObject({ kind: "paid-claim" });
    expect(classifyReply("We dispute this - the logo was never delivered", now).kind).toBe("dispute");
    expect(classifyReply("Can you resend the PDF?", now).kind).toBe("unknown");
    const noDate = classifyReply("Will pay, just waiting on our client", now);
    expect(noDate.kind).toBe("promise");
    expect(noDate.pay_by).toBeUndefined();
  });
});

describe("promiseStatus (derived)", () => {
  it("is open before pay_by + grace, broken after, kept once the balance moved or the invoice closed", () => {
    expect(promiseStatus(byNo("INV-0006"), now, DEFAULT_POLICY)).toBe("open"); // pay_by in 4 days
    expect(promiseStatus(byNo("INV-0014"), now, DEFAULT_POLICY)).toBe("broken"); // pay_by 5 days ago
    expect(promiseStatus(byNo("INV-0014"), now, parsePolicy({ promises: { graceDays: 10 } }))).toBe("open");
    expect(promiseStatus({ ...byNo("INV-0006"), status: "PAID", due: 0 }, now, DEFAULT_POLICY)).toBe("kept");
    const partial = { ...byNo("INV-0006"), promise: { ...byNo("INV-0006").promise!, amount: 300 } };
    expect(promiseStatus({ ...partial, due: 700 }, now, DEFAULT_POLICY)).toBe("kept"); // 1000 -> 700
    expect(promiseStatus({ ...partial, due: 800 }, now, DEFAULT_POLICY)).toBe("open");
    expect(promiseStatus(byNo("INV-0002"), now, DEFAULT_POLICY)).toBeUndefined();
  });
});

describe("planCollections with promises", () => {
  const plan = planCollections(invoices, DEFAULT_POLICY, now, "Han", transactions);
  it("pauses an invoice with an open promise and escalates a broken one, citing promises.brokenEscalates", () => {
    expect(plan.find((p) => p.invoice_number === "INV-0006")).toBeUndefined();
    const p14 = plan.find((p) => p.invoice_number === "INV-0014")!;
    expect(p14).toMatchObject({ stage: "firm", rule: "promises.brokenEscalates", broken_promise: { pay_by: plusDays(now, -5) } });
    expect(p14.why).toContain("was not kept");
    expect(p14.draft.subject).toContain(`promised by ${plusDays(now, -5)}`);
    expect(p14.draft.note).toContain("It has not arrived");
  });
  it("escalates one stage above what was sent even when the calendar would repeat the stage", () => {
    const inv = { ...byNo("INV-0014"), due_date: plusDays(now, -5), reminders: [{ at: plusDays(now, -4) + "T00:00:00Z", stage: "friendly" as const }] };
    const [p] = planCollections([inv], DEFAULT_POLICY, now, "Han", transactions); // 5 days overdue = friendly by calendar, friendly already sent
    expect(p).toMatchObject({ stage: "firm", rule: "promises.brokenEscalates" });
    const final = { ...inv, reminders: [...inv.reminders, { at: plusDays(now, -3) + "T00:00:00Z", stage: "firm" as const }] };
    expect(planCollections([final], DEFAULT_POLICY, now, "Han", transactions)[0]?.stage).toBe("final");
  });
  it("honours the policy switches", () => {
    const noPause = planCollections(invoices, parsePolicy({ promises: { pauseChasing: false } }), now, "Han", transactions);
    expect(noPause.find((p) => p.invoice_number === "INV-0006")?.stage).toBe("firm");
    const noEscalate = planCollections(invoices, parsePolicy({ promises: { brokenEscalates: false } }), now, "Han", transactions);
    expect(noEscalate.find((p) => p.invoice_number === "INV-0014")).toMatchObject({ stage: "firm", rule: "reminders", broken_promise: undefined });
  });
});

describe("policy engine", () => {
  const ctx = { policy: DEFAULT_POLICY, invoices, disputes: [], now };
  it("denies a reminder while a promise is open and cites promises.pauseChasing", () => {
    expect(evaluateAction("send_invoice_reminder", { invoice_id: byNo("INV-0006").id }, ctx)).toMatchObject({ decision: "deny", rule: "promises.pauseChasing", reason: expect.stringContaining(`promised to pay INV-0006 by ${plusDays(now, 4)}`) });
    expect(evaluateAction("send_invoice_reminder", { invoice_id: byNo("INV-0014").id }, ctx).decision).toBe("allow"); // broken: chase resumes
    expect(evaluateAction("send_invoice_reminder", { invoice_id: byNo("INV-0006").id }, { ...ctx, policy: parsePolicy({ promises: { pauseChasing: false } }) }).decision).toBe("allow");
  });
  it("records promises inside promises.maxDays, asks beyond it, refuses the past", () => {
    const id = byNo("INV-0002").id;
    expect(evaluateAction("record_promise", { invoice_id: id, pay_by: plusDays(now, 10) }, ctx)).toMatchObject({ decision: "allow", rule: "promises.maxDays" });
    expect(evaluateAction("record_promise", { invoice_id: id, pay_by: plusDays(now, 45) }, ctx)).toMatchObject({ decision: "approve", reason: expect.stringContaining("45 days out") });
    expect(evaluateAction("record_promise", { invoice_id: id, pay_by: plusDays(now, -2) }, ctx).decision).toBe("deny");
    expect(evaluateAction("record_promise", { invoice_id: id, pay_by: plusDays(now, 5), amount: 9999 }, ctx).decision).toBe("approve");
    expect(evaluateAction("record_promise", { invoice_id: id }, ctx).decision).toBe("deny");
    expect(evaluateAction("classify_client_reply", { text: "x" }, ctx).decision).toBe("allow");
  });
});

describe("agent loop (no keys)", () => {
  beforeEach(() => resetStore(new Date()));
  const inv = (n: string) => getStore().mock.invoices.find((i) => i.invoice_number === n)!;
  const real = new Date();

  it("classifies a relayed reply, records the promise, pauses the chase, and the ledger cites the rule", async () => {
    expect(detectIntent("Harbor & Finch replied about INV-0013: we will pay by the 20th")).toBe("promise");
    const r = await runOnce(`Harbor & Finch replied about INV-0013: "Apologies, we will pay this by ${plusDays(real, 10)}."`, { unattended: true });
    expect(r.toolCalls).toEqual(["classify_client_reply", "record_promise"]);
    expect(inv("INV-0013").promise).toMatchObject({ pay_by: plusDays(real, 10), source: "client_reply", balance_at_record: 1350 });
    expect(r.text).toContain(`by ${plusDays(real, 10)}`);
    expect(getStore().audit.find((a) => a.tool === "record_promise")).toMatchObject({ decision: "allowed", rule: "promises.maxDays" });
    const run = await runOnce("Run collections", { unattended: true });
    expect(run.toolCalls.filter((t) => t === "send_invoice_reminder").length).toBeGreaterThan(0);
    expect(inv("INV-0013").reminders.length).toBe(0);
    expect(run.text).toMatch(/INV-0013 \(promise to pay by/);
    expect(inv("INV-0014").reminders.at(-1)?.subject).toContain("promised by");
  });

  it("finds the client's oldest open invoice when no number is given, and refuses a promise too far out unattended", async () => {
    const r = await runOnce(`Acme says they'll pay $2,000 on ${plusDays(real, 7)}`, { unattended: true });
    expect(r.toolCalls).toEqual(["classify_client_reply", "lookup_customer", "record_promise"]);
    expect(inv("INV-0001").promise).toMatchObject({ amount: 2000 });
    const far = await runOnce(`Bluebird Studio replied about INV-0002: will pay by ${plusDays(real, 60)}`, { unattended: true });
    expect(inv("INV-0002").promise).toBeUndefined();
    expect(far.text).toMatch(/Needs human approval/);
    expect(getStore().audit.some((a) => a.tool === "record_promise" && a.decision === "approval-required" && a.rule === "promises.maxDays")).toBe(true);
  });

  it("does not record anything for a paid claim or an objection", async () => {
    const paid = await runOnce(`Juniper Bakery replied about INV-0012: "We already paid this yesterday"`, { unattended: true });
    expect(paid.toolCalls).toEqual(["classify_client_reply"]);
    expect(paid.text).toContain("reconcile payments");
    const obj = await runOnce(`Vireo Labs replied about INV-0015: "We dispute this, the wireframes were never delivered"`, { unattended: true });
    expect(obj.text).toContain("objection");
    expect(inv("INV-0015").promise).toBeUndefined();
    expect(CLIENTS.vireo.email).toBe(inv("INV-0015").client.email);
  });
});
