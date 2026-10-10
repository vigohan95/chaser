/*
 * Exercise the real PayPal sandbox path and write evidence: `npm run sandbox:check` (reads .env.local).
 *
 *   --remind=<invoice_id>      send one reminder through send_invoice_reminder
 *   --record=<invoice_id>:<transaction_id>:<amount>   record a payment on an invoice (reconciliation write-back)
 *   --evidence=<dispute_id>    build the evidence pack and submit it via the Disputes API (provide-evidence / send-message)
 *   --out=<dir>                evidence folder (default docs/sandbox-evidence)
 *
 * Writes <out>/sandbox-run-<date>.json with the calls made, their HTTP outcome and the mapped domain objects.
 * Never prints or stores credentials; raw PayPal responses are truncated to the first three items.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(file: string) {
  try {
    for (const line of readFileSync(resolve(process.cwd(), file), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && (process.env[m[1]] === undefined || process.env[m[1]] === "")) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no file */
  }
}

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

interface CallRecord {
  call: string;
  input: unknown;
  ok: boolean;
  ms: number;
  summary?: unknown;
  error?: string;
}

async function main() {
  loadEnv(".env.local");
  loadEnv(".env");
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    console.error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing in .env.local");
    process.exit(1);
  }
  process.env.MOCK_PAYPAL = "0";
  const { liveExecute, mapDispute, mapInvoice, mapTransaction } = await import("../src/lib/paypal/live");
  const { buildEvidencePack } = await import("../src/lib/agent/evidence");
  const { merchantProfile } = await import("../src/lib/env");

  const out = resolve(process.cwd(), arg("out") ?? "docs/sandbox-evidence");
  mkdirSync(out, { recursive: true });
  const calls: CallRecord[] = [];
  const raw: Record<string, unknown> = {};

  async function call<T>(name: string, input: unknown, fn: () => Promise<T>, summarize: (v: T) => unknown): Promise<T | undefined> {
    const t0 = Date.now();
    try {
      const v = await fn();
      const summary = summarize(v);
      calls.push({ call: name, input, ok: true, ms: Date.now() - t0, summary });
      console.log(`ok   ${name} (${Date.now() - t0} ms)`, JSON.stringify(summary).slice(0, 300));
      return v;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      calls.push({ call: name, input, ok: false, ms: Date.now() - t0, error });
      console.log(`FAIL ${name}: ${error}`);
      return undefined;
    }
  }

  const truncate = (v: unknown, key: string) => {
    const o = (v ?? {}) as Record<string, unknown>;
    const arr = Array.isArray(o[key]) ? (o[key] as unknown[]) : [];
    return { ...o, [key]: arr.slice(0, 3), _total_in_response: arr.length };
  };

  // 1. Lists (what the command center calls on every refresh)
  const inv = await call("list_invoices", { page: 1, page_size: 50, total_required: true }, () => liveExecute("list_invoices", { page: 1, page_size: 50, total_required: true }), (v) => {
    const items = ((v as { items?: unknown[] }).items ?? []).map(mapInvoice);
    return { count: items.length, invoices: items.map((i) => ({ id: i.id, number: i.invoice_number, status: i.status, total: i.total, paid: i.paid, due: i.due, due_date: i.due_date, client: i.client.email, items: i.items.length })) };
  });
  raw.list_invoices = truncate(inv, "items");

  const end = new Date();
  const start = new Date(end.getTime() - 31 * 86_400_000);
  const txInput = { start_date: start.toISOString(), end_date: end.toISOString(), transaction_status: "S", page_size: 100, page: 1 };
  const txn = await call("list_transactions", txInput, () => liveExecute("list_transactions", txInput), (v) => {
    const items = ((v as { transaction_details?: unknown[] }).transaction_details ?? []).map(mapTransaction);
    return { count: items.length, transactions: items.map((t) => ({ id: t.id, date: t.date, type: t.type, amount: t.amount, fee: t.fee, payer: t.payer_email, invoice_id: t.invoice_id, memo: t.memo })) };
  });
  raw.list_transactions = truncate(txn, "transaction_details");

  const dis = await call("list_disputes", { page_size: 50, page: 1 }, () => liveExecute("list_disputes", { page_size: 50, page: 1 }), (v) => {
    const items = ((v as { items?: unknown[] }).items ?? []).map(mapDispute);
    return { count: items.length, disputes: items.map((d) => ({ id: d.id, status: d.status, stage: d.life_cycle_stage, amount: d.amount, reason: d.reason, transaction_id: d.transaction_id, buyer: d.buyer_email })) };
  });
  raw.list_disputes = truncate(dis, "items");

  // 2. One invoice in detail (the list omits line items on some accounts; get_invoice always has them)
  const firstId = (((inv as { items?: unknown[] })?.items ?? [])[0] as { id?: string } | undefined)?.id;
  if (firstId) {
    const detail = await call("get_invoice", { invoice_id: firstId }, () => liveExecute("get_invoice", { invoice_id: firstId }), (v) => {
      const i = mapInvoice(v);
      return { id: i.id, number: i.invoice_number, status: i.status, total: i.total, due: i.due, items: i.items, links: i.links };
    });
    raw.get_invoice = detail;
  }

  // 3. Optional writes
  const remind = arg("remind");
  if (remind) {
    const input = { invoice_id: remind, subject: "Quick nudge from Chaser (sandbox)", note: "Hi - this is a sandbox reminder sent by Chaser through the PayPal Agent Toolkit. No action needed." };
    raw.send_invoice_reminder = await call("send_invoice_reminder", input, () => liveExecute("send_invoice_reminder", input), (v) => v);
  }
  const record = arg("record");
  if (record) {
    const [invoice_id, payment_id, amount] = record.split(":");
    const input = { invoice_id, method: "PAYPAL", payment_id, amount: { currency_code: merchantProfile().currency, value: Number(amount).toFixed(2) }, note: "Recorded by Chaser (sandbox reconciliation check)" };
    raw.record_payment_for_invoice = await call("record_payment_for_invoice", input, () => liveExecute("record_payment_for_invoice", input), (v) => v);
  }
  const evidence = arg("evidence");
  if (evidence) {
    const disputes = ((dis as { items?: unknown[] })?.items ?? []).map(mapDispute);
    const d = disputes.find((x) => x.id === evidence);
    if (!d) console.log(`dispute ${evidence} not in list_disputes`);
    else {
      const invoices = ((inv as { items?: unknown[] })?.items ?? []).map(mapInvoice);
      const transactions = ((txn as { transaction_details?: unknown[] })?.transaction_details ?? []).map(mapTransaction);
      const pack = buildEvidencePack(d, { invoices, transactions, trackings: [], merchant: merchantProfile() });
      raw.evidence_pack = pack;
      const input = { dispute_id: d.id, stage: d.life_cycle_stage, evidence_type: pack.evidence_type, notes: pack.notes, tracking: pack.tracking };
      raw.submit_dispute_evidence = await call("submit_dispute_evidence", { ...input, notes: `${pack.notes.slice(0, 80)}...` }, () => liveExecute("submit_dispute_evidence", input), (v) => v);
    }
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const file = resolve(out, `sandbox-run-${stamp}.json`);
  writeFileSync(file, JSON.stringify({ ran_at: new Date().toISOString(), environment: "sandbox", base_url: "https://api-m.sandbox.paypal.com", toolkit: "@paypal/agent-toolkit 1.11.0", calls, raw }, null, 2));
  console.log(`\n${calls.filter((c) => c.ok).length}/${calls.length} calls succeeded. Evidence: ${file}`);
  if (calls.some((c) => !c.ok)) process.exitCode = 1;
}

main();
