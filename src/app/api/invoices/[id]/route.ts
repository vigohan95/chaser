import { currentMode, getInvoices } from "@/lib/paypal/backend";
import { findInvoice, setChaseOverride } from "@/lib/paypal/mock";
import type { ChaseOverride } from "@/lib/paypal/types";
import { audit, bump, overlayFor } from "@/lib/store";

const OVERRIDES: ChaseOverride[] = ["default", "paused", "gentle", "aggressive"];

/** Inline edits from the grid: per-invoice chasing override. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json()) as { chase_override?: ChaseOverride };
  if (!body.chase_override || !OVERRIDES.includes(body.chase_override)) {
    return Response.json({ error: `chase_override must be one of ${OVERRIDES.join(", ")}` }, { status: 400 });
  }
  try {
    let number = id;
    if (currentMode() === "mock") {
      const inv = findInvoice(id);
      setChaseOverride(inv, body.chase_override);
      number = inv.invoice_number;
    } else {
      const inv = (await getInvoices()).find((i) => i.id === id || i.invoice_number === id);
      if (!inv) return Response.json({ error: "Invoice not found" }, { status: 404 });
      overlayFor(inv.id).chase_override = body.chase_override;
      number = inv.invoice_number;
      bump();
    }
    audit({ actor: "user", action: `Chasing for ${number} set to ${body.chase_override} (grid edit)`, decision: "info" });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
