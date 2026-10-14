"use client";

import { AgGridReact } from "ag-grid-react";
import type { CellValueChangedEvent, ColDef, ICellRendererParams, RowClassRules, SelectionChangedEvent } from "ag-grid-community";
import { useCallback, useMemo, useRef, useState } from "react";
import { explainStage, overdueDays, stageFor, highestStageSent, thresholdsFor } from "@/lib/agent/chase";
import { payerProfiles, predictInvoice, unknownProfile, type RiskBand } from "@/lib/agent/payer-history";
import type { Invoice, Transaction } from "@/lib/paypal/types";
import { isOpenInvoice } from "@/lib/paypal/types";
import type { Policy } from "@/lib/policy/schema";
import { shortDate, usd, useGridTheme } from "./grid";

interface Row extends Invoice {
  overdue: number;
  nextStage: string;
  /** One line: why this next action now (policy numbers + payer history). */
  why: string;
  predicted: string;
  predictedDays: number;
  risk: RiskBand | "";
  riskBasis: string;
  clientName: string;
  work: string;
}

const RISK_STYLE: Record<string, string> = {
  reliable: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  typical: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  "late-risk": "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  unknown: "bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400",
};

function RiskBadge(p: ICellRendererParams<Row, string>) {
  if (!p.value) return <span className="text-muted">-</span>;
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${RISK_STYLE[p.value] ?? ""}`} title={p.data?.riskBasis}>
      {p.value}
    </span>
  );
}

function PredictedCell(p: ICellRendererParams<Row, string>) {
  const d = p.data;
  if (!d || !p.value) return <span className="text-muted">-</span>;
  const n = d.predictedDays;
  const rel = n > 0 ? `in ${n}d` : n === 0 ? "today" : `${-n}d ago`;
  const tone = n < -7 ? "text-bad" : n < 0 ? "text-warn" : "";
  return (
    <span className={tone} title={d.riskBasis}>
      {shortDate(p.value)} <span className="text-muted">({rel})</span>
    </span>
  );
}

const STATUS_STYLE: Record<string, string> = {
  PAID: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  MARKED_AS_PAID: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  PARTIALLY_PAID: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  UNPAID: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  SENT: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  DRAFT: "bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  CANCELLED: "bg-zinc-100 text-zinc-500 line-through dark:bg-zinc-800",
  REFUNDED: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  PARTIALLY_REFUNDED: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  MARKED_AS_REFUNDED: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
};

function StatusBadge(p: ICellRendererParams<Row, string>) {
  const v = p.value ?? "";
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wide ${STATUS_STYLE[v] ?? "bg-slate-100"}`}>{v.replaceAll("_", " ")}</span>;
}

function OverdueCell(p: ICellRendererParams<Row, number>) {
  const d = p.data;
  if (!d || !isOpenInvoice(d)) return <span className="text-muted">-</span>;
  const v = p.value ?? 0;
  if (v <= 0) return <span className="text-muted">due in {Math.abs(v)}d</span>;
  const tone = v >= 21 ? "text-bad font-bold" : v >= 10 ? "text-orange-600 dark:text-orange-400 font-semibold" : "text-warn font-medium";
  return <span className={tone}>{v}d overdue</span>;
}

function LinkCell(p: ICellRendererParams<Row, string>) {
  return p.value ? (
    <a className="text-accent underline" href={p.value} target="_blank" rel="noreferrer">
      open
    </a>
  ) : null;
}

