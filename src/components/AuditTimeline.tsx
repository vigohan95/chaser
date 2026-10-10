"use client";

import { useState } from "react";
import type { AuditEntry } from "@/lib/paypal/types";

const ACTOR: Record<AuditEntry["actor"], string> = {
  agent: "bg-accent",
  user: "bg-emerald-500",
  policy: "bg-amber-500",
  webhook: "bg-purple-500",
  cron: "bg-sky-500",
  system: "bg-slate-400",
};

const DECISION: Record<string, string> = {
  allowed: "text-ok",
  approved: "text-ok",
  "approval-required": "text-warn",
  denied: "text-bad",
  error: "text-bad",
  info: "text-muted",
};

export default function AuditTimeline({ entries }: { entries: AuditEntry[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (entries.length === 0) return <p className="text-sm text-muted">No activity yet.</p>;
  return (
    <ol className="space-y-2">
      {entries.map((e) => (
        <li key={e.id} className="rounded-md border border-border bg-panel p-2.5 text-sm">
          <div className="flex items-start gap-2">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${ACTOR[e.actor]}`} title={e.actor} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-medium">{e.action}</span>
                {e.decision && <span className={`text-[11px] font-semibold uppercase tracking-wide ${DECISION[e.decision] ?? ""}`}>{e.decision.replace("-", " ")}</span>}
                <span className="text-xs text-muted">
                  {e.actor}
                  {e.tool ? ` - ${e.tool}` : ""} - {new Date(e.ts).toLocaleTimeString()}
                </span>
              </div>
              {e.reason && <div className="text-xs text-muted">{e.reason}</div>}
              {(e.input !== undefined || e.output !== undefined) && (
                <button className="mt-1 text-xs text-accent underline" onClick={() => setOpen(open === e.id ? null : e.id)}>
                  {open === e.id ? "hide details" : "details"}
                </button>
              )}
              {open === e.id && (
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-background p-2 font-mono text-[11px]">
                  {e.input !== undefined ? `input: ${typeof e.input === "string" ? e.input : JSON.stringify(e.input, null, 1)}\n` : ""}
                  {e.output !== undefined ? `output: ${typeof e.output === "string" ? e.output : JSON.stringify(e.output, null, 1)}` : ""}
                </pre>
              )}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
