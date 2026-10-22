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
import { isOpenInvoice, money, round2, unappliedAmount, type AfterFinalResolution } from "../paypal/types";
import { audit, bump, disputeOverlayFor, getStore, overlayFor } from "../store";
import { overdueDays, planCollections } from "./chase";
import { buildEvidencePack } from "./evidence";
import { payerProfiles, predictInvoice, unknownProfile } from "./payer-history";
import { classifyReply, describePromise, promiseStatus } from "./promise";
import { decideAfterFinal, planAfterFinal } from "./after-final";
import { buildHandoffPack, buildStatement } from "./statement";
import { matchTransactions } from "./reconcile";
import { payerSignals } from "./signals";

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
        // The cadence / channel decisions themselves go in the ledger, with the numbers they rest on.
        if (p.rule === "reminders.adaptToHistory") audit({ actor: "policy", tool: "propose_collections", action: `${p.invoice_number} ${p.client}: ${p.stage} stage brought ${p.risk === "late-risk" ? "forward" : "back"} by payer history`, decision: "allowed", reason: p.why, rule: p.rule });
        if (p.channel === "resend") audit({ actor: "policy", tool: "propose_collections", action: `${p.invoice_number} ${p.client}: never opened on PayPal, re-delivered with an address check instead of a ${p.stage} reminder`, decision: "allowed", reason: p.why, rule: "reminders.unviewedStrategy" });
      }
      const skipped = invoices
        .filter(isOpenInvoice)
        .filter((i) => !proposals.some((p) => p.invoice_id === i.id))
        .map((i) => ({ invoice_number: i.invoice_number, overdue_days: overdueDays(i, now), reason: i.chase_override === "paused" ? "chasing paused" : promiseStatus(i, now, store.policy) === "open" && store.policy.promises.pauseChasing ? `promise to pay by ${i.promise!.pay_by} (promises.pauseChasing)` : i.reminders.length >= store.policy.reminders.maxReminders ? "max reminders reached" : overdueDays(i, now) < store.policy.reminders.friendlyAfterDays ? "not yet due for a reminder" : "already reminded at this stage / too soon since last reminder" }));
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

  classify_client_reply: tool({
    description: "Read a client's reply (pasted email or message) and say what it is: a promise to pay (with the date and amount), a claim that payment was already sent, a dispute, or unknown. Read-only; then call record_promise for a promise, match_payments for a paid claim.",
    inputSchema: z.object({ text: z.string().min(1).max(4000), invoice_id: z.string().optional().describe("Invoice id or number the reply is about, if known") }),
    execute: async ({ text, invoice_id }) => {
      const now = new Date();
      const c = classifyReply(text, now);
      const invoices = await getInvoices();
      const inv = invoice_id ? invoices.find((i) => i.id === invoice_id || i.invoice_number === invoice_id) : undefined;
      return { ...c, invoice_id: inv?.id, invoice_number: inv?.invoice_number, balance_due: inv?.due, next_step: c.kind === "promise" && c.pay_by ? "Call record_promise with this invoice, pay_by and amount." : c.kind === "promise" ? "The client promised but gave no date; ask for one or record a date the user confirms." : c.kind === "paid-claim" ? "Call match_payments to look for the payment; if nothing arrived, tell the user." : c.kind === "dispute" ? "Do not chase; tell the user what the client objects to." : "Show the reply to the user." };
    },
  }),

  record_promise: tool({
    description: "Record a client's promise to pay an invoice by a date (optionally a specific amount). Chasing pauses until then (promises.pauseChasing); if the money has not arrived by pay_by + graceDays the next reminder escalates one stage and cites the broken promise (promises.brokenEscalates). Use the invoice id or number.",
    inputSchema: z.object({
      invoice_id: z.string().describe("Invoice id or number"),
      pay_by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("yyyy-mm-dd"),
      amount: z.number().positive().optional().describe("Promised amount; omit for the whole balance"),
      source: z.enum(["client_reply", "user", "agent"]).default("client_reply"),
      quote: z.string().max(500).optional().describe("The client's words"),
    }),
    execute: async ({ invoice_id, pay_by, amount, source, quote }) => {
      const now = new Date();
      const invoices = await getInvoices();
      const inv = currentMode() === "mock" ? findMockInvoice(invoice_id) : invoices.find((i) => i.id === invoice_id || i.invoice_number === invoice_id);
      if (!inv) return { error: `Invoice ${invoice_id} not found` };
      if (!isOpenInvoice(inv)) return { error: `Invoice ${inv.invoice_number} is ${inv.status}; nothing to promise.` };
      const promise = { pay_by, amount, balance_at_record: inv.due, recorded_at: now.toISOString(), source, quote };
      if (currentMode() === "mock") inv.promise = promise;
      overlayFor(inv.id).promise = promise;
      bump();
      const ev = evaluateAction("record_promise", { invoice_id: inv.id, pay_by, amount }, { policy: getStore().policy, invoices, disputes: await getDisputes(), now });
      audit({ actor: "agent", tool: "record_promise", action: `${inv.client.business ?? inv.client.email} ${describePromise(promise, "open")} on ${inv.invoice_number}`, decision: ev.decision === "approve" ? "approved" : "allowed", reason: `${ev.decision === "approve" ? "You approved this. " : ""}${ev.reason}${quote ? ` Client: "${quote.slice(0, 160)}"` : ""}`, rule: ev.rule, input: { invoice_id: inv.id, pay_by, amount, source } });
      return { invoice_id: inv.id, invoice_number: inv.invoice_number, client: inv.client.business ?? inv.client.email, balance_due: inv.due, promise, status: promiseStatus({ ...inv, promise }, now, getStore().policy), chasing: getStore().policy.promises.pauseChasing ? `paused until ${pay_by} (+${getStore().policy.promises.graceDays} grace)` : "unchanged" };
    },
  }),

  propose_after_final: tool({
    description: "Apply collections.afterFinal to every open invoice whose final notice is at least waitDays old: proposes write_off (balance under writeOffUnder), settlement (a discounted replacement invoice) or handoff (a pack with the statement of account, chase history and evidence). Read-only; then call resolve_after_final per proposal (the policy decides what needs approval).",
    inputSchema: z.object({ invoice_ids: z.array(z.string()).optional() }),
    execute: async ({ invoice_ids }) => {
      const store = getStore();
      let invoices = await getInvoices();
      if (invoice_ids?.length) invoices = invoices.filter((i) => invoice_ids.includes(i.id) || invoice_ids.includes(i.invoice_number));
      const proposals = planAfterFinal(invoices, store.policy, new Date());
      // Payer signals ride along: one search per client, attached to every proposal for that client.
      const byClient = new Map<string, Awaited<ReturnType<typeof payerSignals>>>();
      for (const p of proposals) {
        const key = p.email.toLowerCase();
        if (!byClient.has(key)) {
          const inv = invoices.find((i) => i.client.email.toLowerCase() === key);
          const sig = await payerSignals({ business: inv?.client.business, name: p.client, email: p.email, demoClient: currentMode() === "mock" });
          byClient.set(key, sig);
          // The news check is part of the decision, so it is on the record like any other check.
          audit({ actor: "agent", tool: "propose_after_final", action: `Payer signals for ${inv?.client.business ?? p.client}: ${sig.risk} (${sig.source}${sig.live_probe ? `, live probe ${sig.live_probe.results} hits` : ""})`, decision: "info", reason: sig.recommendation, input: { query: sig.query }, output: { risk: sig.risk, evidence: sig.evidence.map((e) => e.title), live_probe: sig.live_probe } });
        }
      }
      const enriched = proposals.map((p) => {
        const sig = byClient.get(p.email.toLowerCase())!;
        return { ...p, signals: { source: sig.source, risk: sig.risk, recommendation: sig.recommendation, evidence: sig.evidence.map((e) => ({ title: e.title, url: e.url, published_date: e.published_date })), live_probe: sig.live_probe } };
      });
      return { now: new Date().toISOString(), policy: store.policy.collections.afterFinal, proposals: enriched };
    },
  }),

  resolve_after_final: tool({
    description: "Carry out an after-final resolution on one invoice: write_off (cancel the invoice on PayPal and record the write-off), settlement (create and send a replacement invoice discounted by collections.afterFinal.settlementOfferPercent, pause the original), or handoff (build the hand-off pack: statement of account + chase history + evidence; pause chasing). The policy engine decides which of these need the user's approval.",
    inputSchema: z.object({ invoice_id: z.string().describe("Invoice id or number"), resolution: z.enum(["write_off", "settlement", "handoff"]), note: z.string().max(500).optional() }),
    execute: async ({ invoice_id, resolution, note }) => {
      const now = new Date();
      const store = getStore();
      const [invoices, transactions] = await Promise.all([getInvoices(), getTransactions()]);
      const inv = currentMode() === "mock" ? findMockInvoice(invoice_id) : invoices.find((i) => i.id === invoice_id || i.invoice_number === invoice_id);
      if (!inv) return { error: `Invoice ${invoice_id} not found` };
      if (!isOpenInvoice(inv)) return { error: `Invoice ${inv.invoice_number} is ${inv.status}.` };
      if (inv.resolution) return { error: `${inv.invoice_number} already has a resolution: ${inv.resolution.kind} on ${inv.resolution.at.slice(0, 10)}.` };
      const ev = evaluateAction("resolve_after_final", { invoice_id: inv.id, resolution }, { policy: store.policy, invoices, disputes: await getDisputes(), now });
      const decided = decideAfterFinal(inv, store.policy);
      const ctx = { invoices, transactions, now, merchant: merchantProfile(), policy: store.policy };
      let result: AfterFinalResolution;
      let detail: Record<string, unknown> = {};
      if (resolution === "write_off") {
        await execute("cancel_sent_invoice", { invoice_id: inv.id, note: note ?? `Invoice ${inv.invoice_number} written off after final notice.`, send_to_recipient: true, send_to_invoicer: false });
        result = { kind: "write_off", at: now.toISOString(), amount: inv.due, note, rule: "collections.afterFinal.writeOffUnder" };
      } else if (resolution === "settlement") {
        const af = store.policy.collections.afterFinal;
        const offer = round2(inv.due * (1 - af.settlementOfferPercent / 100));
        const payBy = new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
        const m = merchantProfile();
        const created = (await execute("create_invoice", {
          currency_code: inv.currency,
          invoice_date: now.toISOString().slice(0, 10),
          note: `Settlement offer for invoice ${inv.invoice_number}: pay ${money(offer, inv.currency)} by ${payBy} (due ${payBy}) and the remaining ${money(round2(inv.due - offer), inv.currency)} is waived. After that date the full ${money(inv.due, inv.currency)} on ${inv.invoice_number} stands.${note ? ` ${note}` : ""}`,
          invoicer_business_name: m.businessName,
          invoicer_given_name: m.givenName,
          invoicer_surname: m.surname,
          invoicer_email_address: m.invoicerEmail,
          primary_recipients: [{ billing_info: { business_name: inv.client.business, name: { given_name: inv.client.given_name, surname: inv.client.surname }, email_address: inv.client.email } }],
          items: [{ name: `Settlement of ${inv.invoice_number}: ${af.settlementOfferPercent}% off ${money(inv.due, inv.currency)}`, description: inv.items.map((i) => i.name).join(", "), quantity: "1", unit_amount: { currency_code: inv.currency, value: offer.toFixed(2) } }],
        })) as { id: string; detail?: { invoice_number?: string } };
        await execute("send_invoice", { invoice_id: created.id, send_to_recipient: true });
        const offerNumber = created.detail?.invoice_number ?? (await getInvoices()).find((i) => i.id === created.id)?.invoice_number ?? created.id;
        result = { kind: "settlement", at: now.toISOString(), amount: inv.due, offer_amount: offer, offer_invoice_id: created.id, offer_invoice_number: offerNumber, note, rule: "collections.afterFinal.settlementOfferPercent" };
        detail = { offer_invoice_id: created.id, offer_invoice_number: offerNumber, pay_by: payBy };
        if (currentMode() === "mock") inv.chase_override = "paused";
        overlayFor(inv.id).chase_override = "paused";
      } else {
        const pack = buildHandoffPack(inv, ctx);
        result = { kind: "handoff", at: now.toISOString(), amount: inv.due, pack, note, rule: "collections.afterFinal.handoff" };
        detail = { pack };
        if (currentMode() === "mock") inv.chase_override = "paused";
        overlayFor(inv.id).chase_override = "paused";
      }
      if (currentMode() === "mock") inv.resolution = result;
      overlayFor(inv.id).resolution = result;
      bump();
      const label = resolution === "write_off" ? `written off ${money(inv.due, inv.currency)}` : resolution === "settlement" ? `settlement offered: ${money(result.offer_amount!, inv.currency)} on ${result.offer_invoice_number}` : "hand-off pack built, chasing paused";
      audit({ actor: "agent", tool: "resolve_after_final", action: `${inv.invoice_number} ${inv.client.business ?? inv.client.email}: ${label}`, decision: ev.decision === "approve" ? "approved" : "allowed", reason: `${ev.decision === "approve" ? "You approved this. " : ""}${decided.resolution === resolution ? decided.why : `chosen by you (policy would propose ${decided.resolution})`}. ${ev.reason}`, rule: result.rule, input: { invoice_id: inv.id, resolution }, output: detail.pack ? { ...detail, pack: `${String(detail.pack).length} chars` } : detail });
      return { invoice_id: inv.id, invoice_number: inv.invoice_number, client: inv.client.business ?? inv.client.email, resolution: result, ...detail };
    },
  }),

  get_statement_of_account: tool({
    description: "Statement of account for one client (by business name, person name, email or invoice number): every open invoice with aging buckets, one total, pay links, promises and reminders, plus recently settled invoices, as Markdown. Read-only.",
    inputSchema: z.object({ query: z.string().min(1) }),
    execute: async ({ query }) => {
      const q = query.trim().toLowerCase();
      const [invoices, transactions] = await Promise.all([getInvoices(), getTransactions()]);
      const words = q.split(/\s+/).filter(Boolean);
      const hit = invoices.find((i) => {
        const hay = [i.client.business, i.client.given_name, i.client.surname, i.client.email, i.invoice_number].filter(Boolean).join(" ").toLowerCase();
        return words.length > 0 && words.every((w) => hay.includes(w));
      });
      if (!hit) return { error: `No client matched "${query}".` };
      const st = buildStatement(hit.client.email, { invoices, transactions, now: new Date(), merchant: merchantProfile(), policy: getStore().policy });
      return st ?? { error: `No invoices for ${hit.client.email}.` };
    },
  }),

  check_payer_signals: tool({
    description: "What the open web says about a client right now (bankruptcy, layoffs, acquisition, funding) from a news search, with the articles as evidence and a recommendation. Call it before a final notice, a settlement offer or a hand-off, and when a client goes quiet. Uses Tavily when TAVILY_API_KEY is set; otherwise returns a labelled demo result.",
    inputSchema: z.object({ business: z.string().optional().describe("Client business name"), email: z.string().optional().describe("Client email; a company domain sharpens the search"), name: z.string().optional().describe("Contact name, only if there is no business name") }),
    execute: async (input) => {
      const result = await payerSignals({ ...input, demoClient: currentMode() === "mock" });
      audit({ actor: "agent", tool: "check_payer_signals", action: `${result.query || "(no query)"}: ${result.risk} (${result.source}${result.live_probe ? `, live probe ${result.live_probe.results} hits` : ""})`, decision: "info", reason: result.recommendation, input, output: { risk: result.risk, evidence: result.evidence.length, live_probe: result.live_probe } });
      return result;
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
