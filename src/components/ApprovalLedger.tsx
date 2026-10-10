"use client";

import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useMemo, useRef } from "react";
import type { AuditEntry } from "@/lib/paypal/types";
import type { Policy } from "@/lib/policy/schema";
import { useGridTheme } from "./grid";

/** The approval ledger: every policy decision (allowed / asked / approved / denied) with the policy field it cites. */
export interface LedgerRow {
  id: string;
  ts: string;
  action: string;
  tool: string;
  decision: string;
  rule: string;
  ruleValue: string;
  reason: string;
  decidedBy: string;
}

/** Resolve "approvals.refundsOver" against the policy object for display ("500", "on", "cancel sent invoice, ..."). */
export function ruleValue(policy: Policy, rule: string | undefined): string {
  if (!rule) return "";
  let cur: unknown = policy;
  for (const part of rule.split(".")) {
    if (!cur || typeof cur !== "object" || !(part in (cur as object))) return "";
    cur = (cur as Record<string, unknown>)[part];
  }
  if (Array.isArray(cur)) return cur.map((x) => String(x).replaceAll("_", " ")).join(", ");
  if (typeof cur === "boolean") return cur ? "on" : "off";
  if (typeof cur === "number") return rule.includes("Days") || rule.includes("Reminders") ? String(cur) : `$${cur}`;
  if (typeof cur === "string") return cur;
  return "";
}

export function ledgerRows(entries: AuditEntry[], policy: Policy): LedgerRow[] {
  return entries
    .filter((e) => e.actor === "policy" || e.decision === "approved" || e.decision === "denied" || e.decision === "approval-required" || (e.actor === "agent" && e.decision === "allowed" && e.rule))
    .map((e) => ({
      id: e.id,
      ts: e.ts,
      action: e.action,
      tool: e.tool ?? "",
      decision: e.decision ?? "",
      rule: e.rule ?? "",
      ruleValue: ruleValue(policy, e.rule),
      reason: e.reason ?? "",
      decidedBy: e.decision === "approved" || (e.decision === "denied" && e.actor === "user") ? "you" : e.decision === "approval-required" ? "policy -> you" : e.actor === "policy" || e.decision === "allowed" || e.decision === "denied" ? "policy" : e.actor,
    }));
}

const DECISION_TONE: Record<string, string> = { allowed: "text-ok", approved: "text-ok", "approval-required": "text-warn", denied: "text-bad" };

export default function ApprovalLedger({ entries, policy }: { entries: AuditEntry[]; policy: Policy }) {
  const theme = useGridTheme();
  const gridRef = useRef<AgGridReact<LedgerRow>>(null);
  const rows = useMemo(() => ledgerRows(entries, policy), [entries, policy]);
  const counts = useMemo(() => {
    const c = { allowed: 0, asked: 0, approved: 0, denied: 0 };
    for (const r of rows) {
      if (r.decision === "allowed") c.allowed++;
      else if (r.decision === "approval-required") c.asked++;
      else if (r.decision === "approved") c.approved++;
      else if (r.decision === "denied") c.denied++;
    }
    return c;
  }, [rows]);

  const cols = useMemo<ColDef<LedgerRow>[]>(
    () => [
      { field: "ts", headerName: "When", width: 112, valueFormatter: (p) => new Date(p.value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }), sort: "desc" },
      { field: "action", headerName: "Action", flex: 1.2, minWidth: 240 },
      {
        field: "decision",
        headerName: "Decision",
        width: 150,
        cellRenderer: (p: ICellRendererParams<LedgerRow, string>) => <span className={`chip ${DECISION_TONE[p.value ?? ""] ?? "text-muted"}`}>{String(p.value ?? "").replace("-", " ")}</span>,
      },
      { field: "decidedBy", headerName: "By", width: 110 },
      {
        field: "rule",
        headerName: "Policy rule",
        width: 330,
        cellRenderer: (p: ICellRendererParams<LedgerRow, string>) =>
          p.value ? (
            <span className="font-mono text-[11px]">
              {p.value}
              {p.data?.ruleValue ? <span className="text-muted"> = {p.data.ruleValue}</span> : null}
            </span>
          ) : null,
      },
      { field: "reason", headerName: "Reason", flex: 2, minWidth: 300, tooltipField: "reason" },
      { field: "tool", headerName: "Tool", width: 170, cellClass: "font-mono text-xs" },
    ],
    [],
  );

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">Approval ledger</span>
        <span className="text-xs text-muted">
          {rows.length} decision{rows.length === 1 ? "" : "s"}: {counts.allowed} allowed by policy, {counts.asked} sent to you, {counts.approved} approved by you, {counts.denied} blocked. Every row cites the policy field it was decided on; change the field in Policy and the next decision changes with it.
        </span>
        <button className="btn ml-auto" onClick={() => gridRef.current?.api.exportDataAsCsv({ fileName: `chaser-approvals-${new Date().toISOString().slice(0, 10)}.csv` })} disabled={rows.length === 0}>
          Export CSV
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <AgGridReact<LedgerRow> ref={gridRef} theme={theme} rowData={rows} columnDefs={cols} defaultColDef={{ sortable: true, filter: true, resizable: true }} getRowId={(p) => p.data.id} animateRows tooltipShowDelay={300} overlayNoRowsTemplate="<span class='text-muted'>No policy decisions yet. Run collections, reconcile or refund something and they appear here.</span>" />
      </div>
    </div>
  );
}
