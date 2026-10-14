/**
 * End-to-end agent loop with zero keys: mock planner model + mock PayPal + real policy gate,
 * through the real AI SDK generateText loop (same wiring as /api/agent and the cron sweep).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { agentSetup, runOnce } from "@/lib/agent/run";
import { detectIntent, parseAmount, parseClient } from "@/lib/llm/mock-model";
import { getStore, resetStore } from "@/lib/store";

const inv = (n: string) => getStore().mock.invoices.find((i) => i.invoice_number === n)!;

beforeEach(() => {
  resetStore(new Date());
});

describe("mock planner parsing", () => {
  it("detects intents and entities", () => {
    expect(detectIntent("Run collections")).toBe("collections");
    expect(detectIntent("Reconcile payments")).toBe("reconcile");
    expect(detectIntent("Review disputes")).toBe("disputes");
    expect(detectIntent("Refund $600 on INV-0007")).toBe("refund");
    expect(detectIntent("I finished the logo package for Acme Corp, $1,200, net 15")).toBe("invoice");
    expect(detectIntent("Set up a $1,500 monthly retainer for Northwind Traders")).toBe("subscription");
    expect(detectIntent("Pause chasing INV-0003")).toBe("override");
    expect(detectIntent("What's outstanding?")).toBe("status");
    expect(parseAmount("I finished the logo package for Acme Corp, $1,200, net 15")).toBe(1200);
    expect(parseClient("I finished the logo package for Acme Corp, $1,200, net 15")).toBe("Acme Corp");
    expect(parseClient("Set up a $1,500 monthly retainer for Northwind Traders")).toBe("Northwind Traders");
  });
});

describe("agent loop (no keys)", () => {
  it("creates and sends an invoice for an existing client", async () => {
    const before = getStore().mock.invoices.length;
    const r = await runOnce("I finished the logo package for Acme Corp, $1,200, net 15");
    expect(r.toolCalls).toEqual(["lookup_customer", "create_invoice", "send_invoice"]);
    expect(getStore().mock.invoices.length).toBe(before + 1);
    const created = getStore().mock.invoices[0];
    expect(created).toMatchObject({ status: "UNPAID", total: 1200, client: { email: "billing@acme.example", business: "Acme Corp" } });
    expect(created.items[0].name).toMatch(/logo package/i);
    expect(r.text).toContain("$1,200.00");
    expect(getStore().audit.some((a) => a.tool === "create_invoice" && a.decision === "allowed")).toBe(true);
  });

  it("runs collections under the policy and records reminders", async () => {
    const r = await runOnce("Run collections", { unattended: true });
    expect(r.toolCalls[0]).toBe("propose_collections");
    const sends = r.toolCalls.filter((t) => t === "send_invoice_reminder");
    expect(sends.length).toBeGreaterThanOrEqual(6);
    expect(inv("INV-0001").reminders.at(-1)?.stage).toBe("final");
    expect(inv("INV-0002").reminders.at(-1)?.stage).toBe("firm");
    expect(inv("INV-0003").reminders.at(-1)?.stage).toBe("friendly");
    expect(inv("INV-0004").reminders.length).toBe(0);
    expect(r.text).toMatch(/Collections run complete: \d+ of \d+ reminder/);
    // second run: nothing new to send; the after-final pass still runs (its money-affecting resolutions wait for approval)
    const again = await runOnce("Run collections", { unattended: true });
    expect(again.toolCalls.slice(0, 2)).toEqual(["propose_collections", "propose_after_final"]);
    expect(again.toolCalls).not.toContain("send_invoice_reminder");
    expect(again.text).toContain("Nothing to chase");
  });

  it("reconciles unmatched payments including partial and combined", async () => {
    const r = await runOnce("Reconcile payments", { unattended: true });
    expect(r.toolCalls.filter((t) => t === "record_payment_for_invoice").length).toBe(4);
    expect(inv("INV-0013").status).toBe("PAID");
    expect(inv("INV-0014")).toMatchObject({ status: "PARTIALLY_PAID", due: 340 });
    expect(inv("INV-0015").status).toBe("PAID");
    expect(inv("INV-0016").status).toBe("PAID");
    expect(getStore().mock.transactions.filter((t) => t.type === "PAYMENT" && !t.invoice_id)).toEqual([]);
  });

  it("accepts small disputes and drafts evidence for large ones", async () => {
    const r = await runOnce("Review disputes", { unattended: true });
    expect(r.toolCalls).toContain("accept_dispute_claim");
    expect(r.toolCalls).toContain("draft_dispute_evidence");
    const d = getStore().mock.disputes;
    expect(d.find((x) => x.id === "PP-D-MOCK-00015")).toMatchObject({ status: "RESOLVED", outcome: "ACCEPTED_BY_SELLER" });
    expect(d.find((x) => x.id === "PP-D-MOCK-00480")?.status).toBe("REQUIRED_ACTION");
    expect(d.find((x) => x.id === "PP-D-MOCK-00480")?.evidence_draft).toContain("Team workshop");
  });

  it("blocks a large refund in an unattended run and explains why", async () => {
    const r = await runOnce("Refund $600 on INV-0007", { unattended: true });
    expect(r.toolCalls).toEqual(["lookup_customer", "create_refund"]);
    expect(inv("INV-0007").refunded).toBe(0);
    expect(r.text).toMatch(/not done/i);
    expect(getStore().audit.some((a) => a.decision === "approval-required" && a.tool === "create_refund")).toBe(true);
  });

  it("asks a human for the same refund in interactive mode", async () => {
    const setup = agentSetup();
    const verdict = await setup.toolApproval({ toolCall: { toolName: "create_refund", input: { capture_id: "x", amount: { currency_code: "USD", value: "600.00" } } } });
    expect(verdict).toMatchObject({ type: "user-approval" });
    const small = await setup.toolApproval({ toolCall: { toolName: "create_refund", input: { capture_id: "x", amount: { currency_code: "USD", value: "60.00" } } } });
    expect(small).toMatchObject({ type: "approved" });
  });

  it("sets up a retainer subscription and adds shipment tracking", async () => {
    const sub = await runOnce("Set up a $1,500 monthly retainer for Northwind Traders", { unattended: true });
    expect(sub.toolCalls).toEqual(["lookup_customer", "create_product", "create_subscription_plan", "create_subscription"]);
    expect(getStore().mock.subscriptions[0]).toMatchObject({ status: "APPROVAL_PENDING", subscriber_email: "ap@northwind.example" });
    expect(sub.text).toContain("approval link");
    const track = await runOnce("Shipped the brand book for Northwind Traders, UPS 1Z999AA10123456785", { unattended: true });
    expect(track.toolCalls).toEqual(["lookup_customer", "create_shipment_tracking"]);
    expect(getStore().mock.trackings[0]).toMatchObject({ tracking_number: "1Z999AA10123456785", carrier: "UPS" });
  });

  it("pauses chasing and reports status", async () => {
    const p = await runOnce("Pause chasing INV-0003", { unattended: true });
    expect(p.toolCalls).toEqual(["set_chase_override"]);
    expect(inv("INV-0003").chase_override).toBe("paused");
    const s = await runOnce("What's outstanding?", { unattended: true });
    expect(s.toolCalls).toEqual(["summarize_receivables"]);
    expect(s.text).toMatch(/outstanding across \d+ open invoices/);
  });
});
