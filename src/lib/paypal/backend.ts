/**
 * One entry point for "what does the business look like right now", in either mode.
 * Mock: straight from the in-memory store. Sandbox: PayPal Agent Toolkit list calls + local overlay.
 */
import { isMockLlm, isMockPayPal, sandboxRequestedWithoutCredentials } from "../env";
import { getStore, overlayFor } from "../store";
import { liveExecute, mapDispute, mapInvoice, mapTransaction } from "./live";
import { mockExecute } from "./mock";
import type { CommandCenterState, Dispute, Invoice, Transaction } from "./types";

export type Mode = "mock" | "sandbox";

export function currentMode(): Mode {
  return isMockPayPal() ? "mock" : "sandbox";
}

export function llmLabel(): string {
  if (isMockLlm()) return "rule planner (no LLM key)";
  if (process.env.LLM_MODEL) return process.env.LLM_MODEL;
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) return "gemini-2.5-flash";
  if (process.env.GROQ_API_KEY) return "groq/openai/gpt-oss-120b";
  if (process.env.NEBIUS_API_KEY) return "nebius/nvidia/NVIDIA-Nemotron";
  return "rule planner (no LLM key)";
}

/** Execute a PayPal tool in whichever backend is active. */
export async function execute(tool: string, input: unknown): Promise<unknown> {
  return currentMode() === "mock" ? mockExecute(tool, input) : liveExecute(tool, input);
}

let sandboxCache: { at: number; version: number; invoices: Invoice[]; transactions: Transaction[]; disputes: Dispute[]; errors: string[] } | undefined;
const SANDBOX_TTL_MS = 20_000;

async function sandboxLists() {
  const store = getStore();
  if (sandboxCache && Date.now() - sandboxCache.at < SANDBOX_TTL_MS && sandboxCache.version === store.version) return sandboxCache;
  const end = new Date();
  const start = new Date(end.getTime() - 31 * 86_400_000); // Transaction Search allows a 31-day window per call
  const [inv, txn, dis] = await Promise.allSettled([
    liveExecute("list_invoices", { page: 1, page_size: 100, total_required: true }),
    liveExecute("list_transactions", { start_date: start.toISOString(), end_date: end.toISOString(), transaction_status: "S", page_size: 100, page: 1 }),
    liveExecute("list_disputes", { page_size: 50, page: 1 }),
  ]);
  const errors: string[] = [];
  const pick = (r: PromiseSettledResult<unknown>, key: string, what: string): unknown[] => {
    if (r.status !== "fulfilled") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      // Transaction Search is a per-app feature; a 403 here means it is not ticked under the sandbox app's Features.
      errors.push(what === "list_transactions" && /403/.test(msg) ? "Transaction Search is not enabled for this sandbox app (403): developer.paypal.com -> the app -> Features -> tick Transaction Search. Payments cannot be listed until then; webhooks and invoice statuses still work." : `${what}: ${msg}`);
      return [];
    }
    const v = (r.value as Record<string, unknown>)?.[key];
    return Array.isArray(v) ? v : [];
  };
  // list_invoices returns summaries without line items; fetch the detail for each (bounded) so the grid, the
  // reminder copy and the evidence packs can quote the actual work. Previously fetched details are reused.
  const summaries = pick(inv, "items", "list_invoices").map(mapInvoice);
  const details = await Promise.all(
    summaries.slice(0, 40).map(async (i) => {
      if (i.items.length) return i;
      const prev = sandboxCache?.invoices.find((x) => x.id === i.id);
      if (prev?.items.length) return { ...i, items: prev.items };
      try {
        const full = mapInvoice(await liveExecute("get_invoice", { invoice_id: i.id }));
        return { ...i, items: full.items, links: full.links, note: full.note ?? i.note, due_date: full.due_date };
      } catch (e) {
        errors.push(`get_invoice ${i.invoice_number}: ${e instanceof Error ? e.message : String(e)}`);
        return i;
      }
    }),
  );
  const invoices = [...details, ...summaries.slice(40)].map((i) => {
    const o = overlayFor(i.id);
    return { ...i, reminders: o.reminders, chase_override: o.chase_override, promise: o.promise, resolution: o.resolution };
  });
  sandboxCache = {
    at: Date.now(),
    version: store.version,
    invoices,
    transactions: pick(txn, "transaction_details", "list_transactions").map(mapTransaction),
    disputes: pick(dis, "items", "list_disputes").map(mapDispute).map((d) => ({ ...d, ...store.disputeOverlay[d.id] })),
    errors,
  };
  return sandboxCache;
}

export async function getInvoices(): Promise<Invoice[]> {
  return currentMode() === "mock" ? getStore().mock.invoices : (await sandboxLists()).invoices;
}
export async function getTransactions(): Promise<Transaction[]> {
  return currentMode() === "mock" ? getStore().mock.transactions : (await sandboxLists()).transactions;
}
export async function getDisputes(): Promise<Dispute[]> {
  return currentMode() === "mock" ? getStore().mock.disputes : (await sandboxLists()).disputes;
}

export async function getState(): Promise<CommandCenterState> {
  const store = getStore();
  const mode = currentMode();
  const base = { mode, llm: llmLabel(), now: new Date().toISOString(), audit: store.audit };
  if (mode === "mock") {
    const m = store.mock;
    const notice = sandboxRequestedWithoutCredentials() ? "MOCK_PAYPAL=0 but PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are empty, so demo data is served. Add the sandbox app credentials to .env.local and restart." : undefined;
    return { ...base, notice, invoices: m.invoices, transactions: m.transactions, disputes: m.disputes, trackings: m.trackings, plans: m.plans, subscriptions: m.subscriptions };
  }
  const lists = await sandboxLists();
  const notice = lists.errors.length ? `PayPal sandbox: ${lists.errors.join(" | ")}` : undefined;
  return { ...base, notice, invoices: lists.invoices, transactions: lists.transactions, disputes: lists.disputes, trackings: store.mock.trackings, plans: [], subscriptions: [] };
}
