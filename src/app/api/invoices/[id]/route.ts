import { errorResponse, readBody, stateResponse, withSnapshot } from "@/lib/api";
import { currentMode, getInvoices } from "@/lib/paypal/backend";
import { findInvoice, setChaseOverride } from "@/lib/paypal/mock";
import type { ChaseOverride } from "@/lib/paypal/types";
import { audit, bump, overlayFor } from "@/lib/store";

const OVERRIDES: ChaseOverride[] = ["default", "paused", "gentle", "aggressive"];

/** Inline edits from the grid: per-invoice chasing override. Body: { chase_override, snapshot }. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await readBody(req);
  const override = body.chase_override as ChaseOverride | undefined;
  if (!override || !OVERRIDES.includes(override)) return errorResponse(`chase_override must be one of ${OVERRIDES.join(", ")}`);
  try {
    return await withSnapshot(body, async () => {
      let number = id;
      if (currentMode() === "mock") {
        const inv = findInvoice(id);
        setChaseOverride(inv, override);
        number = inv.invoice_number;
      } else {
        const inv = (await getInvoices()).find((i) => i.id === id || i.invoice_number === id);
        if (!inv) throw new Error("Invoice not found");
        overlayFor(inv.id).chase_override = override;
        number = inv.invoice_number;
        bump();
      }
      audit({ actor: "user", action: `Chasing for ${number} set to ${override} (grid edit)`, decision: "info" });
      return stateResponse();
    });
  } catch (e) {
    return errorResponse(e, 404);
  }
}
