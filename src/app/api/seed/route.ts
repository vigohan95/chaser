import { currentMode } from "@/lib/paypal/backend";
import { seedSandbox } from "@/lib/paypal/seed";
import { audit, resetStore } from "@/lib/store";

/** Mock: reset the demo data. Sandbox: create demo invoices in the PayPal sandbox (needs ALLOW_SANDBOX_SEED=1). */
export async function POST() {
  if (currentMode() === "mock") {
    resetStore();
    audit({ actor: "user", action: "Demo data reset", decision: "info" });
    return Response.json({ ok: true, mode: "mock" });
  }
  if (process.env.ALLOW_SANDBOX_SEED !== "1") {
    return Response.json({ error: "Set ALLOW_SANDBOX_SEED=1 to seed the PayPal sandbox from the UI (or run `npm run seed`)." }, { status: 403 });
  }
  const report = await seedSandbox();
  return Response.json({ ok: true, mode: "sandbox", ...report });
}
