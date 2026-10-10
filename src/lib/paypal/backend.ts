/**
 * One entry point for "what does the business look like right now", in either mode.
 * Mock: straight from the in-memory store. Sandbox: PayPal Agent Toolkit list calls + local overlay.
 */
import { isMockLlm, isMockPayPal } from "../env";
import { getStore, overlayFor } from "../store";
import { liveExecute, mapDispute, mapInvoice, mapTransaction } from "./live";
import { mockExecute } from "./mock";
import type { CommandCenterState, Dispute, Invoice, Transaction } from "./types";

export type Mode = "mock" | "sandbox";

export function currentMode(): Mode {
  return isMockPayPal() ? "mock" : "sandbox";
}

export function llmLabel(): string {
  if (isMockLlm()) return "mock planner (no LLM key)";
  if (process.env.LLM_MODEL) return process.env.LLM_MODEL;
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) return "gemini-2.5-flash";
  if (process.env.GROQ_API_KEY) return "groq/openai/gpt-oss-120b";
  if (process.env.NEBIUS_API_KEY) return "nebius/nvidia/NVIDIA-Nemotron";
  return "mock planner";
}

/** Execute a PayPal tool in whichever backend is active. */
export async function execute(tool: string, input: unknown): Promise<unknown> {
  return currentMode() === "mock" ? mockExecute(tool, input) : liveExecute(tool, input);
}

let sandboxCache: { at: number; version: number; invoices: Invoice[]; transactions: Transaction[]; disputes: Dispute[] } | undefined;
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
  const pick = (r: PromiseSettledResult<unknown>, key: string): unknown[] => {
    if (r.status !== "fulfilled") return [];
    const v = (r.value as Record<string, unknown>)?.[key];
    return Array.isArray(v) ? v : [];
  };
  const invoices = pick(inv, "items").map(mapInvoice).map((i) => {
    const o = overlayFor(i.id);
    return { ...i, reminders: o.reminders, chase_override: o.chase_override };
  });
  sandboxCache = {
    at: Date.now(),
    version: store.version,
    invoices,
    transactions: pick(txn, "transaction_details").map(mapTransaction),
    disputes: pick(dis, "items").map(mapDispute),
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
    return { ...base, invoices: m.invoices, transactions: m.transactions, disputes: m.disputes, trackings: m.trackings, plans: m.plans, subscriptions: m.subscriptions };
  }
  const lists = await sandboxLists();
  return { ...base, invoices: lists.invoices, transactions: lists.transactions, disputes: lists.disputes, trackings: store.mock.trackings, plans: [], subscriptions: [] };
}
