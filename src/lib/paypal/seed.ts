/**
 * Seed the PayPal *sandbox* with the same demo story as the mock fixtures, through the Agent Toolkit tools.
 * Zero cost: sandbox invoices are play money. Run with `npm run seed` (needs PAYPAL_CLIENT_ID/SECRET).
 */
import { merchantProfile } from "../env";
import { buildInvoices } from "./fixtures";
import { liveExecute } from "./live";
import type { Invoice } from "./types";

export interface SeedReport {
  created: Array<{ invoice_number: string; id: string; status: string }>;
  failed: Array<{ invoice_number: string; error: string }>;
}

function toCreateInput(inv: Invoice) {
  const m = merchantProfile();
  return {
    currency_code: inv.currency,
    invoice_number: inv.invoice_number,
    invoice_date: inv.invoice_date,
    reference: inv.reference,
    note: `${inv.note ? inv.note + " " : ""}Net terms - due ${inv.due_date}.`,
    invoicer_business_name: m.businessName,
    invoicer_given_name: m.givenName,
    invoicer_surname: m.surname,
    invoicer_email_address: m.invoicerEmail,
    primary_recipients: [{ billing_info: { business_name: inv.client.business, name: { given_name: inv.client.given_name, surname: inv.client.surname }, email_address: inv.client.email.replace(".example", ".example.com") } }],
    items: inv.items.map((i) => ({ name: i.name, description: i.description, quantity: i.quantity, unit_amount: { currency_code: inv.currency, value: i.unit_amount.toFixed(2) } })),
  };
}

/** Invoices already in the sandbox, by invoice number (the list omits line items, which the seed does not need). */
async function existingByNumber(): Promise<Map<string, { id: string; status: string }>> {
  const out = new Map<string, { id: string; status: string }>();
  const res = (await liveExecute("list_invoices", { page: 1, page_size: 100, total_required: true })) as { items?: Array<{ id?: string; status?: string; detail?: { invoice_number?: string } }> };
  for (const it of res.items ?? []) if (it.detail?.invoice_number && it.id) out.set(it.detail.invoice_number, { id: it.id, status: it.status ?? "" });
  return out;
}

/**
 * Idempotent: an invoice number that already exists as a DRAFT is deleted and re-created (drafts from an earlier
 * run may carry rejected fields); one that was already sent is reused as is.
 */
export async function seedSandbox(opts: { send?: boolean; limit?: number; log?: (m: string) => void } = {}): Promise<SeedReport> {
  const log = opts.log ?? (() => {});
  const invoices = buildInvoices(new Date()).filter((i) => i.status !== "PAID" && i.status !== "PARTIALLY_REFUNDED").slice(0, opts.limit ?? 12);
  const report: SeedReport = { created: [], failed: [] };
  const existing = await existingByNumber();
  for (const inv of invoices) {
    try {
      const prior = existing.get(inv.invoice_number);
      let id = "";
      let status = "DRAFT";
      if (prior && prior.status !== "DRAFT") {
        id = prior.id;
        status = prior.status;
        log(`exists ${inv.invoice_number} -> ${id} (${status}), reused`);
      } else {
        if (prior) {
          await liveExecute("delete_invoice", { invoice_id: prior.id });
          log(`deleted stale draft ${inv.invoice_number} (${prior.id})`);
        }
        const created = (await liveExecute("create_invoice", toCreateInput(inv))) as { id?: string; href?: string };
        id = created.id ?? created.href?.split("/").pop() ?? "";
        if ((opts.send ?? true) && inv.status !== "DRAFT" && id) {
          await liveExecute("send_invoice", { invoice_id: id, send_to_recipient: true });
          status = "SENT";
        }
      }
      report.created.push({ invoice_number: inv.invoice_number, id, status });
      log(`created ${inv.invoice_number} -> ${id} (${status})`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      report.failed.push({ invoice_number: inv.invoice_number, error });
      log(`failed ${inv.invoice_number}: ${error}`);
    }
  }
  return report;
}
