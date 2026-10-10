import { getState } from "@/lib/paypal/backend";
import { getStore } from "@/lib/store";

export async function GET() {
  try {
    const state = await getState();
    return Response.json({ ...state, policy: getStore().policy, version: getStore().version });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
