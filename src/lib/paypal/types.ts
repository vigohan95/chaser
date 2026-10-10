/** Domain types used by the command center, the policy engine and both PayPal backends. */

export type InvoiceStatus =
  | "DRAFT"
  | "SENT"
  | "SCHEDULED"
  | "UNPAID"
  | "PAYMENT_PENDING"
  | "PARTIALLY_PAID"
  | "PAID"
  | "MARKED_AS_PAID"
  | "CANCELLED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED"
  | "MARKED_AS_REFUNDED";

export interface InvoiceItem {
  name: string;
  description?: string;
  quantity: number;
  unit_amount: number;
}

export interface Client {
  business?: string;
  given_name: string;
  surname: string;
  email: string;
}

export interface Invoice {
  id: string;
  invoice_number: string;
  status: InvoiceStatus;
  client: Client;
  items: InvoiceItem[];
  currency: string;
  total: number;
  paid: number;
  refunded: number;
  due: number;
  invoice_date: string; // yyyy-mm-dd
  due_date: string; // yyyy-mm-dd
  reference?: string;
  note?: string;
  /** Local overlay: reminders the agent sent (PayPal does not expose a count). */
  reminders: ReminderRecord[];
  /** Local overlay: per-invoice chasing override. */
  chase_override: ChaseOverride;
  links: { view?: string; pay?: string; qr?: string };
}

export type ChaseOverride = "default" | "paused" | "gentle" | "aggressive";

export interface ReminderRecord {
  at: string; // ISO
  stage: ChaseStage;
  subject?: string;
}

export type ChaseStage = "none" | "friendly" | "firm" | "final";

export type TransactionStatus = "S" | "P" | "D" | "V"; // success, pending, denied, reversed

export interface Transaction {
  id: string;
  date: string; // ISO
  type: "PAYMENT" | "REFUND" | "FEE" | "DISPUTE_HOLD";
  amount: number; // signed: payments positive, refunds negative
  fee: number;
  currency: string;
  status: TransactionStatus;
  payer_email?: string;
  payer_name?: string;
  memo?: string;
  invoice_id?: string; // set when PayPal links the payment to an invoice
  capture_id?: string;
  /** Local overlay: how much of this payment Chaser has applied to which invoices (partial / split reconciliation). */
  allocations?: Array<{ invoice_id: string; invoice_number: string; amount: number }>;
}

/** Part of a successful payment that is not yet applied to any invoice (0 when PayPal linked it itself). */
export function unappliedAmount(t: Pick<Transaction, "type" | "status" | "amount" | "invoice_id" | "allocations">): number {
  if (t.type !== "PAYMENT" || t.status !== "S" || t.amount <= 0) return 0;
  if (t.invoice_id && !t.allocations?.length) return 0;
  const applied = (t.allocations ?? []).reduce((a, x) => a + x.amount, 0);
  return round2(Math.max(0, t.amount - applied));
}

export type DisputeStatus =
  | "OPEN_INQUIRIES"
  | "REQUIRED_ACTION"
  | "REQUIRED_OTHER_PARTY_ACTION"
  | "UNDER_PAYPAL_REVIEW"
  | "RESOLVED"
  | "APPEALABLE";

export interface Dispute {
  id: string;
  transaction_id: string;
  invoice_id?: string;
  amount: number;
  currency: string;
  reason: string;
  status: DisputeStatus;
  created: string; // ISO
  seller_response_due?: string; // ISO
  buyer_email: string;
  buyer_name?: string;
  outcome?: "ACCEPTED_BY_SELLER" | "RESOLVED_BUYER_FAVOUR" | "RESOLVED_SELLER_FAVOUR";
  /** INQUIRY (buyer asked a question; answer with send-message) or CHARGEBACK (claim; answer with provide-evidence). */
  life_cycle_stage?: "INQUIRY" | "CHARGEBACK" | "PRE_ARBITRATION" | "ARBITRATION";
  /** Local overlay: the evidence pack the agent drafted. */
  evidence_draft?: string;
  /** Local overlay: when and through which Disputes API endpoint the pack was submitted. */
  evidence_submitted_at?: string;
  evidence_channel?: "provide-evidence" | "send-message";
}

export interface Tracking {
  transaction_id: string;
  invoice_id?: string;
  tracking_number: string;
  carrier: string;
  status: string;
  shipped_at: string; // ISO
}

export interface Product {
  id: string;
  name: string;
  type: "PHYSICAL" | "DIGITAL" | "SERVICE";
  description?: string;
}

export interface SubscriptionPlan {
  id: string;
  product_id: string;
  name: string;
  amount: number;
  currency: string;
  interval_unit: "DAY" | "WEEK" | "MONTH" | "YEAR";
  interval_count: number;
  status: "ACTIVE" | "INACTIVE" | "CREATED";
}

export interface Subscription {
  id: string;
  plan_id: string;
  status: "APPROVAL_PENDING" | "ACTIVE" | "SUSPENDED" | "CANCELLED";
  subscriber_email: string;
  subscriber_name?: string;
  approve_url?: string;
  created: string;
}

export type AuditActor = "agent" | "user" | "policy" | "webhook" | "cron" | "system";

export interface AuditEntry {
  id: string;
  ts: string; // ISO
  actor: AuditActor;
  tool?: string;
  action: string; // human-readable one-liner
  decision?: "allowed" | "approval-required" | "approved" | "denied" | "info" | "error";
  reason?: string;
  /** Policy field the decision cites (e.g. "approvals.refundsOver"); see policy/engine.ts. */
  rule?: string;
  input?: unknown;
  output?: unknown;
}

export interface CommandCenterState {
  mode: "mock" | "sandbox";
  llm: string;
  /** Operator-facing warning (e.g. sandbox list call failed, credentials missing). */
  notice?: string;
  now: string;
  invoices: Invoice[];
  transactions: Transaction[];
  disputes: Dispute[];
  trackings: Tracking[];
  plans: SubscriptionPlan[];
  subscriptions: Subscription[];
  audit: AuditEntry[];
}

export const OPEN_INVOICE_STATUSES: InvoiceStatus[] = [
  "SENT",
  "UNPAID",
  "PARTIALLY_PAID",
  "PAYMENT_PENDING",
];

export function isOpenInvoice(inv: Pick<Invoice, "status">): boolean {
  return OPEN_INVOICE_STATUSES.includes(inv.status);
}

export function money(n: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** What every state-bearing API response looks like: a view for the UI plus the opaque snapshot to send back. */
export interface StatePayload<P = unknown> {
  view: CommandCenterState & { policy: P; version: number };
  snapshot: unknown;
}
