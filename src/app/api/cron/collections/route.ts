import { runOnce } from "@/lib/agent/run";
import { currentMode } from "@/lib/paypal/backend";
import { audit } from "@/lib/store";

export const maxDuration = 60;

/**
 * Daily unattended sweep (Vercel Cron, see vercel.json). Requires CRON_SECRET (Vercel sends it as a Bearer
 * token automatically). Only policy-allowed actions run; anything that would need approval is skipped and
 * surfaced in the audit log. In mock mode the sweep acts on the process-global demo data, so it is a dry run.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not configured; the cron sweep is disabled." }, { status: 401 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
  audit({ actor: "cron", action: "Daily collections sweep started", decision: "info" });
  const result = await runOnce("Run collections for all overdue invoices, then reconcile any unmatched payments. Report what you did.", { unattended: true });
  audit({ actor: "cron", action: "Daily collections sweep finished", decision: "info", output: result.text.slice(0, 400) });
  return Response.json({ mode: currentMode(), ...result });
}
