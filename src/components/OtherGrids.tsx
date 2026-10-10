"use client";

import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useMemo, useState } from "react";
import type { Dispute, Invoice, Subscription, SubscriptionPlan, Transaction } from "@/lib/paypal/types";
import { unappliedAmount } from "@/lib/paypal/types";
import { shortDate, usd, useGridTheme } from "./grid";

type TxRow = Transaction & { invoice_number: string; matched: boolean; unapplied: number };

export function TransactionGrid({ transactions, invoices }: { transactions: Transaction[]; invoices: Invoice[] }) {
  const theme = useGridTheme();
  const rows = useMemo<TxRow[]>(
    () => transactions.map((t) => ({ ...t, invoice_number: t.allocations?.length ? t.allocations.map((a) => a.invoice_number).join(" + ") : (invoices.find((i) => i.id === t.invoice_id)?.invoice_number ?? ""), matched: !!t.invoice_id || (t.allocations?.length ?? 0) > 0, unapplied: unappliedAmount(t) })),
    [transactions, invoices],
  );
  const cols = useMemo<ColDef<TxRow>[]>(
    () => [
      { field: "date", headerName: "Date", width: 110, valueFormatter: (p) => shortDate(p.value), sort: "desc" },
      { field: "id", headerName: "Transaction", width: 180, cellClass: "font-mono text-xs" },
      { field: "type", headerName: "Type", width: 100 },
      { field: "payer_name", headerName: "Payer", width: 150 },
      { field: "payer_email", headerName: "Email", width: 220 },
      { field: "memo", headerName: "Memo", flex: 1, minWidth: 180 },
      { field: "amount", headerName: "Amount", width: 110, type: "rightAligned", valueFormatter: (p) => usd(p.value, p.data?.currency), cellClass: (p) => ((p.value ?? 0) < 0 ? "text-bad" : "text-ok") },
      { field: "fee", headerName: "Fee", width: 90, type: "rightAligned", valueFormatter: (p) => usd(p.value, p.data?.currency) },
      {
        field: "invoice_number",
        headerName: "Invoice",
        width: 170,
        cellRenderer: (p: ICellRendererParams<TxRow, string>) =>
          p.data?.allocations?.length ? (
            <span className="flex flex-wrap gap-1">
              {p.data.allocations.map((a) => (
                <span key={a.invoice_id + a.amount} className="chip" title={usd(a.amount, p.data?.currency)}>
                  {a.invoice_number}
                </span>
              ))}
              {p.data.unapplied > 0.01 && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">{usd(p.data.unapplied, p.data.currency)} UNAPPLIED</span>}
            </span>
          ) : p.data?.matched ? (
            <span className="chip">{p.value}</span>
          ) : p.data?.type === "PAYMENT" && p.data.status === "S" ? (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">UNMATCHED</span>
          ) : null,
      },
      { field: "status", headerName: "Status", width: 90, valueFormatter: (p) => ({ S: "Success", P: "Pending", D: "Denied", V: "Reversed" })[p.value as string] ?? p.value },
    ],
    [],
  );
  return <AgGridReact<TxRow> theme={theme} rowData={rows} columnDefs={cols} defaultColDef={{ sortable: true, filter: true, resizable: true }} getRowId={(p) => p.data.id} animateRows />;
}

type DisputeRow = Dispute & { invoice_number: string };

export function DisputeGrid({ disputes, invoices, onAsk, busy }: { disputes: Dispute[]; invoices: Invoice[]; onAsk?: (text: string) => void; busy?: boolean }) {
  const theme = useGridTheme();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const rows = useMemo<DisputeRow[]>(() => disputes.map((d) => ({ ...d, invoice_number: invoices.find((i) => i.id === d.invoice_id)?.invoice_number ?? "" })), [disputes, invoices]);
  // Look the selection up in the current rows so the detail panel follows live updates (draft built, pack submitted).
  const selected = useMemo(() => rows.find((r) => r.id === selectedId), [rows, selectedId]);
  const cols = useMemo<ColDef<DisputeRow>[]>(
    () => [
      { field: "id", headerName: "Dispute", width: 160, cellClass: "font-mono text-xs" },
      { field: "created", headerName: "Opened", width: 100, valueFormatter: (p) => shortDate(p.value) },
      { field: "buyer_email", headerName: "Buyer", width: 220 },
      { field: "amount", headerName: "Amount", width: 100, type: "rightAligned", valueFormatter: (p) => usd(p.value, p.data?.currency) },
      { field: "reason", headerName: "Reason", flex: 1, minWidth: 200, valueFormatter: (p) => String(p.value ?? "").replaceAll("_", " ").toLowerCase() },
      { field: "status", headerName: "Status", width: 170, cellRenderer: (p: ICellRendererParams<DisputeRow, string>) => <span className={`chip ${p.value === "RESOLVED" ? "text-ok" : "text-warn"}`}>{String(p.value ?? "").replaceAll("_", " ")}</span> },
      { field: "seller_response_due", headerName: "Respond by", width: 110, valueFormatter: (p) => shortDate(p.value) },
      { field: "invoice_number", headerName: "Invoice", width: 100 },
      { field: "life_cycle_stage", headerName: "Stage", width: 110, valueFormatter: (p) => String(p.value ?? "").toLowerCase() },
      {
        headerName: "Evidence",
        width: 130,
        valueGetter: (p) => (p.data?.evidence_submitted_at ? "submitted" : p.data?.evidence_draft ? "drafted" : ""),
        cellRenderer: (p: ICellRendererParams<DisputeRow, string>) => (p.value === "submitted" ? <span className="chip text-ok">submitted</span> : p.value === "drafted" ? <span className="chip text-accent">pack ready</span> : null),
      },
    ],
    [],
  );
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="min-h-0 flex-1">
        <AgGridReact<DisputeRow> theme={theme} rowData={rows} columnDefs={cols} defaultColDef={{ sortable: true, filter: true, resizable: true }} getRowId={(p) => p.data.id} rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }} onSelectionChanged={(e) => setSelectedId(e.api.getSelectedRows()[0]?.id)} />
      </div>
      {selected && selected.status !== "RESOLVED" && (
        <div className="max-h-64 overflow-auto rounded-md border border-border bg-panel p-3 text-xs">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="font-semibold">
              Evidence pack for {selected.id} ({usd(selected.amount, selected.currency)})
              {selected.evidence_submitted_at ? ` - submitted ${shortDate(selected.evidence_submitted_at)} via Disputes API ${selected.evidence_channel}` : selected.evidence_draft ? " - built, not yet sent" : " - not built yet"}
            </span>
            {onAsk && !selected.evidence_submitted_at && (
              <button className="btn btn-primary ml-auto" disabled={busy} onClick={() => onAsk(`${selected.evidence_draft ? "Submit" : "Build and submit"} the evidence pack for dispute ${selected.id}`)} title="The agent assembles the pack from the invoice, payment, tracking and reminder history and sends it through the PayPal Disputes API; your policy decides whether it asks first">
                {selected.evidence_draft ? "Submit evidence pack" : "Build and submit evidence pack"}
              </button>
            )}
          </div>
          {selected.evidence_draft ? <pre className="whitespace-pre-wrap font-mono">{selected.evidence_draft}</pre> : <p className="text-muted">Invoice line items, payment record, shipment tracking and reminder history go in automatically; the agent drafts the seller statement.</p>}
        </div>
      )}
    </div>
  );
}

