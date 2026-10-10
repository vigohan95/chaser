import { errorResponse, readBody, stateResponse, withSnapshot } from "@/lib/api";
import { parsePolicy } from "@/lib/policy/schema";
import { audit, getStore, setPolicy } from "@/lib/store";

export async function GET() {
  return Response.json(getStore().policy);
}

/** Body: { policy, snapshot } (a bare policy object is also accepted). */
export async function PUT(req: Request) {
  const body = await readBody(req);
  try {
    const policy = parsePolicy(body.policy ?? body);
    return await withSnapshot(body, () => {
      setPolicy(policy);
      audit({ actor: "user", action: "Policy updated", decision: "info", input: policy });
      return stateResponse();
    });
  } catch (e) {
    return errorResponse(e);
  }
}
