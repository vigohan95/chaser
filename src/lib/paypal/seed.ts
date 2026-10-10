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
    invoicer_email_address: m.email,
    primary_recipients: [{ billing_info: { business_name: inv.client.business, name: { given_name: inv.client.given_name, surname: inv.client.surname }, email_address: inv.client.email.replace(".example", ".example.com") } }],
    items: inv.items.map((i) => ({ name: i.name, description: i.description, quantity: i.quantity, unit_amount: { currency_code: inv.currency, value: i.unit_amount.toFixed(2) } })),
  };
}

export async function seedSandbox(opts: { send?: boolean; limit?: number; log?: (m: string) => void } = {}): Promise<SeedReport> {
  const log = opts.log ?? (() => {});
  const invoices = buildInvoices(new Date()).filter((i) => i.status !== "PAID" && i.status !== "PARTIALLY_REFUNDED").slice(0, opts.limit ?? 12);
  const report: SeedReport = { created: [], failed: [] };
  for (const inv of invoices) {
    try {
      const created = (await liveExecute("create_invoice", toCreateInput(inv))) as { id?: string; href?: string };
      const id = created.id ?? created.href?.split("/").pop() ?? "";
      let status = "DRAFT";
      if ((opts.send ?? true) && inv.status !== "DRAFT" && id) {
        await liveExecute("send_invoice", { invoice_id: id, send_to_recipient: true });
        status = "SENT";
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
