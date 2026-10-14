"use client";

import { useState } from "react";
import type { Policy } from "@/lib/policy/schema";

function Num({ label, value, onChange, prefix, suffix }: { label: string; value: number; onChange: (v: number) => void; prefix?: string; suffix?: string }) {
  return (
    <label className="flex items-center justify-between gap-2 text-sm">
      <span className="text-muted">{label}</span>
      <span className="flex items-center gap-1">
        {prefix && <span className="text-muted">{prefix}</span>}
        <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-20 rounded border border-border bg-background px-2 py-1 text-right text-sm outline-none focus:border-accent" />
        {suffix && <span className="text-muted">{suffix}</span>}
      </span>
    </label>
  );
}

export default function PolicyPanel({ policy, onSave }: { policy: Policy; onSave: (p: Policy) => Promise<string | undefined> }) {
  const [draft, setDraft] = useState<Policy>(policy);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string>("");
  // Re-sync the draft when a new policy arrives from the server (derived state, no effect).
  const [seen, setSeen] = useState(policy);
  if (policy !== seen) {
    setSeen(policy);
    setDraft(policy);
  }

  const save = async () => {
    setSaving(true);
    setMsg("");
    const error = await onSave(draft);
    setSaving(false);
    setMsg(error ?? "Saved. The agent uses this on its next action.");
  };

  const r = draft.reminders;
  return (
    <div className="space-y-3 rounded-md border border-border bg-panel p-3">
      <div>
        <div className="text-sm font-semibold">Chasing policy</div>
        <p className="text-xs text-muted">The agent acts freely inside these bounds, asks you at the edges, and is blocked beyond them.</p>
      </div>
      <div className="space-y-1.5">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Reminders</div>
        <Num label="Friendly nudge after" value={r.friendlyAfterDays} suffix="days" onChange={(v) => setDraft({ ...draft, reminders: { ...r, friendlyAfterDays: v } })} />
        <Num label="Firm reminder after" value={r.firmAfterDays} suffix="days" onChange={(v) => setDraft({ ...draft, reminders: { ...r, firmAfterDays: v } })} />
        <Num label="Final notice after" value={r.finalAfterDays} suffix="days" onChange={(v) => setDraft({ ...draft, reminders: { ...r, finalAfterDays: v } })} />
        <Num label="Min gap between reminders" value={r.minDaysBetweenReminders} suffix="days" onChange={(v) => setDraft({ ...draft, reminders: { ...r, minDaysBetweenReminders: v } })} />
        <Num label="Max reminders per invoice" value={r.maxReminders} onChange={(v) => setDraft({ ...draft, reminders: { ...r, maxReminders: v } })} />
        <label className="flex items-center justify-between gap-2 text-sm" title="Habitual late payers (by their own PayPal payment history) get firm/final earlier; reliable payers later. The ledger cites reminders.adaptToHistory with the numbers.">
          <span className="text-muted">Adapt cadence to payer history</span>
          <input type="checkbox" checked={r.adaptToHistory} onChange={(e) => setDraft({ ...draft, reminders: { ...r, adaptToHistory: e.target.checked } })} />
        </label>
        {r.adaptToHistory && <Num label="Shift for late-risk / reliable payers" value={r.historyShiftDays} suffix="days" onChange={(v) => setDraft({ ...draft, reminders: { ...r, historyShiftDays: v } })} />}
        <label className="flex items-center justify-between gap-2 text-sm" title="PayPal's viewed_by_recipient: an invoice the client never opened is re-delivered with an address check instead of a firmer reminder.">
          <span className="text-muted">Re-deliver never-opened invoices</span>
          <select value={r.viewedAware ? r.unviewedStrategy : "off"} onChange={(e) => setDraft({ ...draft, reminders: { ...r, viewedAware: e.target.value !== "off", unviewedStrategy: e.target.value === "off" ? r.unviewedStrategy : (e.target.value as Policy["reminders"]["unviewedStrategy"]) } })} className="rounded border border-border bg-background px-2 py-1 text-sm outline-none focus:border-accent">
            <option value="resend">resend + check address</option>
            <option value="ignore">chase as normal</option>
            <option value="off">ignore the viewed signal</option>
          </select>
        </label>
        {r.viewedAware && r.unviewedStrategy === "resend" && <Num label="... once overdue by" value={r.unviewedAfterDays} suffix="days" onChange={(v) => setDraft({ ...draft, reminders: { ...r, unviewedAfterDays: v } })} />}
      </div>
      <div className="space-y-1.5">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Promises to pay</div>
        <label className="flex items-center justify-between gap-2 text-sm">
          <span className="text-muted">Pause chasing while a promise is open</span>
          <input type="checkbox" checked={draft.promises.pauseChasing} onChange={(e) => setDraft({ ...draft, promises: { ...draft.promises, pauseChasing: e.target.checked } })} />
        </label>
        <Num label="Grace after the promised date" value={draft.promises.graceDays} suffix="days" onChange={(v) => setDraft({ ...draft, promises: { ...draft.promises, graceDays: v } })} />
        <label className="flex items-center justify-between gap-2 text-sm">
          <span className="text-muted">Broken promise escalates one stage</span>
          <input type="checkbox" checked={draft.promises.brokenEscalates} onChange={(e) => setDraft({ ...draft, promises: { ...draft.promises, brokenEscalates: e.target.checked } })} />
        </label>
        <Num label="Ask me for promises further out than" value={draft.promises.maxDays} suffix="days" onChange={(v) => setDraft({ ...draft, promises: { ...draft.promises, maxDays: v } })} />
      </div>
      <div className="space-y-1.5">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Money boundaries</div>
        <Num label="Auto-accept disputes under" prefix="$" value={draft.disputes.autoAcceptUnder} onChange={(v) => setDraft({ ...draft, disputes: { ...draft.disputes, autoAcceptUnder: v } })} />
        <label className="flex items-center justify-between gap-2 text-sm">
          <span className="text-muted">Dispute evidence packs</span>
          <select value={draft.disputes.submitEvidence} onChange={(e) => setDraft({ ...draft, disputes: { ...draft.disputes, submitEvidence: e.target.value as Policy["disputes"]["submitEvidence"] } })} className="rounded border border-border bg-background px-2 py-1 text-sm outline-none focus:border-accent">
            <option value="ask">show me, then submit</option>
            <option value="auto">submit without asking</option>
            <option value="never">never submit (I will)</option>
          </select>
        </label>
        <Num label="Ask me for refunds over" prefix="$" value={draft.approvals.refundsOver} onChange={(v) => setDraft({ ...draft, approvals: { ...draft.approvals, refundsOver: v } })} />
        <Num label="Ask me for invoices over" prefix="$" value={draft.approvals.invoicesOver} onChange={(v) => setDraft({ ...draft, approvals: { ...draft.approvals, invoicesOver: v } })} />
        <label className="flex items-center justify-between gap-2 text-sm">
          <span className="text-muted">Auto-record exact payment matches</span>
          <input type="checkbox" checked={draft.reconciliation.autoRecordExactMatches} onChange={(e) => setDraft({ ...draft, reconciliation: { ...draft.reconciliation, autoRecordExactMatches: e.target.checked } })} />
        </label>
        <label className="flex items-center justify-between gap-2 text-sm">
          <span className="text-muted">Auto-record partial payments</span>
          <input type="checkbox" checked={draft.reconciliation.autoRecordPartials} onChange={(e) => setDraft({ ...draft, reconciliation: { ...draft.reconciliation, autoRecordPartials: e.target.checked } })} />
        </label>
        <div className="text-xs text-muted">Always ask before: {draft.approvals.alwaysAsk.map((t) => t.replaceAll("_", " ")).join(", ")}</div>
      </div>
      <div className="flex items-center gap-2">
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "Saving..." : "Save policy"}
        </button>
        <span className="text-xs text-muted">{msg}</span>
      </div>
    </div>
  );
}
