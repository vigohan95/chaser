/**
 * State model.
 *
 * Mock mode keeps the whole "PayPal" in a Store; sandbox mode keeps only what PayPal does not store for us
 * (policy, reminder history, chase overrides, audit log).
 *
 * Serverless-safe: the browser carries a snapshot of its Store and sends it with every request; the route
 * hydrates it into an AsyncLocalStorage context for the duration of that request and returns the new snapshot.
 * No database, no cross-instance drift, and every visitor gets an isolated demo. Server-to-server callers
 * (PayPal webhooks, Vercel Cron) fall back to a process-global Store.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditEntry, ChaseOverride, Dispute, Invoice, Product, ReminderRecord, Subscription, SubscriptionPlan, Tracking, Transaction } from "./paypal/types";
import { buildDisputes, buildInvoices, buildPlans, buildProducts, buildSubscriptions, buildTrackings, buildTransactions } from "./paypal/fixtures";
import { DEFAULT_POLICY, parsePolicy, type Policy } from "./policy/schema";

export interface Overlay {
  reminders: ReminderRecord[];
  chase_override: ChaseOverride;
}

export interface MockData {
  invoices: Invoice[];
  transactions: Transaction[];
  disputes: Dispute[];
  trackings: Tracking[];
  products: Product[];
  plans: SubscriptionPlan[];
  subscriptions: Subscription[];
  seq: number;
}

export interface Store {
  policy: Policy;
  audit: AuditEntry[];
  overlay: Record<string, Overlay>;
  mock: MockData;
  seededAt: string;
  /** Bumped on every mutation; lets clients skip no-op re-renders. */
  version: number;
}

declare global {
  var __chaserStore: Store | undefined;
}

const als = new AsyncLocalStorage<Store>();

export function freshMockData(now = new Date()): MockData {
  const invoices = buildInvoices(now);
  const transactions = buildTransactions(now, invoices);
  return {
    invoices,
    transactions,
    disputes: buildDisputes(now, invoices, transactions),
    trackings: buildTrackings(now, invoices, transactions),
    products: buildProducts(),
    plans: buildPlans(),
    subscriptions: buildSubscriptions(),
    seq: 21,
  };
}

export function createStore(now = new Date(), policy?: Policy): Store {
  return {
    policy: policy ? structuredClone(policy) : structuredClone(DEFAULT_POLICY),
    audit: [
      {
        id: "a0",
        ts: now.toISOString(),
        actor: "system",
        action: "Demo data loaded (20 invoices, 11 transactions, 2 disputes, 1 shipment).",
        decision: "info",
      },
    ],
    overlay: {},
    mock: freshMockData(now),
    seededAt: now.toISOString(),
    version: 1,
  };
}

/** The Store for the current request (hydrated snapshot), else the process-global one. */
export function getStore(): Store {
  const scoped = als.getStore();
  if (scoped) return scoped;
  if (!globalThis.__chaserStore) globalThis.__chaserStore = createStore();
  return globalThis.__chaserStore;
}

/** Run `fn` with `store` as the request-scoped Store (propagates through awaits, streams and tool calls). */
export function runWithStore<T>(store: Store, fn: () => T): T {
  return als.run(store, fn);
}

const MAX_SNAPSHOT_BYTES = 4_000_000;

/**
 * Turn a client-supplied snapshot into a Store. The snapshot is the client's own demo data, so it is trusted
 * only for that request; shape is checked loosely and the policy is re-validated.
 */
export function hydrateSnapshot(raw: unknown): Store {
  if (!raw || typeof raw !== "object") return createStore();
  const s = raw as Partial<Store>;
  const m = s.mock as Partial<MockData> | undefined;
  if (!m || !Array.isArray(m.invoices) || !Array.isArray(m.transactions) || !Array.isArray(s.audit)) return createStore();
  try {
    if (JSON.stringify(raw).length > MAX_SNAPSHOT_BYTES) return createStore();
  } catch {
    return createStore();
  }
  let policy: Policy;
  try {
    policy = parsePolicy(s.policy);
  } catch {
    policy = structuredClone(DEFAULT_POLICY);
  }
  return {
    policy,
    audit: (s.audit as AuditEntry[]).slice(0, 500),
    overlay: s.overlay && typeof s.overlay === "object" ? (s.overlay as Record<string, Overlay>) : {},
    mock: {
      invoices: m.invoices as Invoice[],
      transactions: m.transactions as Transaction[],
      disputes: Array.isArray(m.disputes) ? (m.disputes as Dispute[]) : [],
      trackings: Array.isArray(m.trackings) ? (m.trackings as Tracking[]) : [],
      products: Array.isArray(m.products) ? (m.products as Product[]) : buildProducts(),
      plans: Array.isArray(m.plans) ? (m.plans as SubscriptionPlan[]) : buildPlans(),
      subscriptions: Array.isArray(m.subscriptions) ? (m.subscriptions as Subscription[]) : [],
      seq: typeof m.seq === "number" && m.seq >= 21 ? m.seq : 21 + (m.invoices as Invoice[]).length,
    },
    seededAt: typeof s.seededAt === "string" ? s.seededAt : new Date().toISOString(),
    version: typeof s.version === "number" ? s.version : 1,
  };
}

/** Replace the process-global Store (tests, server-to-server resets). Keeps the user's policy. */
export function resetStore(now = new Date()): Store {
  const prev = globalThis.__chaserStore;
  const next = createStore(now, prev?.policy);
  globalThis.__chaserStore = next;
  return next;
}

export function bump(): void {
  getStore().version += 1;
}

let auditSeq = 1;
export function audit(entry: Omit<AuditEntry, "id" | "ts">): AuditEntry {
  const s = getStore();
  const e: AuditEntry = { id: `a${Date.now().toString(36)}${(auditSeq++).toString(36)}`, ts: new Date().toISOString(), ...entry };
  s.audit.unshift(e);
  if (s.audit.length > 500) s.audit.length = 500;
  s.version += 1;
  return e;
}

export function overlayFor(invoiceId: string): Overlay {
  const s = getStore();
  if (!s.overlay[invoiceId]) s.overlay[invoiceId] = { reminders: [], chase_override: "default" };
  return s.overlay[invoiceId];
}

export function setPolicy(p: Policy): void {
  getStore().policy = p;
  bump();
}
