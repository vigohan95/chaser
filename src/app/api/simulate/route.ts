import { errorResponse, readBody, stateResponse, withSnapshot } from "@/lib/api";
import { currentMode } from "@/lib/paypal/backend";
import { applyWebhookEvent } from "@/lib/paypal/webhooks";

/**
 * Demo helper (mock mode only): fabricate a PayPal webhook event and run it through the same handler
 * as /api/webhooks/paypal, e.g. "the client just paid INV-0003". Body: { event, invoice_id?, amount?, snapshot }.
 */
export async function POST(req: Request) {
  if (currentMode() !== "mock") return errorResponse("Simulation is only available in mock mode.");
  const body = await readBody(req);
  try {
    return await withSnapshot(body, async () => {
      const result = await applyWebhookEvent({ event_type: body.event, resource: { id: body.invoice_id, invoice: { id: body.invoice_id }, amount: body.amount } }, "simulated");
      return stateResponse({ result });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
