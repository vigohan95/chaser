/**
 * Route-handler helpers for the client-carried state model (see store.ts).
 */
import { getState } from "./paypal/backend";
import type { StatePayload } from "./paypal/types";
import type { Policy } from "./policy/schema";
import { getStore, hydrateSnapshot, runWithStore, type Store } from "./store";

export type Body = Record<string, unknown>;

export async function readBody(req: Request): Promise<Body> {
  try {
    const text = await req.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Body) : {};
  } catch {
    return {};
  }
}

/** Hydrate `body.snapshot` (or a fresh Store) for this request and run `fn` inside it. */
export function withSnapshot<T>(body: Body, fn: (store: Store) => T, fallback?: () => Store): T {
  const store = body.snapshot ? hydrateSnapshot(body.snapshot) : fallback ? fallback() : hydrateSnapshot(undefined);
  return runWithStore(store, () => fn(store));
}

/** The UI view + the snapshot the client must send back next time. Must run inside a Store context. */
export async function statePayload(): Promise<StatePayload<Policy>> {
  const store = getStore();
  const view = await getState();
  return { view: { ...view, policy: store.policy, version: store.version }, snapshot: store };
}

export async function stateResponse(extra: Record<string, unknown> = {}): Promise<Response> {
  return Response.json({ ...(await statePayload()), ...extra });
}

export function errorResponse(e: unknown, status = 400): Response {
  return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
}
