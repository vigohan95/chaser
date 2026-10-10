import { parsePolicy } from "@/lib/policy/schema";
import { audit, getStore, setPolicy } from "@/lib/store";

export async function GET() {
  return Response.json(getStore().policy);
}

export async function PUT(req: Request) {
  try {
    const policy = parsePolicy(await req.json());
    setPolicy(policy);
    audit({ actor: "user", action: "Policy updated", decision: "info", input: policy });
    return Response.json(policy);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
