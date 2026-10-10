/**
 * Dispute evidence pack end to end: builder (pure), the Disputes API call path (provide-evidence vs send-message,
 * multipart body), and the agent flow under each disputes.submitEvidence policy setting.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEvidencePack, evidenceTypeFor, invoiceForDispute } from "@/lib/agent/evidence";
import { agentSetup, runOnce } from "@/lib/agent/run";
import { buildDisputes, buildInvoices, buildTrackings, buildTransactions } from "@/lib/paypal/fixtures";
import { submitDisputeEvidence } from "@/lib/paypal/rest";
import { evaluateAction } from "@/lib/policy/engine";
import { parsePolicy } from "@/lib/policy/schema";
import { getStore, resetStore } from "@/lib/store";

const now = new Date("2026-10-10T12:00:00Z");
const invoices = buildInvoices(now);
const transactions = buildTransactions(now, invoices);
const disputes = buildDisputes(now, invoices, transactions);
const trackings = buildTrackings(now, invoices, transactions);
const merchant = { businessName: "Vigo Design Studio", givenName: "Han", surname: "Vigo", email: "x@y.z" };

describe("buildEvidencePack", () => {
  it("assembles invoice, payment, delivery and statement for the $480 dispute", () => {
    const d = disputes.find((x) => x.id === "PP-D-MOCK-00480")!;
    const pack = buildEvidencePack(d, { invoices, transactions, trackings, merchant });
    expect(pack.invoice_number).toBe("INV-0019");
    expect(pack.evidence_type).toBe("ITEM_DESCRIPTION");
    expect(pack.tracking).toBeUndefined();
    expect(pack.draft).toContain("Team workshop");
    expect(pack.draft).toContain("$480.00 received");
    expect(pack.draft).toContain("Vigo Design Studio delivered");
    expect(pack.notes.length).toBeLessThanOrEqual(2000);
    expect(pack.attachments_suggested.length).toBeGreaterThan(0);
  });
  it("attaches shipment tracking as proof of fulfilment when the sale was shipped", () => {
    const inv11 = invoices.find((i) => i.invoice_number === "INV-0011")!;
    const t11 = transactions.find((t) => t.invoice_id === inv11.id)!;
    const d = { ...disputes[1], id: "PP-D-TEST-SHIP", transaction_id: t11.id, invoice_id: inv11.id, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", buyer_email: inv11.client.email };
    const pack = buildEvidencePack(d, { invoices, transactions, trackings, merchant });
    expect(pack.evidence_type).toBe("PROOF_OF_FULFILLMENT");
    expect(pack.tracking).toEqual({ carrier_name: "UPS", tracking_number: "1Z999AA10123456784" });
    expect(pack.draft).toContain("UPS 1Z999AA10123456784 - DELIVERED");
  });
  it("finds the invoice through the transaction or the buyer email when the dispute carries no invoice id", () => {
    const d = { ...disputes[1], invoice_id: undefined };
    expect(invoiceForDispute(d, invoices, transactions)?.invoice_number).toBe("INV-0019");
    const noTxn = { ...d, transaction_id: "nope" };
    expect(invoiceForDispute(noTxn, invoices, transactions)?.client.email).toBe(d.buyer_email);
    expect(evidenceTypeFor("CREDIT_NOT_PROCESSED", false)).toBe("PROOF_OF_REFUND");
    expect(evidenceTypeFor("OTHER", false)).toBe("OTHER");
  });
});

describe("Disputes API call path (rest.ts)", () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    if (u.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    if (u.includes("/provide-evidence") || u.includes("/send-message")) return new Response(JSON.stringify({ links: [{ rel: "self", href: u }] }), { status: 200 });
    return new Response(JSON.stringify({ name: "RESOURCE_NOT_FOUND", message: "nope" }), { status: 404 });
  }) as typeof fetch;

  beforeEach(() => {
    calls.length = 0;
    process.env.PAYPAL_CLIENT_ID = "test-client";
    process.env.PAYPAL_CLIENT_SECRET = "test-secret";
    vi.stubGlobal("fetch", fetchImpl);
  });

  it("posts multipart provide-evidence for a claim and send-message for an inquiry", async () => {
    const r = await submitDisputeEvidence("PP-D-1", { evidence_type: "PROOF_OF_FULFILLMENT", notes: "hello", tracking: { carrier_name: "UPS", tracking_number: "1Z" } }, "CHARGEBACK", { fetchImpl });
    expect(r).toMatchObject({ dispute_id: "PP-D-1", channel: "provide-evidence", status: 200 });
    const pe = calls.find((c) => c.url.endsWith("/v1/customer/disputes/PP-D-1/provide-evidence"))!;
    expect(pe.init.method).toBe("POST");
    expect((pe.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const form = pe.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const input = JSON.parse(await (form.get("input") as Blob).text());
    expect(input).toEqual({ evidences: [{ evidence_type: "PROOF_OF_FULFILLMENT", notes: "hello", evidence_info: { tracking_info: [{ carrier_name: "UPS", tracking_number: "1Z" }] } }] });

    const m = await submitDisputeEvidence("PP-D-2", { evidence_type: "OTHER", notes: "x".repeat(2500) }, "INQUIRY", { fetchImpl });
    expect(m.channel).toBe("send-message");
    const sm = calls.find((c) => c.url.endsWith("/PP-D-2/send-message"))!;
    expect(JSON.parse(sm.init.body as string).message.length).toBe(2000);
  });
  it("surfaces PayPal error bodies", async () => {
    await expect(submitDisputeEvidence("missing", { evidence_type: "OTHER", notes: "n" }, "CHARGEBACK", { fetchImpl: (async (u: string | URL | Request, i?: RequestInit) => (String(u).includes("oauth2") ? fetchImpl(u, i) : new Response(JSON.stringify({ name: "RESOURCE_NOT_FOUND", message: "The specified resource does not exist.", details: [{ issue: "INVALID_DISPUTE_ID" }] }), { status: 404 }))) as typeof fetch })).rejects.toThrow(/RESOURCE_NOT_FOUND 404.*INVALID_DISPUTE_ID/);
  });
});

describe("policy: disputes.submitEvidence", () => {
  const ctx = { policy: parsePolicy({}), invoices, disputes, now };
  it("asks by default, allows on auto, denies on never, and cites the rule", () => {
    expect(evaluateAction("submit_dispute_evidence", { dispute_id: "PP-D-MOCK-00480" }, ctx)).toMatchObject({ decision: "approve", rule: "disputes.submitEvidence" });
    expect(evaluateAction("submit_dispute_evidence", { dispute_id: "PP-D-MOCK-00480" }, { ...ctx, policy: parsePolicy({ disputes: { submitEvidence: "auto" } }) }).decision).toBe("allow");
    expect(evaluateAction("submit_dispute_evidence", { dispute_id: "PP-D-MOCK-00480" }, { ...ctx, policy: parsePolicy({ disputes: { submitEvidence: "never" } }) }).decision).toBe("deny");
  });
  it("every decision cites a policy rule", () => {
    for (const [tool, input] of [
      ["create_refund", { capture_id: "x", amount: { value: "600" } }],
      ["send_invoice_reminder", { invoice_id: "INV-0002" }],
      ["record_payment_for_invoice", { invoice_id: "INV-0013", method: "PAYPAL", amount: { value: "300" } }],
      ["accept_dispute_claim", { dispute_id: "PP-D-MOCK-00015", note: "ok" }],
      ["cancel_sent_invoice", { invoice_id: "INV-0002" }],
      ["list_invoices", {}],
    ] as const) {
      expect(evaluateAction(tool, input, ctx).rule, tool).toMatch(/^[a-z]/);
    }
    expect(evaluateAction("create_refund", { capture_id: "x", amount: { value: "600" } }, ctx).rule).toBe("approvals.refundsOver");
  });
});

describe("agent flow: build and submit an evidence pack (mock PayPal, no keys)", () => {
  beforeEach(() => {
    resetStore(now).policy.disputes.submitEvidence = "ask"; // resetStore keeps the previous policy on purpose
  });
  const dispute = () => getStore().mock.disputes.find((d) => d.id === "PP-D-MOCK-00480")!;

  it("review disputes: accepts the small one, builds the pack for the big one and asks before submitting (ask)", async () => {
    const r = await runOnce("Review disputes", { unattended: true });
    expect(r.toolCalls).toEqual(expect.arrayContaining(["list_disputes", "accept_dispute_claim", "draft_dispute_evidence", "submit_dispute_evidence"]));
    expect(dispute().evidence_draft).toContain("Team workshop");
    expect(dispute().evidence_submitted_at).toBeUndefined(); // unattended run: approval needed, so skipped
    expect(getStore().audit.some((a) => a.tool === "submit_dispute_evidence" && a.decision === "approval-required" && a.rule === "disputes.submitEvidence")).toBe(true);
    expect(r.text).toMatch(/not done - Needs human approval/);
  });

  it("submits through the Disputes API without asking when the policy says auto, and records the channel", async () => {
    getStore().policy.disputes.submitEvidence = "auto";
    const r = await runOnce("Submit the evidence pack for dispute PP-D-MOCK-00480", { unattended: true });
    expect(r.toolCalls).toEqual(["draft_dispute_evidence", "submit_dispute_evidence"]);
    expect(dispute()).toMatchObject({ evidence_channel: "provide-evidence", status: "UNDER_PAYPAL_REVIEW" });
    expect(dispute().evidence_submitted_at).toBeTruthy();
    expect(r.text).toContain("submitted to PayPal via the Disputes API provide-evidence endpoint (HTTP 200)");
    expect(r.text).toContain("What I sent:");
    const entry = getStore().audit.find((a) => a.tool === "submit_dispute_evidence" && a.actor === "agent")!;
    expect(entry).toMatchObject({ decision: "allowed", rule: "disputes.submitEvidence" });
    // second attempt is refused locally, no double submission
    const again = await runOnce("Submit the evidence pack for dispute PP-D-MOCK-00480", { unattended: true });
    expect(again.text).toMatch(/already submitted/i);
  });

  it("uses send-message while the dispute is still an inquiry", async () => {
    getStore().policy.disputes.submitEvidence = "auto";
    const d = dispute();
    d.status = "OPEN_INQUIRIES";
    d.life_cycle_stage = "INQUIRY";
    await runOnce("Submit evidence for PP-D-MOCK-00480", { unattended: true });
    expect(dispute()).toMatchObject({ evidence_channel: "send-message", status: "REQUIRED_OTHER_PARTY_ACTION" });
  });

  it("stops after drafting when the policy reserves submission for the user (never)", async () => {
    getStore().policy.disputes.submitEvidence = "never";
    const r = await runOnce("Review disputes", { unattended: true });
    expect(r.toolCalls).not.toContain("submit_dispute_evidence");
    expect(dispute().evidence_draft).toBeTruthy();
    expect(r.text).toContain("submission left to you");
  });

  it("interactive mode: the approval card carries the pack text", async () => {
    const setup = agentSetup();
    const verdict = await setup.toolApproval({ toolCall: { toolName: "submit_dispute_evidence", input: { dispute_id: "PP-D-MOCK-00480", notes: "pack" } } });
    expect(verdict).toMatchObject({ type: "user-approval", reason: expect.stringContaining("disputes.submitEvidence") });
  });
});
