import { currentMode } from "@/lib/paypal/backend";
import { applyWebhookEvent } from "@/lib/paypal/webhooks";

/**
 * Demo helper (mock mode only): fabricate a PayPal webhook event and run it through the same handler
 * as /api/webhooks/paypal, e.g. "the client just paid INV-0003".
 */
export async function POST(req: Request) {
  if (currentMode() !== "mock") return Response.json({ error: "Simulation is only available in mock mode." }, { status: 400 });
  const body = (await req.json()) as { event: string; invoice_id?: string; amount?: number };
  try {
    const result = await applyWebhookEvent({ event_type: body.event, resource: { id: body.invoice_id, invoice: { id: body.invoice_id }, amount: body.amount } }, "simulated");
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
