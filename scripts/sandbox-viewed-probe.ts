/*
 * Does Invoicing v2 expose the "recipient viewed the invoice" signal, and what does the sandbox return for it?
 *
 *   npx tsx scripts/sandbox-viewed-probe.ts [--ids=INV2-...,INV2-...] [--out=docs/sandbox-evidence]
 *
 * Plain REST (GET /v2/invoicing/invoices/{id}) with the app's own credentials so the `paypal-debug-id` response header
 * can be recorded next to `detail.viewed_by_recipient`; the toolkit's get_invoice is run on the same id for comparison.
 * Reads .env.local; never prints or stores credentials.
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

async function main() {
  loadEnv(".env.local");
  loadEnv(".env");
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    console.error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing in .env.local");
    process.exit(1);
  }
  process.env.MOCK_PAYPAL = "0";
  const { getAccessToken, paypalBaseUrl } = await import("../src/lib/paypal/rest");
  const { liveExecute, mapInvoice } = await import("../src/lib/paypal/live");

  let ids = (arg("ids") ?? "").split(",").filter(Boolean);
  if (!ids.length) {
    const list = (await liveExecute("list_invoices", { page: 1, page_size: 20, total_required: true })) as { items?: Array<{ id: string }> };
    ids = (list.items ?? []).map((i) => i.id);
  }
  const token = await getAccessToken();
  const results: unknown[] = [];
  for (const id of ids) {
    const res = await fetch(`${paypalBaseUrl()}/v2/invoicing/invoices/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json().catch(() => ({}))) as { id?: string; status?: string; detail?: Record<string, unknown> };
    const detail = body.detail ?? {};
    const meta = (detail.metadata ?? {}) as Record<string, unknown>;
    const viaToolkit = (await liveExecute("get_invoice", { invoice_id: id }).catch((e: Error) => ({ error: e.message }))) as { detail?: Record<string, unknown>; error?: string };
    const mapped = viaToolkit.error ? undefined : mapInvoice(viaToolkit);
    void mapped;
    const row = {
      invoice_id: id,
      invoice_number: detail.invoice_number,
      status: body.status,
      http_status: res.status,
      paypal_debug_id: res.headers.get("paypal-debug-id"),
      rest: { field_present: Object.prototype.hasOwnProperty.call(detail, "viewed_by_recipient"), viewed_by_recipient: detail.viewed_by_recipient, first_sent_time: meta.first_sent_time, last_sent_time: meta.last_sent_time, last_update_time: meta.last_update_time },
      toolkit_get_invoice: viaToolkit.error ? { error: viaToolkit.error } : { field_present: Object.prototype.hasOwnProperty.call(viaToolkit.detail ?? {}, "viewed_by_recipient"), viewed_by_recipient: viaToolkit.detail?.viewed_by_recipient },
    };
    results.push(row);
    console.log(`${id} ${String(detail.invoice_number)} ${body.status} http=${res.status} debug_id=${row.paypal_debug_id} viewed_by_recipient=${String(detail.viewed_by_recipient)} (present=${row.rest.field_present})`);
  }
  const out = resolve(process.cwd(), arg("out") ?? "docs/sandbox-evidence");
  mkdirSync(out, { recursive: true });
  const file = resolve(out, `viewed-by-recipient-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        ran_at: new Date().toISOString(),
        environment: "sandbox",
        base_url: paypalBaseUrl(),
        endpoint: "GET /v2/invoicing/invoices/{invoice_id} (plain REST, same app credentials) + toolkit get_invoice",
        question: "Does Invoicing v2 expose detail.viewed_by_recipient, and is it ever true in this sandbox?",
        invoices_checked: results.length,
        field_present_on_all: results.every((r) => (r as { rest: { field_present: boolean } }).rest.field_present),
        any_true: results.some((r) => (r as { rest: { viewed_by_recipient?: boolean } }).rest.viewed_by_recipient === true),
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${file}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
