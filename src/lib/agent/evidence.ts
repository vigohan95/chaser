/**
 * Evidence pack builder: everything Chaser already knows about a disputed sale (invoice line items, delivery /
 * tracking, reminder history, payment record) assembled into the shape the Disputes API accepts.
 * Pure: no I/O, so it is unit-testable and the same pack is shown on the approval card and sent to PayPal.
 */
import type { Dispute, Invoice, Tracking, Transaction } from "../paypal/types";
import { isOpenInvoice, money } from "../paypal/types";
import type { EvidenceSubmission, EvidenceType } from "../paypal/rest";

export interface EvidencePack extends EvidenceSubmission {
  dispute_id: string;
  invoice_number?: string;
  /** The human-readable pack (what the approval card shows and what the Resolution Center would receive). */
  draft: string;
  attachments_suggested: string[];
}

export interface EvidenceContext {
  invoices: Invoice[];
  transactions: Transaction[];
  trackings: Tracking[];
  merchant: { businessName: string; givenName: string; surname: string; email: string };
}

export function invoiceForDispute(d: Dispute, invoices: Invoice[], transactions: Transaction[]): Invoice | undefined {
  const byId = invoices.find((i) => i.id === d.invoice_id || i.invoice_number === d.invoice_id);
  if (byId) return byId;
  const txn = transactions.find((t) => t.id === d.transaction_id);
  if (txn?.invoice_id) return invoices.find((i) => i.id === txn.invoice_id);
  return invoices.find((i) => i.client.email.toLowerCase() === d.buyer_email.toLowerCase() && !isOpenInvoice(i));
}

export function evidenceTypeFor(reason: string, hasTracking: boolean): EvidenceType {
  if (hasTracking) return "PROOF_OF_FULFILLMENT";
  if (/NOT_RECEIVED/.test(reason)) return "PROOF_OF_FULFILLMENT";
  if (/NOT_AS_DESCRIBED|UNAUTHORISED|UNAUTHORIZED/.test(reason)) return "ITEM_DESCRIPTION";
  if (/CREDIT_NOT_PROCESSED/.test(reason)) return "PROOF_OF_REFUND";
  return "OTHER";
}

export function buildEvidencePack(d: Dispute, ctx: EvidenceContext): EvidencePack {
  const inv = invoiceForDispute(d, ctx.invoices, ctx.transactions);
  const payment = ctx.transactions.find((t) => t.id === d.transaction_id) ?? (inv ? ctx.transactions.find((t) => t.invoice_id === inv.id && t.type === "PAYMENT") : undefined);
  const tracking = ctx.trackings.find((t) => t.transaction_id === d.transaction_id) ?? (inv ? ctx.trackings.find((t) => t.invoice_id === inv.id) : undefined);
  const m = ctx.merchant;
  const lines = [
    `Dispute ${d.id} - ${money(d.amount, d.currency)} - reason: ${d.reason.replaceAll("_", " ").toLowerCase()}`,
    `Buyer: ${d.buyer_name ? d.buyer_name + " " : ""}<${d.buyer_email}>`,
    `Transaction: ${d.transaction_id}${payment ? ` - ${money(payment.amount, payment.currency)} received ${payment.date.slice(0, 10)}` : ""}`,
    inv ? `Invoice ${inv.invoice_number} issued ${inv.invoice_date}, due ${inv.due_date}, status ${inv.status.replaceAll("_", " ")}, total ${money(inv.total, inv.currency)}` : "Invoice: not linked to this transaction",
    inv ? `Work delivered: ${inv.items.map((i) => `${i.quantity} x ${i.name}${i.description ? ` (${i.description})` : ""}`).join("; ")}` : "",
    tracking ? `Shipment: ${tracking.carrier} ${tracking.tracking_number} - ${tracking.status} (${tracking.shipped_at.slice(0, 10)})` : "Delivery: digital / service delivery, no physical shipment",
    inv && inv.reminders.length ? `Reminder history: ${inv.reminders.map((r) => `${r.stage} on ${r.at.slice(0, 10)}`).join(", ")}` : "",
    "",
    `Statement: ${m.businessName} delivered the services described on the invoice${inv ? ` (${inv.invoice_number})` : ""}, which the buyer accepted and paid. The buyer raised no concern before opening this dispute. Supporting documents: invoice, delivery confirmation, written approvals and correspondence.`,
  ].filter(Boolean);
  const draft = lines.join("\n");
  return {
    dispute_id: d.id,
    invoice_number: inv?.invoice_number,
    evidence_type: evidenceTypeFor(d.reason, !!tracking),
    notes: draft.slice(0, 2000),
    tracking: tracking ? { carrier_name: tracking.carrier, tracking_number: tracking.tracking_number } : undefined,
    draft,
    attachments_suggested: ["Invoice PDF", "Final deliverable files or links", "Client emails approving the work", "Contract / statement of work"],
  };
}
