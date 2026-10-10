/**
 * Process-local state. Mock mode keeps the whole "PayPal" here; sandbox mode keeps only what PayPal
 * does not store for us (policy, reminder history, chase overrides, audit log).
 *
 * Kept on globalThis so Next.js dev HMR and route modules share one instance.
 */
import type { AuditEntry, ChaseOverride, Dispute, Invoice, Product, ReminderRecord, Subscription, SubscriptionPlan, Tracking, Transaction } from "./paypal/types";
import { buildDisputes, buildInvoices, buildPlans, buildProducts, buildSubscriptions, buildTrackings, buildTransactions } from "./paypal/fixtures";
import { DEFAULT_POLICY, type Policy } from "./policy/schema";

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
  /** Tool calls that the agent ran since the last UI poll; lets the grid refresh only when needed. */
  version: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __chaserStore: Store | undefined;
}

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

export function createStore(now = new Date()): Store {
  return {
    policy: structuredClone(DEFAULT_POLICY),
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

export function getStore(): Store {
  if (!globalThis.__chaserStore) globalThis.__chaserStore = createStore();
  return globalThis.__chaserStore;
}

export function resetStore(now = new Date()): Store {
  const prev = globalThis.__chaserStore;
  const next = createStore(now);
  if (prev) next.policy = prev.policy; // keep the user's policy across demo resets
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
