import { errorResponse, readBody, withSnapshot } from "@/lib/api";
import { matchTransactions } from "@/lib/agent/reconcile";
import { getInvoices, getTransactions } from "@/lib/paypal/backend";
import { getStore } from "@/lib/store";

/**
 * Match preview for the match-review grid: the same pure matcher the agent calls (`match_payments`), without
 * recording anything. Body: { snapshot }. The grid lets the user edit the allocations and then asks the agent
 * to record them, so every write still goes through the policy gate and the audit log.
 */
export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    return await withSnapshot(body, async () => {
      const [transactions, invoices] = await Promise.all([getTransactions(), getInvoices()]);
      const result = matchTransactions(transactions, invoices, getStore().policy.reconciliation.amountTolerance);
      return Response.json(result);
    });
  } catch (e) {
    return errorResponse(e, 500);
  }
}
