import { errorResponse, readBody, withSnapshot } from "@/lib/api";
import { buildStatement } from "@/lib/agent/statement";
import { merchantProfile } from "@/lib/env";
import { getInvoices, getTransactions } from "@/lib/paypal/backend";
import { getStore } from "@/lib/store";

/** Statement of account for one client. Body: { email, snapshot }. Pure read; nothing is recorded. */
export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    const email = typeof body.email === "string" ? body.email : "";
    if (!email) return errorResponse("email is required");
    return await withSnapshot(body, async () => {
      const [invoices, transactions] = await Promise.all([getInvoices(), getTransactions()]);
      const st = buildStatement(email, { invoices, transactions, now: new Date(), merchant: merchantProfile(), policy: getStore().policy });
      if (!st) return errorResponse(`No invoices for ${email}`, 404);
      return Response.json(st);
    });
  } catch (e) {
    return errorResponse(e, 500);
  }
}
