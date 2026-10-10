import { currentMode } from "@/lib/paypal/backend";
import { applyWebhookEvent, verifyWebhookSignature } from "@/lib/paypal/webhooks";
import { audit } from "@/lib/store";

/**
 * PayPal Webhooks receiver. Subscribe the sandbox app to:
 *   INVOICING.INVOICE.PAID, INVOICING.INVOICE.CANCELLED, PAYMENT.CAPTURE.COMPLETED,
 *   CUSTOMER.DISPUTE.CREATED, CUSTOMER.DISPUTE.RESOLVED, BILLING.SUBSCRIPTION.ACTIVATED
 * and set PAYPAL_WEBHOOK_ID so signatures are verified via /v1/notifications/verify-webhook-signature.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (currentMode() === "sandbox") {
    const verdict = await verifyWebhookSignature(req.headers, raw);
    if (!verdict.ok) {
      audit({ actor: "webhook", action: `Rejected webhook ${String(event.event_type)}: ${verdict.reason}`, decision: "denied" });
      return Response.json({ error: verdict.reason }, { status: 401 });
    }
  }
  try {
    const result = await applyWebhookEvent(event, "paypal");
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
