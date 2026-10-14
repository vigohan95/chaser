/**
 * Chaser's own tools (not PayPal): deterministic planning helpers the agent calls before it acts.
 * Each returns plain JSON so any model (or the mock planner) can act on it.
 */
import { tool } from "ai";
import { z } from "zod";
import { merchantProfile } from "../env";
import { currentMode, execute, getDisputes, getInvoices, getTransactions } from "../paypal/backend";
import { evaluateAction } from "../policy/engine";
import { findInvoice as findMockInvoice, setChaseOverride } from "../paypal/mock";
import { isOpenInvoice, money, round2, unappliedAmount } from "../paypal/types";
import { audit, bump, disputeOverlayFor, getStore, overlayFor } from "../store";
import { overdueDays, planCollections } from "./chase";
import { buildEvidencePack } from "./evidence";
import { payerProfiles, predictInvoice, unknownProfile } from "./payer-history";
import { matchTransactions } from "./reconcile";

async function evidenceFor(dispute_id: string) {
  const disputes = await getDisputes();
  const d = disputes.find((x) => x.id === dispute_id);
  if (!d) return { error: `Dispute ${dispute_id} not found` as const };
  const [invoices, transactions] = await Promise.all([getInvoices(), getTransactions()]);
  const pack = buildEvidencePack(d, { invoices, transactions, trackings: getStore().mock.trackings, merchant: merchantProfile() });
  return { d, pack };
}

