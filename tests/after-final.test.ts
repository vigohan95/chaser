/**
 * After the final notice: collections.afterFinal decides write-off / settlement offer / hand-off pack, each gated by the
 * policy engine where money is affected; per-client statement of account.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { decideAfterFinal, planAfterFinal } from "@/lib/agent/after-final";
import { localTools } from "@/lib/agent/local-tools";
import { agentSetup, runOnce } from "@/lib/agent/run";
import { buildHandoffPack, buildStatement } from "@/lib/agent/statement";
import { detectIntent } from "@/lib/llm/mock-model";
import { buildInvoices, buildTransactions, CLIENTS } from "@/lib/paypal/fixtures";
import { evaluateAction } from "@/lib/policy/engine";
import { DEFAULT_POLICY, parsePolicy } from "@/lib/policy/schema";
import { getStore, resetStore } from "@/lib/store";

const now = new Date("2026-10-13T12:00:00Z");
const invoices = buildInvoices(now);
const transactions = buildTransactions(now, invoices);
const byNo = (n: string) => invoices.find((i) => i.invoice_number === n)!;
const merchant = { businessName: "Vigo Design Studio", givenName: "Han", surname: "Vigo", email: "han@vigo.example" };
const ctx = { invoices, transactions, now, merchant, policy: DEFAULT_POLICY };
const opts = { toolCallId: "t", messages: [] } as unknown as Parameters<NonNullable<typeof localTools.resolve_after_final.execute>>[1];

describe("planAfterFinal on the demo book", () => {
  it("picks write-off, settlement or hand-off by balance once the final notice is waitDays old", () => {
    const plan = planAfterFinal(invoices, DEFAULT_POLICY, now);
    expect(plan.map((p) => [p.invoice_number, p.resolution])).toEqual([
      ["INV-0026", "handoff"], // $2,600 Northwind, final 20 days ago
      ["INV-0010", "settlement"], // $420 Bluebird, final 9 days ago
      ["INV-0025", "write_off"], // $38 Pinecrest, final 12 days ago
    ]);
    const settle = plan.find((p) => p.invoice_number === "INV-0010")!;
    expect(settle).toMatchObject({ offer_amount: 378, offer_percent: 10, rule: "collections.afterFinal.settlementOfferPercent", days_since_final: 9 });
    expect(settle.why).toContain("final notice sent 9 days ago (wait 7)");
    expect(plan.find((p) => p.invoice_number === "INV-0025")).toMatchObject({ rule: "collections.afterFinal.writeOffUnder", amount_due: 38 });
    expect(plan.find((p) => p.invoice_number === "INV-0026")).toMatchObject({ rule: "collections.afterFinal.handoff" });
    expect(plan.find((p) => p.invoice_number === "INV-0001")).toBeUndefined(); // only a friendly sent
  });
  it("respects the waiting period, pauses, promises, existing resolutions and the policy numbers", () => {
    expect(planAfterFinal(invoices, parsePolicy({ collections: { afterFinal: { waitDays: 10 } } }), now).map((p) => p.invoice_number)).toEqual(["INV-0026", "INV-0025"]);
    const paused = invoices.map((i) => (i.invoice_number === "INV-0026" ? { ...i, chase_override: "paused" as const } : i));
    expect(planAfterFinal(paused, DEFAULT_POLICY, now).find((p) => p.invoice_number === "INV-0026")).toBeUndefined();
    const promised = invoices.map((i) => (i.invoice_number === "INV-0010" ? { ...i, promise: { pay_by: "2026-10-20", balance_at_record: 420, recorded_at: now.toISOString(), source: "user" as const } } : i));
    expect(planAfterFinal(promised, DEFAULT_POLICY, now).find((p) => p.invoice_number === "INV-0010")).toBeUndefined();
    const resolved = invoices.map((i) => (i.invoice_number === "INV-0025" ? { ...i, resolution: { kind: "write_off" as const, at: now.toISOString(), amount: 38, rule: "x" } } : i));
    expect(planAfterFinal(resolved, DEFAULT_POLICY, now).find((p) => p.invoice_number === "INV-0025")).toBeUndefined();
    expect(decideAfterFinal({ due: 420 }, parsePolicy({ collections: { afterFinal: { writeOffUnder: 500 } } })).resolution).toBe("write_off");
    expect(decideAfterFinal({ due: 420 }, parsePolicy({ collections: { afterFinal: { settlementOfferPercent: 0 } } })).resolution).toBe("handoff");
    expect(decideAfterFinal({ due: 2600 }, parsePolicy({ collections: { afterFinal: { settlementMaxBalance: 5000, settlementOfferPercent: 15 } } }))).toMatchObject({ resolution: "settlement", offer_amount: 2210 });
  });
});

describe("policy engine: resolve_after_final", () => {
  const ectx = { policy: DEFAULT_POLICY, invoices, disputes: [], now };
  it("asks before money moves, allows a hand-off pack only when the policy says auto, denies what the thresholds forbid", () => {
    expect(evaluateAction("resolve_after_final", { invoice_id: "INV-0025", resolution: "write_off" }, ectx)).toMatchObject({ decision: "approve", rule: "collections.afterFinal.writeOffUnder" });
    expect(evaluateAction("resolve_after_final", { invoice_id: "INV-0010", resolution: "write_off" }, ectx)).toMatchObject({ decision: "deny", reason: expect.stringContaining("$50.00") });
    expect(evaluateAction("resolve_after_final", { invoice_id: "INV-0010", resolution: "settlement" }, ectx)).toMatchObject({ decision: "approve", rule: "collections.afterFinal.settlementOfferPercent", reason: expect.stringContaining("$378.00") });
    expect(evaluateAction("resolve_after_final", { invoice_id: "INV-0010", resolution: "settlement" }, { ...ectx, policy: parsePolicy({ collections: { afterFinal: { settlementOfferPercent: 0 } } }) }).decision).toBe("deny");
    expect(evaluateAction("resolve_after_final", { invoice_id: "INV-0026", resolution: "handoff" }, ectx)).toMatchObject({ decision: "approve", rule: "collections.afterFinal.handoff" });
    expect(evaluateAction("resolve_after_final", { invoice_id: "INV-0026", resolution: "handoff" }, { ...ectx, policy: parsePolicy({ collections: { afterFinal: { handoff: "auto" } } }) }).decision).toBe("allow");
    expect(evaluateAction("propose_after_final", {}, ectx).decision).toBe("allow");
    expect(evaluateAction("get_statement_of_account", { query: "x" }, ectx).decision).toBe("allow");
  });
});

describe("statement of account and hand-off pack", () => {
  it("lists the client's open invoices with aging, one total and the settled history", () => {
    const st = buildStatement(CLIENTS.pinecrest.email, ctx)!;
    expect(st).toMatchObject({ open_invoices: 1, total_open: 38, total_overdue: 38 });
    expect(st.buckets["31-60"]).toBe(38); // due 46 days ago
    expect(st.markdown).toContain("# Statement of account - Pinecrest Realty");
    expect(st.markdown).toContain("**Balance due: $38.00** across 1 open invoice");
    expect(st.markdown).toContain("| INV-0025 |");
    expect(st.markdown).toContain("| INV-0007 |"); // settled
    expect(st.markdown).toContain("3 reminders");
    expect(st.markdown).toMatch(/Payment record: 2 paid invoices/);
    expect(buildStatement("nobody@x.example", ctx)).toBeUndefined();
    const vireo = buildStatement(CLIENTS.vireo.email, ctx)!;
    expect(vireo.total_open).toBe(1400);
    expect(vireo.markdown).toContain("One payment of **$1,400.00** settles everything above");
  });
  it("the hand-off pack carries the debt, payments, chase history, evidence and the statement", () => {
    const pack = buildHandoffPack(byNo("INV-0026"), ctx);
    expect(pack).toContain("# Hand-off pack - invoice INV-0026 ($2,600.00 outstanding)");
    expect(pack).toContain("Trade show booth graphics");
    expect(pack).toContain("final reminder sent through PayPal");
    expect(pack).toContain("## 4. Evidence available");
    expect(pack).toContain("## Appendix: Statement of account - Northwind Traders");
    const withPromise = buildHandoffPack(byNo("INV-0014"), ctx);
    expect(withPromise).toContain("promise broken");
    expect(withPromise).toContain("the recipient opened the invoice");
    expect(buildHandoffPack(byNo("INV-0002"), ctx)).toContain("never opened by the recipient");
  });
});

describe("tools and agent loop (no keys)", () => {
  beforeEach(() => resetStore(new Date()));
  const inv = (n: string) => getStore().mock.invoices.find((i) => i.invoice_number === n)!;

  it("run collections also proposes after-final resolutions; money-affecting ones wait for approval in an unattended run", async () => {
    const r = await runOnce("Run collections", { unattended: true });
    expect(r.toolCalls).toContain("propose_after_final");
    expect(r.toolCalls.filter((t) => t === "resolve_after_final").length).toBe(3);
    expect(inv("INV-0025").status).toBe("UNPAID");
    expect(inv("INV-0026").resolution).toBeUndefined();
    const asked = getStore().audit.filter((a) => a.tool === "resolve_after_final" && a.decision === "approval-required");
    expect(asked.map((a) => a.rule).sort()).toEqual(["collections.afterFinal.handoff", "collections.afterFinal.settlementOfferPercent", "collections.afterFinal.writeOffUnder"]);
    expect(r.text).toMatch(/After the final notice/);
  });

  it("hand-off runs unattended when the policy says auto, and the pack lands on the invoice", async () => {
    getStore().policy.collections.afterFinal.handoff = "auto";
    const r = await runOnce("Run collections", { unattended: true });
    expect(inv("INV-0026").resolution).toMatchObject({ kind: "handoff", rule: "collections.afterFinal.handoff" });
    expect(inv("INV-0026").resolution!.pack).toContain("# Hand-off pack - invoice INV-0026");
    expect(inv("INV-0026").chase_override).toBe("paused");
    expect(r.text).toContain("hand-off pack built");
    getStore().policy.collections.afterFinal.handoff = "ask";
  });

  it("write-off cancels the invoice; a settlement sends a discounted replacement and pauses the original", async () => {
    const wo = (await localTools.resolve_after_final.execute!({ invoice_id: "INV-0025", resolution: "write_off" }, opts)) as { resolution: { kind: string; amount: number } };
    expect(wo.resolution).toMatchObject({ kind: "write_off", amount: 38 });
    expect(inv("INV-0025")).toMatchObject({ status: "CANCELLED" });
    expect(inv("INV-0025").resolution?.kind).toBe("write_off");
    expect(getStore().audit.find((a) => a.tool === "resolve_after_final")?.rule).toBe("collections.afterFinal.writeOffUnder");

    const before = getStore().mock.invoices.length;
    const se = (await localTools.resolve_after_final.execute!({ invoice_id: "INV-0010", resolution: "settlement" }, opts)) as { resolution: { kind: string; offer_amount: number; offer_invoice_number: string } };
    expect(se.resolution).toMatchObject({ kind: "settlement", offer_amount: 378 });
    expect(getStore().mock.invoices.length).toBe(before + 1);
    const offer = getStore().mock.invoices.find((i) => i.invoice_number === se.resolution.offer_invoice_number)!;
    expect(offer).toMatchObject({ status: "UNPAID", total: 378, client: { email: CLIENTS.bluebird.email } });
    expect(offer.items[0].name).toContain("Settlement of INV-0010");
    expect(inv("INV-0010")).toMatchObject({ chase_override: "paused", status: "UNPAID" });
    expect(inv("INV-0010").resolution).toMatchObject({ kind: "settlement", offer_invoice_id: offer.id });
    // nothing is proposed twice
    expect(((await localTools.propose_after_final.execute!({}, opts)) as { proposals: unknown[] }).proposals.map((p) => (p as { invoice_number: string }).invoice_number)).toEqual(["INV-0026"]);
  });

  it("interactive: the approval card for a write-off cites the rule; statement intent returns the client's statement", async () => {
    const setup = agentSetup();
    expect(await setup.toolApproval({ toolCall: { toolName: "resolve_after_final", input: { invoice_id: "INV-0025", resolution: "write_off" } } })).toMatchObject({ type: "user-approval", reason: expect.stringContaining("write-off") });
    expect(detectIntent("Statement of account for Pinecrest Realty")).toBe("statement");
    const r = await runOnce("Statement of account for Pinecrest Realty", { unattended: true });
    expect(r.toolCalls).toEqual(["get_statement_of_account"]);
    expect(r.text).toContain("INV-0025");
    expect(r.text).toContain("$38.00");
    expect(detectIntent("Write off INV-0025")).toBe("afterfinal");
    const wo = await runOnce("Write off INV-0025", { unattended: true });
    expect(wo.toolCalls).toEqual(["resolve_after_final"]);
    expect(wo.text).toMatch(/Needs human approval/);
  });
});
