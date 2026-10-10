/**
 * PayPal Webhooks: verification (sandbox) and event application (both modes).
 * Events drive the agent reactively: a paid invoice is reconciled instantly, a new dispute is triaged.
 */
import { audit, bump, getStore } from "../store";
import { currentMode } from "./backend";
import { findInvoice, recordPayment } from "./mock";
import { getAccessToken, verifyWebhookSignatureRest } from "./rest";
import { money } from "./types";
import { txnId } from "./fixtures";

export { getAccessToken };

type J = Record<string, unknown>;
const j = (v: unknown): J => (v && typeof v === "object" ? (v as J) : {});
const s = (v: unknown, d = ""): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : d);

/** POST /v1/notifications/verify-webhook-signature (the toolkit has no webhook tool, so this is plain REST). */
export const verifyWebhookSignature = verifyWebhookSignatureRest;

export interface WebhookOutcome {
  event: string;
  handled: boolean;
  summary: string;
}

/**
 * Apply an event to local state and write the audit trail. In sandbox mode PayPal already holds the truth,
 * so we only invalidate caches and log; in mock mode we mutate the fixtures so the grid updates live.
 */
export async function applyWebhookEvent(event: J, source: "paypal" | "simulated"): Promise<WebhookOutcome> {
  const type = s(event.event_type);
  const resource = j(event.resource);
  const store = getStore();
  const mock = currentMode() === "mock";
  const tag = source === "simulated" ? " (simulated)" : "";

  switch (type) {
    case "INVOICING.INVOICE.PAID": {
      const id = s(resource.id) || s(j(resource.invoice).id);
      if (mock) {
        const inv = findInvoice(id);
        const t = recordPayment(inv, inv.due, { method: "PAYPAL", note: `Paid via PayPal invoice ${inv.invoice_number}` });
        audit({ actor: "webhook", tool: type, action: `${inv.client.business ?? inv.client.email} paid ${inv.invoice_number} (${money(t.amount, inv.currency)}) - reconciled automatically${tag}`, decision: "info", output: { transaction_id: t.id } });
        return { event: type, handled: true, summary: `${inv.invoice_number} marked PAID` };
      }
      bump();
      audit({ actor: "webhook", tool: type, action: `Invoice ${id} paid on PayPal${tag}`, decision: "info" });
      return { event: type, handled: true, summary: `Invoice ${id} paid` };
    }
    case "INVOICING.INVOICE.CANCELLED": {
      const id = s(resource.id) || s(j(resource.invoice).id);
      if (mock) {
        const inv = findInvoice(id);
        inv.status = "CANCELLED";
        bump();
      }
      audit({ actor: "webhook", tool: type, action: `Invoice ${id} cancelled${tag}`, decision: "info" });
      return { event: type, handled: true, summary: `Invoice ${id} cancelled` };
    }
    case "PAYMENT.CAPTURE.COMPLETED": {
      const amount = Number(j(resource.amount).value ?? resource.amount ?? 0) || 0;
      if (mock) {
        store.mock.transactions.unshift({ id: txnId(`wh-${Date.now()}`), date: new Date().toISOString(), type: "PAYMENT", amount, fee: 0, currency: "USD", status: "S", payer_email: s(j(j(resource.payer).email_address)) || undefined, memo: "Capture completed (webhook)", invoice_id: s(resource.invoice_id) || undefined });
        bump();
      }
      audit({ actor: "webhook", tool: type, action: `Payment captured: ${money(amount)}${tag}`, decision: "info" });
      return { event: type, handled: true, summary: `Capture ${money(amount)} recorded` };
    }
    case "CUSTOMER.DISPUTE.CREATED": {
      const id = s(resource.dispute_id, `PP-D-${Date.now()}`);
      const amount = Number(j(resource.dispute_amount).value ?? resource.amount ?? 0) || 0;
      if (mock) {
        const tx = j((resource.disputed_transactions as unknown[] | undefined)?.[0]);
        store.mock.disputes.unshift({ id, transaction_id: s(tx.seller_transaction_id), amount, currency: "USD", reason: s(resource.reason, "OTHER"), status: "OPEN_INQUIRIES", created: new Date().toISOString(), seller_response_due: new Date(Date.now() + 10 * 86_400_000).toISOString(), buyer_email: s(j(tx.buyer).email, "buyer@example.com") });
        bump();
      }
      audit({ actor: "webhook", tool: type, action: `New dispute ${id} for ${money(amount)} - say "review disputes" to triage${tag}`, decision: "info" });
      return { event: type, handled: true, summary: `Dispute ${id} opened` };
    }
    case "CUSTOMER.DISPUTE.RESOLVED": {
      const id = s(resource.dispute_id);
      if (mock) {
        const d = store.mock.disputes.find((x) => x.id === id);
        if (d) d.status = "RESOLVED";
        bump();
      }
      audit({ actor: "webhook", tool: type, action: `Dispute ${id} resolved${tag}`, decision: "info" });
      return { event: type, handled: true, summary: `Dispute ${id} resolved` };
    }
    case "BILLING.SUBSCRIPTION.ACTIVATED": {
      const id = s(resource.id);
      if (mock) {
        const sub = store.mock.subscriptions.find((x) => x.id === id);
        if (sub) sub.status = "ACTIVE";
        bump();
      }
      audit({ actor: "webhook", tool: type, action: `Subscription ${id} activated by the client${tag}`, decision: "info" });
      return { event: type, handled: true, summary: `Subscription ${id} active` };
    }
    default:
      audit({ actor: "webhook", tool: type || "unknown", action: `Ignored webhook ${type || "(no event_type)"}${tag}`, decision: "info" });
      return { event: type, handled: false, summary: "ignored" };
  }
}
