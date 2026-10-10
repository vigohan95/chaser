import { errorResponse, readBody, stateResponse, withSnapshot } from "@/lib/api";
import { currentMode } from "@/lib/paypal/backend";
import { seedSandbox } from "@/lib/paypal/seed";
import { audit, createStore, hydrateSnapshot } from "@/lib/store";

/** Mock: fresh demo data (keeps the user's policy). Sandbox: seed PayPal (needs ALLOW_SANDBOX_SEED=1). */
export async function POST(req: Request) {
  const body = await readBody(req);
  if (currentMode() === "mock") {
    const previous = body.snapshot ? hydrateSnapshot(body.snapshot) : undefined;
    return withSnapshot({}, () => {
      audit({ actor: "user", action: "Demo data reset", decision: "info" });
      return stateResponse();
    }, () => createStore(new Date(), previous?.policy));
  }
  if (process.env.ALLOW_SANDBOX_SEED !== "1") {
    return errorResponse("Set ALLOW_SANDBOX_SEED=1 to seed the PayPal sandbox from the UI (or run `npm run seed`).", 403);
  }
  try {
    return await withSnapshot(body, async () => {
      const report = await seedSandbox();
      audit({ actor: "user", action: `Sandbox seeded: ${report.created.length} invoices created, ${report.failed.length} failed`, decision: "info", output: report });
      return stateResponse({ report });
    });
  } catch (e) {
    return errorResponse(e, 500);
  }
}