export function SubscriptionsPanel({ plans, subscriptions }: { plans: SubscriptionPlan[]; subscriptions: Subscription[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="rounded-md border border-border bg-panel p-3">
        <h3 className="mb-2 text-sm font-semibold">Plans</h3>
        {plans.length === 0 && <p className="text-sm text-muted">No plans yet. Ask the agent: &quot;Set up a $1,500 monthly retainer for Northwind Traders&quot;.</p>}
        <ul className="space-y-1 text-sm">
          {plans.map((p) => (
            <li key={p.id} className="flex justify-between gap-2">
              <span>{p.name}</span>
              <span className="text-muted">
                {usd(p.amount, p.currency)} / {p.interval_count > 1 ? `${p.interval_count} ` : ""}{p.interval_unit.toLowerCase()} - {p.status}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="rounded-md border border-border bg-panel p-3">
        <h3 className="mb-2 text-sm font-semibold">Subscriptions</h3>
        {subscriptions.length === 0 && <p className="text-sm text-muted">No subscriptions yet.</p>}
        <ul className="space-y-1 text-sm">
          {subscriptions.map((s) => (
            <li key={s.id} className="flex flex-col">
              <span>
                {s.subscriber_email} - <span className="chip">{s.status.replaceAll("_", " ")}</span>
              </span>
              {s.approve_url && (
                <a className="text-xs text-accent underline" href={s.approve_url} target="_blank" rel="noreferrer">
                  client approval link
                </a>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
