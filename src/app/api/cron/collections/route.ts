import { runOnce } from "@/lib/agent/run";
import { audit } from "@/lib/store";

export const maxDuration = 60;

/**
 * Daily unattended sweep (Vercel Cron, see vercel.json). Only policy-allowed actions run; anything that
 * would need approval is skipped and surfaced in the audit log for the next time the user opens the app.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  audit({ actor: "cron", action: "Daily collections sweep started", decision: "info" });
  const result = await runOnce("Run collections for all overdue invoices, then reconcile any unmatched payments. Report what you did.", { unattended: true });
  audit({ actor: "cron", action: "Daily collections sweep finished", decision: "info", output: result.text.slice(0, 400) });
  return Response.json(result);
}
