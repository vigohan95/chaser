"use client";

import { AgGridReact } from "ag-grid-react";
import type { CellClassParams, CellValueChangedEvent, ColDef, ICellRendererParams, RowClassRules } from "ag-grid-community";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReconcileResult } from "@/lib/agent/reconcile";
import type { Invoice, Transaction } from "@/lib/paypal/types";
import { isOpenInvoice, round2 } from "@/lib/paypal/types";
import { shortDate, usd, useGridTheme } from "./grid";

/** One editable allocation line: "this much of this payment goes to this invoice". */
export interface AllocationRow {
  key: string;
  transaction_id: string;
  date: string;
  payer: string;
  payer_email: string;
  memo: string;
  payment: number;
  kind: string;
  confidence: number;
  invoice_number: string;
  invoice_id: string;
  balance: number;
  amount: number;
  reasoning: string;
}

const KIND_LABEL: Record<string, string> = { exact: "exact", partial: "partial", combined: "split", "amount-only": "amount only", unmatched: "no match" };

export function rowsFromResult(result: ReconcileResult, transactions: Transaction[], invoices: Invoice[]): AllocationRow[] {
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const tx = new Map(transactions.map((t) => [t.id, t]));
  const rows: AllocationRow[] = [];
  for (const m of result.matches) {
    const t = tx.get(m.transaction_id);
    m.allocations.forEach((a, idx) => {
      const inv = byId.get(a.invoice_id);
      rows.push({ key: `${m.transaction_id}#${idx}`, transaction_id: m.transaction_id, date: t?.date ?? "", payer: t?.payer_name ?? "", payer_email: m.payer_email ?? t?.payer_email ?? "", memo: t?.memo ?? "", payment: m.amount, kind: m.kind, confidence: m.confidence, invoice_number: a.invoice_number, invoice_id: a.invoice_id, balance: inv?.due ?? 0, amount: a.amount, reasoning: m.reasoning });
    });
  }
  for (const u of result.unmatched) {
    const t = tx.get(u.transaction_id);
    rows.push({ key: `${u.transaction_id}#0`, transaction_id: u.transaction_id, date: t?.date ?? "", payer: t?.payer_name ?? "", payer_email: u.payer_email ?? "", memo: u.memo ?? "", payment: u.amount, kind: "unmatched", confidence: 0, invoice_number: "", invoice_id: "", balance: 0, amount: u.amount, reasoning: u.reason });
  }
  return rows;
}

/** The message the agent receives; `parseAllocations` in the rule planner reads exactly this shape. */
export function allocationMessage(rows: AllocationRow[]): string {
  const lines = rows.filter((r) => r.invoice_number && r.amount > 0).map((r) => `${r.transaction_id} -> ${r.invoice_number} [${r.invoice_id}] $${r.amount.toFixed(2)}`);
  return `Record these payment allocations: ${lines.join("; ")}`;
}

/** Over-allocation check per payment: the sum of a payment's lines must not exceed the payment. */
export function overAllocated(rows: AllocationRow[]): Set<string> {
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(r.transaction_id, round2((sums.get(r.transaction_id) ?? 0) + r.amount));
  const bad = new Set<string>();
  for (const r of rows) if ((sums.get(r.transaction_id) ?? 0) > r.payment + 0.005) bad.add(r.transaction_id);
  return bad;
}

