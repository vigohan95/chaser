"use client";

import { useState } from "react";
import { daysSinceFinal, decideAfterFinal } from "@/lib/agent/after-final";
import { highestStageSent, overdueDays } from "@/lib/agent/chase";
import { describePromise, promiseStatus } from "@/lib/agent/promise";
import type { Statement } from "@/lib/agent/statement";
import type { Invoice } from "@/lib/paypal/types";
import { isOpenInvoice } from "@/lib/paypal/types";
import type { Policy } from "@/lib/policy/schema";
import { shortDate, usd } from "./grid";

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * The selected invoice: chase history, promise, PayPal's viewed flag, what the policy will do after the final notice,
 * the hand-off pack once built, and the client's statement of account (read from /api/statement, downloadable as .md).
 */
export default function InvoiceDetail({ invoice, policy, now, fetchStatement, onAsk, busy }: { invoice: Invoice; policy: Policy; now: Date; fetchStatement: (email: string) => Promise<Statement | undefined>; onAsk: (text: string) => void; busy: boolean }) {
  const [statement, setStatement] = useState<Statement | undefined>();
  const [loading, setLoading] = useState(false);
  const [forId, setForId] = useState(invoice.id);
  if (forId !== invoice.id) {
    setForId(invoice.id);
    setStatement(undefined);
  }
  const open = isOpenInvoice(invoice);
  const od = overdueDays(invoice, now);
  const ps = promiseStatus(invoice, now, policy);
  const since = daysSinceFinal(invoice, now);
  const afterFinal = open && highestStageSent(invoice) === "final" && !invoice.resolution ? decideAfterFinal(invoice, policy) : undefined;
  const client = invoice.client.business ?? `${invoice.client.given_name} ${invoice.client.surname}`;

  const loadStatement = async () => {
    setLoading(true);
    setStatement(await fetchStatement(invoice.client.email));
    setLoading(false);
  };

  return (
    <div className="max-h-72 overflow-auto rounded-md border border-border bg-panel p-3 text-xs" data-testid="invoice-detail">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-semibold">
          {invoice.invoice_number} - {client} - {usd(invoice.due, invoice.currency)} {open ? (od > 0 ? `${od} days overdue` : `due ${shortDate(invoice.due_date)}`) : invoice.status.replaceAll("_", " ").toLowerCase()}
        </span>
        <span className="ml-auto flex flex-wrap gap-2">
          <button className="btn" onClick={loadStatement} disabled={loading} title="All of this client's open invoices, aging, one total and one pay action, as Markdown">
            {loading ? "Building..." : "Statement of account"}
          </button>
          {invoice.resolution?.pack && (
            <button className="btn btn-primary" onClick={() => download(`handoff-${invoice.invoice_number}.md`, invoice.resolution!.pack!)}>
              Download hand-off pack
            </button>
          )}
          {afterFinal && !invoice.resolution && (
            <button className="btn btn-primary" disabled={busy} onClick={() => onAsk(`${afterFinal.resolution === "write_off" ? "Write off" : afterFinal.resolution === "settlement" ? "Offer a settlement on" : "Hand off"} ${invoice.invoice_number}`)} title={afterFinal.why}>
              {afterFinal.resolution === "write_off" ? `Write off ${usd(invoice.due)}` : afterFinal.resolution === "settlement" ? `Offer ${afterFinal.offer_percent}% settlement (${usd(afterFinal.offer_amount)})` : "Build hand-off pack"}
            </button>
          )}
        </span>
      </div>
      <div className="grid gap-x-6 gap-y-1 md:grid-cols-2">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">Chase history</div>
          {invoice.reminders.length === 0 ? <div className="text-muted">No reminders sent.</div> : invoice.reminders.map((r, k) => <div key={k}>{shortDate(r.at)}: {r.stage}{r.subject ? ` - ${r.subject}` : ""}</div>)}
          {invoice.promise && ps && <div className={ps === "broken" ? "text-bad" : ps === "kept" ? "text-ok" : "text-accent"}>{shortDate(invoice.promise.recorded_at)}: client {describePromise(invoice.promise, ps)}{invoice.promise.quote ? ` - "${invoice.promise.quote}"` : ""}</div>}
          {invoice.viewed_by_recipient !== undefined && open && <div>PayPal: {invoice.viewed_by_recipient ? "invoice opened by the recipient" : "invoice never opened by the recipient"}</div>}
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">After the final notice</div>
          {invoice.resolution ? (
            <div>
              {invoice.resolution.kind === "write_off" ? `Written off ${usd(invoice.resolution.amount)}` : invoice.resolution.kind === "settlement" ? `Settlement offered: ${usd(invoice.resolution.offer_amount)} on ${invoice.resolution.offer_invoice_number ?? "a new invoice"}` : "Hand-off pack built"} on {shortDate(invoice.resolution.at)} <span className="font-mono text-[11px] text-muted">({invoice.resolution.rule})</span>
            </div>
          ) : afterFinal ? (
            <div>
              {since !== undefined && since < policy.collections.afterFinal.waitDays ? `Final notice sent ${since} day(s) ago; the policy waits ${policy.collections.afterFinal.waitDays} days, then: ` : "Due now: "}
              <span className="font-semibold">{afterFinal.resolution.replace("_", "-")}</span> - {afterFinal.why} <span className="font-mono text-[11px] text-muted">({afterFinal.rule})</span>
            </div>
          ) : (
            <div className="text-muted">{open ? `Not at final notice yet. Policy after final: write off under ${usd(policy.collections.afterFinal.writeOffUnder)}, ${policy.collections.afterFinal.settlementOfferPercent}% settlement up to ${usd(policy.collections.afterFinal.settlementMaxBalance)}, otherwise hand-off (${policy.collections.afterFinal.handoff}).` : "Closed."}</div>
          )}
        </div>
      </div>
      {invoice.resolution?.pack && (
        <details className="mt-2" open>
          <summary className="cursor-pointer font-semibold">Hand-off pack</summary>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{invoice.resolution.pack}</pre>
        </details>
      )}
      {statement && (
        <details className="mt-2" open>
          <summary className="cursor-pointer font-semibold">
            Statement of account - {statement.client.business ?? statement.client.name}: {usd(statement.total_open)} open across {statement.open_invoices} invoice(s), {usd(statement.total_overdue)} overdue
            <button className="btn ml-2" onClick={() => download(`statement-${(statement.client.business ?? statement.client.name).replace(/\W+/g, "-")}.md`, statement.markdown)}>
              Download .md
            </button>
          </summary>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{statement.markdown}</pre>
        </details>
      )}
    </div>
  );
}