export const localTools = {
  get_policy: tool({
    description: "Return the user's chasing policy: reminder cadence, dispute auto-accept limit, approval thresholds and reconciliation rules. Read it before chasing, refunding or accepting disputes.",
    inputSchema: z.object({}),
    execute: async () => getStore().policy,
  }),

  summarize_receivables: tool({
    description: "Totals for the business: outstanding, overdue, collected in the last 30 days, open disputes, and a per-client breakdown of what is owed.",
    inputSchema: z.object({}),
    execute: async () => {
      const now = new Date();
      const invoices = await getInvoices();
      const transactions = await getTransactions();
      const disputes = await getDisputes();
      const open = invoices.filter(isOpenInvoice);
      const overdue = open.filter((i) => overdueDays(i, now) > 0);
      const byClient: Record<string, { outstanding: number; overdue: number; invoices: number }> = {};
      for (const i of open) {
        const k = i.client.business ?? i.client.email;
        byClient[k] ??= { outstanding: 0, overdue: 0, invoices: 0 };
        byClient[k].outstanding = round2(byClient[k].outstanding + i.due);
        byClient[k].invoices += 1;
        if (overdueDays(i, now) > 0) byClient[k].overdue = round2(byClient[k].overdue + i.due);
      }
      const since = now.getTime() - 30 * 86_400_000;
      return {
        outstanding: round2(open.reduce((a, i) => a + i.due, 0)),
        overdue: round2(overdue.reduce((a, i) => a + i.due, 0)),
        open_invoices: open.length,
        overdue_invoices: overdue.length,
        collected_last_30_days: round2(transactions.filter((t) => t.type === "PAYMENT" && t.status === "S" && new Date(t.date).getTime() >= since).reduce((a, t) => a + t.amount, 0)),
        open_disputes: disputes.filter((d) => d.status !== "RESOLVED").length,
        unlinked_payments: transactions.filter((t) => unappliedAmount(t) > 0.01).length,
        by_client: byClient,
        oldest_overdue: overdue.sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 5).map((i) => ({ invoice_number: i.invoice_number, client: i.client.business, due: i.due, overdue_days: overdueDays(i, now) })),
      };
    },
  }),

  lookup_customer: tool({
    description: "Find a client by business name, person name or email and return their invoices (ids, numbers, status, balance) and linked PayPal transaction/capture ids. Use this before creating an invoice, refund, subscription or shipment for a client.",
    inputSchema: z.object({ query: z.string().describe("Business name, person name, email, or invoice number") }),
    execute: async ({ query }) => {
      const q = query.trim().toLowerCase();
      const invoices = await getInvoices();
      const transactions = await getTransactions();
      const byEmail = new Map<string, typeof invoices>();
      for (const i of invoices) {
        const hay = [i.client.business, i.client.given_name, i.client.surname, i.client.email, i.invoice_number].filter(Boolean).join(" ").toLowerCase();
        const words = q.split(/\s+/).filter(Boolean);
        if (words.length > 0 && words.every((w) => hay.includes(w))) {
          const list = byEmail.get(i.client.email) ?? [];
          list.push(i);
          byEmail.set(i.client.email, list);
        }
      }
      const profiles = payerProfiles(invoices, transactions);
      const customers = [...byEmail.values()].map((list) => {
        const c = list[0].client;
        const profile = profiles.get(c.email.toLowerCase()) ?? unknownProfile(c.email);
        return {
          business: c.business,
          given_name: c.given_name,
          surname: c.surname,
          email: c.email,
          payment_history: { band: profile.band, paid_invoices: profile.sample, median_days_late: profile.median_days_late, late_rate: profile.late_rate, reminders_avg: profile.reminders_avg, basis: profile.basis },
          invoices: list.map((i) => ({
            invoice_id: i.id,
            invoice_number: i.invoice_number,
            status: i.status,
            total: i.total,
            due: i.due,
            due_date: i.due_date,
            predicted_pay_date: isOpenInvoice(i) ? predictInvoice(i, profile, new Date()).predicted_pay_date : undefined,
            items: i.items.map((x) => x.name),
            transactions: transactions.filter((t) => t.invoice_id === i.id).map((t) => ({ transaction_id: t.id, capture_id: t.capture_id, amount: t.amount, type: t.type, date: t.date })),
          })),
        };
      });
      return { found: customers.length, customers, hint: customers.length === 0 ? "No existing client matched. Ask the user for the email address, or create the invoice with the details they gave." : undefined };
    },
  }),

  propose_collections: tool({
    description: "Apply the user's reminder policy to every open invoice and return the reminders that are due right now (stage friendly/firm/final, days overdue, amount, the payer's risk band and predicted pay date, why this stage now, and a drafted subject + note you may improve). The cadence adapts to each payer's own PayPal payment history when reminders.adaptToHistory is on. Call this before sending reminders.",
    inputSchema: z.object({ invoice_ids: z.array(z.string()).optional().describe("Limit to these invoice ids or numbers") }),
    execute: async ({ invoice_ids }) => {
      const store = getStore();
      const now = new Date();
      const all = await getInvoices();
      const transactions = await getTransactions();
      // Payer history always comes from the whole book, even when the chase is limited to a few invoices.
      const full = planCollections(all, store.policy, now, merchantProfile().givenName, transactions);
      const invoices = invoice_ids?.length ? all.filter((i) => invoice_ids.includes(i.id) || invoice_ids.includes(i.invoice_number)) : all;
      const proposals = full.filter((p) => invoices.some((i) => i.id === p.invoice_id));
      for (const p of proposals) {
        if (p.rule !== "reminders.adaptToHistory") continue;
        // The cadence decision itself goes in the ledger, with the numbers it rests on.
        audit({ actor: "policy", tool: "propose_collections", action: `${p.invoice_number} ${p.client}: ${p.stage} stage brought ${p.risk === "late-risk" ? "forward" : "back"} by payer history`, decision: "allowed", reason: p.why, rule: p.rule });
      }
      const skipped = invoices
        .filter(isOpenInvoice)
        .filter((i) => !proposals.some((p) => p.invoice_id === i.id))
        .map((i) => ({ invoice_number: i.invoice_number, overdue_days: overdueDays(i, now), reason: i.chase_override === "paused" ? "chasing paused" : i.reminders.length >= store.policy.reminders.maxReminders ? "max reminders reached" : overdueDays(i, now) < store.policy.reminders.friendlyAfterDays ? "not yet due for a reminder" : "already reminded at this stage / too soon since last reminder" }));
      return { now: now.toISOString(), policy: store.policy.reminders, proposals, skipped };
    },
  }),

  match_payments: tool({
    description: "Reconcile: match successful PayPal payments that are not linked to an invoice against open invoices (exact, partial and combined-invoice matches, with confidence and reasoning). Then record the matches with record_payment_for_invoice (method PAYPAL, payment_id = transaction_id).",
    inputSchema: z.object({}),
    execute: async () => {
      const invoices = await getInvoices();
      const transactions = await getTransactions();
      const result = matchTransactions(transactions, invoices, getStore().policy.reconciliation.amountTolerance);
      return { ...result, policy: getStore().policy.reconciliation };
    },
  }),

  draft_dispute_evidence: tool({
    description: "Assemble an evidence pack for a dispute from what Chaser knows (invoice line items, payment record, shipment tracking, reminder history) and draft the seller statement. Read-only. Use for disputes above the auto-accept limit; then call submit_dispute_evidence to send it through the PayPal Disputes API (the user's policy decides whether that needs approval).",
    inputSchema: z.object({ dispute_id: z.string() }),
    execute: async ({ dispute_id }) => {
      const r = await evidenceFor(dispute_id);
      if ("error" in r) return { error: r.error };
      const { d, pack } = r;
      if (currentMode() === "mock") d.evidence_draft = pack.draft;
      disputeOverlayFor(d.id).evidence_draft = pack.draft;
      bump();
      audit({ actor: "agent", tool: "draft_dispute_evidence", action: `Drafted evidence pack for dispute ${d.id} (${money(d.amount, d.currency)})${pack.invoice_number ? ` from ${pack.invoice_number}` : ""}`, decision: "info" });
      return {
        dispute_id: d.id,
        invoice_number: pack.invoice_number,
        respond_by: d.seller_response_due,
        stage: d.life_cycle_stage,
        evidence_type: pack.evidence_type,
        tracking: pack.tracking,
        draft: pack.draft,
        attachments_suggested: pack.attachments_suggested,
        next_step: d.evidence_submitted_at ? `Already submitted ${d.evidence_submitted_at.slice(0, 10)} via ${d.evidence_channel}.` : "Call submit_dispute_evidence with this dispute_id to send the pack to PayPal (Disputes API provide-evidence, or send-message while the dispute is an inquiry).",
      };
    },
  }),

  submit_dispute_evidence: tool({
    description: "Send the drafted evidence pack for a dispute to PayPal through the Disputes API: provide-evidence for a claim (CHARGEBACK stage), send-message while it is still an inquiry. Builds the pack from Chaser's records; pass `notes` to replace the seller statement. The user's policy (disputes.submitEvidence) decides whether this needs approval.",
    inputSchema: z.object({ dispute_id: z.string(), notes: z.string().max(2000).optional().describe("Override the generated statement (max 2000 characters)") }),
    execute: async ({ dispute_id, notes }) => {
      const r = await evidenceFor(dispute_id);
      if ("error" in r) return { error: r.error };
      const { d, pack } = r;
      if (d.evidence_submitted_at) return { error: `Evidence for ${d.id} was already submitted ${d.evidence_submitted_at.slice(0, 10)} via ${d.evidence_channel}.` };
      const submission = { evidence_type: pack.evidence_type, notes: (notes?.trim() || pack.notes).slice(0, 2000), tracking: pack.tracking };
      const result = (await execute("submit_dispute_evidence", { dispute_id: d.id, stage: d.life_cycle_stage, ...submission })) as { channel: "provide-evidence" | "send-message"; status: number; links?: unknown };
      const overlay = disputeOverlayFor(d.id);
      overlay.evidence_draft = pack.draft;
      overlay.evidence_submitted_at = new Date().toISOString();
      overlay.evidence_channel = result.channel;
      bump();
      const ev = evaluateAction("submit_dispute_evidence", { dispute_id: d.id }, { policy: getStore().policy, invoices: await getInvoices(), disputes: await getDisputes() });
      audit({ actor: "agent", tool: "submit_dispute_evidence", action: `Submitted evidence pack for dispute ${d.id} (${money(d.amount, d.currency)}) via Disputes API ${result.channel}`, decision: ev.decision === "approve" ? "approved" : "allowed", reason: `${ev.decision === "approve" ? "You approved this. " : ""}${ev.reason} HTTP ${result.status}.`, rule: ev.rule, input: submission, output: result });
      return { dispute_id: d.id, channel: result.channel, http_status: result.status, evidence_type: submission.evidence_type, tracking: submission.tracking, submitted_at: overlay.evidence_submitted_at, links: result.links };
    },
  }),

  set_chase_override: tool({
    description: "Pause, resume or change the chasing intensity for one invoice: paused | default | gentle | aggressive.",
    inputSchema: z.object({ invoice_id: z.string().describe("Invoice id or number"), override: z.enum(["default", "paused", "gentle", "aggressive"]) }),
    execute: async ({ invoice_id, override }) => {
      if (currentMode() === "mock") {
        const inv = findMockInvoice(invoice_id);
        setChaseOverride(inv, override);
        return { invoice_id: inv.id, invoice_number: inv.invoice_number, chase_override: override };
      }
      const invoices = await getInvoices();
      const inv = invoices.find((i) => i.id === invoice_id || i.invoice_number === invoice_id);
      if (!inv) return { error: `Invoice ${invoice_id} not found` };
      overlayFor(inv.id).chase_override = override;
      bump();
      return { invoice_id: inv.id, invoice_number: inv.invoice_number, chase_override: override };
    },
  }),
};

export type LocalTools = typeof localTools;