export default function MatchReview({ transactions, invoices, fetchMatches, onRecord, busy }: { transactions: Transaction[]; invoices: Invoice[]; fetchMatches: () => Promise<ReconcileResult | undefined>; onRecord: (message: string) => void; busy: boolean }) {
  const theme = useGridTheme();
  const gridRef = useRef<AgGridReact<AllocationRow>>(null);
  const [rows, setRows] = useState<AllocationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [edited, setEdited] = useState(0);
  const unlinked = useMemo(() => transactions.filter((t) => t.type === "PAYMENT" && t.status === "S" && !t.invoice_id).length, [transactions]);
  const openInvoices = useMemo(() => invoices.filter(isOpenInvoice), [invoices]);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await fetchMatches();
    if (result) setRows(rowsFromResult(result, transactions, invoices));
    setEdited(0);
    setLoading(false);
  }, [fetchMatches, transactions, invoices]);

  // Re-run the matcher whenever the payment stream or the invoices change (e.g. after the agent records a match).
  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const bad = useMemo(() => overAllocated(rows), [rows]);
  const recordable = rows.filter((r) => r.invoice_number && r.amount > 0 && !bad.has(r.transaction_id));

  const cols = useMemo<ColDef<AllocationRow>[]>(
    () => [
      { field: "transaction_id", headerName: "Payment", width: 165, cellClass: "font-mono text-xs", pinned: "left" },
      { field: "date", headerName: "Date", width: 90, valueFormatter: (p) => shortDate(p.value) },
      { field: "payer_email", headerName: "Payer", width: 210, tooltipField: "memo" },
      { field: "payment", headerName: "Paid", width: 100, type: "rightAligned", valueFormatter: (p) => usd(p.value) },
      {
        field: "kind",
        headerName: "Match",
        width: 120,
        cellRenderer: (p: ICellRendererParams<AllocationRow, string>) => {
          const r = p.data;
          if (!r) return null;
          const tone = r.kind === "unmatched" ? "text-bad" : r.confidence >= 0.6 ? "text-ok" : "text-warn";
          return (
            <span className={`chip ${tone}`}>
              {KIND_LABEL[r.kind] ?? r.kind}
              {r.kind !== "unmatched" ? ` ${Math.round(r.confidence * 100)}%` : ""}
            </span>
          );
        },
      },
      {
        field: "invoice_number",
        headerName: "Invoice",
        width: 115,
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: ["", ...openInvoices.map((i) => i.invoice_number)] },
        valueSetter: (p) => {
          const number = String(p.newValue ?? "");
          const inv = openInvoices.find((i) => i.invoice_number === number);
          p.data.invoice_number = inv?.invoice_number ?? "";
          p.data.invoice_id = inv?.id ?? "";
          p.data.balance = inv?.due ?? 0;
          if (inv && p.data.amount <= 0) p.data.amount = Math.min(p.data.payment, inv.due);
          return true;
        },
        cellClass: "cursor-pointer",
        cellRenderer: (p: ICellRendererParams<AllocationRow, string>) => (p.value ? <span className="chip">{p.value} &#9662;</span> : <span className="text-muted">pick &#9662;</span>),
        enableCellChangeFlash: true,
      },
      { field: "balance", headerName: "Balance due", width: 110, type: "rightAligned", valueFormatter: (p) => (p.data?.invoice_number ? usd(p.value) : "") },
      {
        field: "amount",
        headerName: "Allocate",
        width: 110,
        type: "rightAligned",
        editable: true,
        valueParser: (p) => Number(String(p.newValue).replace(/[^0-9.]/g, "")) || 0,
        valueSetter: (p) => {
          const v = round2(Math.max(0, Number(p.newValue) || 0));
          if (v === p.data.amount) return false;
          p.data.amount = v;
          return true;
        },
        valueFormatter: (p) => usd(p.value),
        cellClass: (p: CellClassParams<AllocationRow>) => `font-semibold cursor-text ${p.data && bad.has(p.data.transaction_id) ? "text-bad" : ""}`,
        enableCellChangeFlash: true,
      },
      { headerName: "Closes?", width: 85, valueGetter: (p) => (p.data?.invoice_number ? (Math.abs(p.data.balance - p.data.amount) <= 0.01 ? "yes" : p.data.amount > p.data.balance + 0.01 ? "over" : "partial") : ""), cellClass: (p) => (p.value === "over" ? "text-bad" : p.value === "yes" ? "text-ok" : "text-muted") },
      { field: "reasoning", headerName: "Why", flex: 1, minWidth: 260, tooltipField: "reasoning" },
    ],
    [openInvoices, bad],
  );

  const rowClassRules = useMemo<RowClassRules<AllocationRow>>(
    () => ({
      "bg-amber-50 dark:bg-amber-950/20": (p) => !!p.data && p.data.kind !== "unmatched" && p.data.confidence < 0.6,
      "bg-red-50 dark:bg-red-950/30": (p) => !!p.data && (p.data.kind === "unmatched" || bad.has(p.data.transaction_id)),
    }),
    [bad],
  );

  const pinnedBottom = useMemo(() => {
    const payments = new Map(rows.map((r) => [r.transaction_id, r.payment]));
    return [{ key: "__total", transaction_id: `${payments.size} payment${payments.size === 1 ? "" : "s"}`, payment: [...payments.values()].reduce((a, v) => a + v, 0), amount: rows.reduce((a, r) => a + r.amount, 0), invoice_number: `${rows.filter((r) => r.invoice_number).length} line${rows.length === 1 ? "" : "s"}`, reasoning: "" } as AllocationRow];
  }, [rows]);

  const onCellValueChanged = useCallback((e: CellValueChangedEvent<AllocationRow>) => {
    setRows((prev) => prev.map((r) => (r.key === e.data.key ? { ...e.data } : r)));
    setEdited((n) => n + 1);
  }, []);

  const splitSelected = () => {
    const api = gridRef.current?.api;
    const sel = api?.getSelectedRows()[0] ?? rows[0];
    if (!sel) return;
    const siblings = rows.filter((r) => r.transaction_id === sel.transaction_id);
    const copy: AllocationRow = { ...sel, key: `${sel.transaction_id}#${siblings.length}`, invoice_number: "", invoice_id: "", balance: 0, amount: 0, kind: "split (manual)", confidence: 1, reasoning: "Added by you in the match review." };
    const idx = rows.findIndex((r) => r.key === sel.key);
    setRows([...rows.slice(0, idx + 1), copy, ...rows.slice(idx + 1)]);
    setEdited((n) => n + 1);
  };

  const exportCsv = () => gridRef.current?.api.exportDataAsCsv({ fileName: `chaser-reconciliation-${new Date().toISOString().slice(0, 10)}.csv`, columnKeys: ["transaction_id", "date", "payer_email", "payment", "kind", "invoice_number", "balance", "amount", "reasoning"] });

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm">
          <span className="font-semibold">Match review</span>
          <span className="ml-2 text-xs text-muted">{unlinked === 0 ? "Every successful payment is linked to an invoice." : `${unlinked} payment${unlinked === 1 ? "" : "s"} arrived without an invoice link. Edit the invoice or the amount of any line, split a payment across invoices, then record.`}</span>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <button className="btn" onClick={load} disabled={loading || busy}>
            {loading ? "Matching..." : "Re-match"}
          </button>
          <button className="btn" onClick={splitSelected} disabled={rows.length === 0} title="Add another invoice line for the selected payment">
            Split payment
          </button>
          <button className="btn" onClick={exportCsv} disabled={rows.length === 0}>
            Export CSV
          </button>
          <button className="btn btn-primary" onClick={() => onRecord(allocationMessage(recordable))} disabled={busy || recordable.length === 0 || bad.size > 0} title={bad.size ? "A payment is over-allocated; fix the red lines first" : "The agent records each line with record_payment_for_invoice; anything outside your policy comes back as an approval card"}>
            Record {recordable.length} allocation{recordable.length === 1 ? "" : "s"}
            {edited ? " (edited)" : ""}
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <AgGridReact<AllocationRow>
          ref={gridRef}
          theme={theme}
          rowData={rows}
          columnDefs={cols}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          getRowId={(p) => p.data.key}
          rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
          onCellValueChanged={onCellValueChanged}
          rowClassRules={rowClassRules}
          pinnedBottomRowData={pinnedBottom}
          singleClickEdit
          stopEditingWhenCellsLoseFocus
          animateRows
          tooltipShowDelay={300}
          overlayNoRowsTemplate={loading ? "<span>Matching...</span>" : "<span class='text-muted'>Nothing to reconcile.</span>"}
        />
      </div>
    </div>
  );
}