export default function InvoiceGrid({ invoices, transactions, policy, now, onSelection, onOverrideChanged }: { invoices: Invoice[]; transactions: Transaction[]; policy: Policy; now: Date; onSelection: (rows: Invoice[]) => void; onOverrideChanged: (id: string, override: Invoice["chase_override"]) => void }) {
  const theme = useGridTheme();
  const [quick, setQuick] = useState("");
  const gridRef = useRef<AgGridReact<Row>>(null);

  const rows = useMemo<Row[]>(() => {
    const profiles = payerProfiles(invoices, transactions);
    const order = ["none", "friendly", "firm", "final"];
    return invoices.map((i) => {
      const open = isOpenInvoice(i);
      const od = overdueDays(i, now);
      const profile = profiles.get(i.client.email.toLowerCase()) ?? unknownProfile(i.client.email);
      const due = stageFor(od, policy, i.chase_override, profile.band);
      const sent = highestStageSent(i);
      const t = thresholdsFor(policy, i.chase_override, profile.band);
      const nextDue = sent === "none" ? "friendly" : sent === "friendly" ? "firm" : sent === "firm" ? "final" : "none";
      const nextDay = nextDue === "friendly" ? t.friendly : nextDue === "firm" ? t.firm : t.final;
      let nextStage = "";
      let why = "";
      if (open) {
        if (i.chase_override === "paused") {
          nextStage = "paused";
          why = "Chasing paused for this invoice (invoice.chase_override).";
        } else if (i.reminders.length >= policy.reminders.maxReminders) {
          nextStage = "max reminders";
          why = `${i.reminders.length} reminders sent (reminders.maxReminders = ${policy.reminders.maxReminders}).`;
        } else if (order.indexOf(due) > order.indexOf(sent)) {
          nextStage = `${due} now`;
          why = explainStage(due, od, policy, i, profile).why;
        } else if (nextDue !== "none") {
          nextStage = `${nextDue} at day ${nextDay}`;
          why = `${sent === "none" ? "Nothing sent yet" : `${sent} sent`}; ${nextDue} is due at day ${nextDay} (${profile.band === "late-risk" || profile.band === "reliable" ? `cadence shifted for a ${profile.band} payer, reminders.adaptToHistory` : "policy thresholds"}).`;
        } else {
          nextStage = "final sent";
          why = "Final notice already sent.";
        }
      }
      const pred = open ? predictInvoice(i, profile, now) : undefined;
      // Non-open rows sort to the bottom of the (default) overdue sort.
      return { ...i, overdue: open ? od : -100000, nextStage, why, predicted: pred?.predicted_pay_date ?? "", predictedDays: pred?.days_until_predicted ?? 0, risk: pred?.risk ?? "", riskBasis: pred?.basis ?? "", clientName: i.client.business ?? `${i.client.given_name} ${i.client.surname}`, work: i.items.map((x) => x.name).join(", ") };
    });
  }, [invoices, transactions, policy, now]);

  const columnDefs = useMemo<ColDef<Row>[]>(
    () => [
      { field: "invoice_number", headerName: "Invoice", width: 105, pinned: "left" },
      { field: "clientName", headerName: "Client", width: 170 },
      { field: "work", headerName: "Work", flex: 1, minWidth: 200, tooltipField: "work" },
      { field: "total", headerName: "Total", width: 110, type: "rightAligned", valueFormatter: (p) => usd(p.value, p.data?.currency) },
      { field: "due", headerName: "Balance", width: 110, type: "rightAligned", valueFormatter: (p) => usd(p.value, p.data?.currency), cellClass: (p) => (p.data && isOpenInvoice(p.data) && p.value > 0 ? "font-semibold" : "text-muted") },
      { field: "status", headerName: "Status", width: 135, cellRenderer: StatusBadge },
      { field: "due_date", headerName: "Due", width: 105, valueFormatter: (p) => shortDate(p.value) },
      { field: "overdue", headerName: "Overdue", width: 125, cellRenderer: OverdueCell, sort: "desc" },
      { field: "predicted", headerName: "Predicted pay", width: 150, cellRenderer: PredictedCell, headerTooltip: "Due date shifted by this client's median lateness on their own paid PayPal invoices" },
      { field: "risk", headerName: "Risk", width: 95, cellRenderer: RiskBadge, headerTooltip: "Payer band from PayPal payment history: reliable / typical / late-risk / unknown" },
      { field: "nextStage", headerName: "Next action", width: 150, tooltipField: "why", headerTooltip: "What the agent will do next and why (hover a cell)" },
      { headerName: "Reminders", width: 120, valueGetter: (p) => p.data?.reminders.length ?? 0, valueFormatter: (p) => (p.value ? `${p.value} (last ${shortDate(p.data?.reminders.at(-1)?.at)})` : "none") },
      {
        field: "chase_override",
        headerName: "Chasing",
        width: 115,
        editable: (p) => !!p.data && isOpenInvoice(p.data),
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: ["default", "paused", "gentle", "aggressive"] },
        cellClass: "cursor-pointer",
        cellRenderer: (p: ICellRendererParams<Row, string>) => (p.data && isOpenInvoice(p.data) ? <span className="chip">{p.value} &#9662;</span> : <span className="text-muted">-</span>),
      },
      { field: "client.email", headerName: "Email", width: 220 },
      { field: "links.pay", headerName: "Pay link", width: 90, cellRenderer: LinkCell, sortable: false, filter: false },
    ],
    [],
  );

  const rowClassRules = useMemo<RowClassRules<Row>>(
    () => ({
      "opacity-60": (p) => !!p.data && !isOpenInvoice(p.data) && p.data.status !== "DRAFT",
      "late-risk-row": (p) => !!p.data && isOpenInvoice(p.data) && p.data.risk === "late-risk",
      "bg-red-50 dark:bg-red-950/30": (p) => !!p.data && isOpenInvoice(p.data) && p.data.overdue >= 21,
      "bg-amber-50 dark:bg-amber-950/20": (p) => !!p.data && isOpenInvoice(p.data) && p.data.overdue > 0 && p.data.overdue < 21,
    }),
    [],
  );

  const pinnedBottom = useMemo(() => {
    const open = rows.filter(isOpenInvoice);
    return [{ invoice_number: `${rows.length} invoices`, clientName: `${open.length} open`, total: rows.reduce((a, r) => a + r.total, 0), due: open.reduce((a, r) => a + r.due, 0), currency: "USD", status: "", work: "", overdue: 0, nextStage: "", why: "", predicted: "", predictedDays: 0, risk: "", riskBasis: "", reminders: [], items: [], client: { given_name: "", surname: "", email: "" }, id: "__total", paid: 0, refunded: 0, invoice_date: "", due_date: "", chase_override: "default", links: {} } as unknown as Row];
  }, [rows]);

  const onSelectionChanged = useCallback((e: SelectionChangedEvent<Row>) => onSelection(e.api.getSelectedRows()), [onSelection]);
  const onCellValueChanged = useCallback(
    (e: CellValueChangedEvent<Row>) => {
      if (e.colDef.field === "chase_override" && e.data) onOverrideChanged(e.data.id, e.newValue as Invoice["chase_override"]);
    },
    [onOverrideChanged],
  );

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <input value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="Filter invoices (client, status, work...)" className="w-72 rounded-md border border-border bg-panel px-3 py-1.5 text-sm outline-none focus:border-accent" />
        <span className="text-xs text-muted">Predicted pay and Risk come from each client&apos;s own PayPal payment history; hover Next action for the rule behind it. Edit the Chasing column inline.</span>
      </div>
      <div className="min-h-0 flex-1">
        <AgGridReact<Row>
          ref={gridRef}
          theme={theme}
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          getRowId={(p) => p.data.id}
          rowSelection={{ mode: "multiRow", checkboxes: true, headerCheckbox: true, enableClickSelection: false, isRowSelectable: (n) => !!n.data && isOpenInvoice(n.data) }}
          onSelectionChanged={onSelectionChanged}
          onCellValueChanged={onCellValueChanged}
          rowClassRules={rowClassRules}
          quickFilterText={quick}
          pinnedBottomRowData={pinnedBottom}
          animateRows
          tooltipShowDelay={300}
        />
      </div>
    </div>
  );
}
