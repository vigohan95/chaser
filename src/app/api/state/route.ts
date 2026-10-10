import { errorResponse, readBody, stateResponse, withSnapshot } from "@/lib/api";

/** Fresh demo state (first visit). */
export async function GET() {
  try {
    return await withSnapshot({}, () => stateResponse());
  } catch (e) {
    return errorResponse(e, 500);
  }
}

/** Re-derive the view from the client's snapshot (and, in sandbox mode, re-list PayPal). */
export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    return await withSnapshot(body, () => stateResponse());
  } catch (e) {
    return errorResponse(e, 500);
  }
}
