"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { overdueDays } from "@/lib/agent/chase";
import type { CommandCenterState, Invoice } from "@/lib/paypal/types";
import { isOpenInvoice } from "@/lib/paypal/types";
import { DEFAULT_POLICY, type Policy } from "@/lib/policy/schema";
import AgentDrawer from "./AgentDrawer";
import AuditTimeline from "./AuditTimeline";
import InvoiceGrid from "./InvoiceGrid";
import { DisputeGrid, SubscriptionsPanel, TransactionGrid } from "./OtherGrids";
import PolicyPanel from "./PolicyPanel";
import { usd } from "./grid";

type State = CommandCenterState & { policy: Policy; version: number };
type Tab = "invoices" | "transactions" | "disputes" | "subscriptions" | "audit";

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border border-border bg-panel px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`text-lg font-semibold ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

export default function CommandCenter() {
  const [state, setState] = useState<State | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Tab>("invoices");
  const [selected, setSelected] = useState<Invoice[]>([]);
  const [showPolicy, setShowPolicy] = useState(false);
  const [pending, setPending] = useState<string | undefined>();
  const [simInvoice, setSimInvoice] = useState("");
  const versionRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      const data = (await res.json()) as State & { error?: string };
      if (data.error) throw new Error(data.error);
      if (data.version !== versionRef.current) {
        versionRef.current = data.version;
        setState(data);
      }
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const chat = useChat({
    id: "chaser-command-center",
    transport: new DefaultChatTransport({ api: "/api/agent" }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => refresh(),
    onError: () => refresh(),
  });
  const busy = chat.status === "streaming" || chat.status === "submitted";

  // Initial load, then poll: fast while the agent is acting (tool results land in the grid live),
  // slow otherwise (webhooks / cron). Re-arms whenever `busy` flips, which also refreshes right after a run.
  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const id = setInterval(refresh, busy ? 1200 : 6000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [busy, refresh]);

  const now = useMemo(() => new Date(state?.now ?? 0), [state?.now]);
  const kpis = useMemo(() => {
    if (!state) return null;
    const open = state.invoices.filter(isOpenInvoice);
    const overdue = open.filter((i) => overdueDays(i, now) > 0);
    const since = now.getTime() - 30 * 86_400_000;
    return {
      outstanding: open.reduce((a, i) => a + i.due, 0),
      overdue: overdue.reduce((a, i) => a + i.due, 0),
      overdueCount: overdue.length,
      collected: state.transactions.filter((t) => t.type === "PAYMENT" && t.status === "S" && new Date(t.date).getTime() >= since).reduce((a, t) => a + t.amount, 0),
      disputes: state.disputes.filter((d) => d.status !== "RESOLVED").length,
      unmatched: state.transactions.filter((t) => t.type === "PAYMENT" && t.status === "S" && !t.invoice_id).length,
    };
  }, [state, now]);

  const ask = (text: string) => {
    if (busy) return;
    chat.sendMessage({ text });
  };

  const onOverrideChanged = useCallback(
    async (id: string, override: Invoice["chase_override"]) => {
      await fetch(`/api/invoices/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chase_override: override }) });
      refresh();
    },
    [refresh],
  );

  const resetDemo = async () => {
    await fetch("/api/seed", { method: "POST" });
    chat.setMessages([]);
    refresh();
  };

  const simulatePayment = async () => {
    const id = simInvoice || state?.invoices.find((i) => isOpenInvoice(i) && overdueDays(i, now) > 0)?.id;
    if (!id) return;
    await fetch("/api/simulate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "INVOICING.INVOICE.PAID", invoice_id: id }) });
    refresh();
  };

  const openInvoices = state?.invoices.filter(isOpenInvoice) ?? [];

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-panel px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent font-bold text-white">C</span>
          <div>
            <div className="text-base font-semibold leading-tight">Chaser</div>
            <div className="text-[11px] text-muted">AI receivables agent on PayPal</div>
          </div>
        </div>
        {state && (
          <span className={`chip ${state.mode === "sandbox" ? "border-accent text-accent" : "border-amber-400 text-warn"}`} title="All money is sandbox/play money">
            {state.mode === "sandbox" ? "PayPal sandbox" : "Mock PayPal (no keys)"}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {state?.mode === "mock" && (
            <>
              <select value={simInvoice} onChange={(e) => setSimInvoice(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1.5 text-xs">
                <option value="">Simulate: client pays (oldest overdue)</option>
                {openInvoices.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.invoice_number} - {i.client.business} - {usd(i.due)}
                  </option>
                ))}
              </select>
              <button className="btn" onClick={simulatePayment} title="Fires an INVOICING.INVOICE.PAID webhook through the real handler">
                Fire webhook
              </button>
              <button className="btn" onClick={resetDemo}>
                Reset demo
              </button>
            </>
          )}
          <button className={`btn ${showPolicy ? "border-accent text-accent" : ""}`} onClick={() => setShowPolicy(!showPolicy)}>
            Policy
          </button>
        </div>
      </header>

      {loadError && <div className="border-b border-red-300 bg-red-50 px-4 py-1 text-xs text-bad dark:bg-red-950/30">Could not load state: {loadError}</div>}

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col gap-3 p-4">
          {kpis && (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
              <Kpi label="Outstanding" value={usd(kpis.outstanding)} />
              <Kpi label={`Overdue (${kpis.overdueCount})`} value={usd(kpis.overdue)} tone={kpis.overdue > 0 ? "text-bad" : "text-ok"} />
              <Kpi label="Collected, 30d" value={usd(kpis.collected)} tone="text-ok" />
              <Kpi label="Open disputes" value={String(kpis.disputes)} tone={kpis.disputes ? "text-warn" : ""} />
              <Kpi label="Unmatched payments" value={String(kpis.unmatched)} tone={kpis.unmatched ? "text-warn" : ""} />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" onClick={() => ask("Run collections")} disabled={busy}>
              Run collections
            </button>
            <button className="btn" onClick={() => ask("Reconcile payments")} disabled={busy}>
              Reconcile payments
            </button>
            <button className="btn" onClick={() => ask("Review disputes")} disabled={busy}>
              Review disputes
            </button>
            {selected.length > 0 && (
              <>
                <button className="btn" onClick={() => ask(`Chase these invoices now: ${selected.map((s) => s.invoice_number).join(", ")}`)} disabled={busy}>
                  Chase selected ({selected.length})
                </button>
                <button className="btn" onClick={() => ask(`Pause chasing ${selected.map((s) => s.invoice_number).join(", ")}`)} disabled={busy}>
                  Pause selected
                </button>
                <button className="btn" onClick={() => setPending(`Regarding ${selected.map((s) => s.invoice_number).join(", ")}: `)}>
                  Ask about selected
                </button>
              </>
            )}
            <nav className="ml-auto flex gap-1 rounded-md border border-border bg-panel p-0.5 text-sm">
              {(["invoices", "transactions", "disputes", "subscriptions", "audit"] as Tab[]).map((t) => (
                <button key={t} onClick={() => setTab(t)} className={`rounded px-2.5 py-1 capitalize ${tab === t ? "bg-accent text-white" : "hover:text-accent"}`}>
                  {t}
                  {state && t === "invoices" ? ` (${openInvoices.length})` : ""}
                  {state && t === "disputes" && kpis?.disputes ? ` (${kpis.disputes})` : ""}
                  {state && t === "audit" ? ` (${state.audit.length})` : ""}
                </button>
              ))}
            </nav>
          </div>

          <div className="min-h-0 flex-1">
            {!state && !loadError && <div className="text-sm text-muted">Loading...</div>}
            {state && tab === "invoices" && <InvoiceGrid invoices={state.invoices} policy={state.policy} now={now} onSelection={setSelected} onOverrideChanged={onOverrideChanged} />}
            {state && tab === "transactions" && <TransactionGrid transactions={state.transactions} invoices={state.invoices} />}
            {state && tab === "disputes" && <DisputeGrid disputes={state.disputes} invoices={state.invoices} />}
            {state && tab === "subscriptions" && <SubscriptionsPanel plans={state.plans} subscriptions={state.subscriptions} />}
            {state && tab === "audit" && (
              <div className="h-full overflow-y-auto pr-1">
                <AuditTimeline entries={state.audit} />
              </div>
            )}
          </div>
        </main>

        <aside className="flex w-[420px] shrink-0 flex-col border-l border-border bg-background">
          {showPolicy && (
            <div className="max-h-[55%] overflow-y-auto p-3">
              <PolicyPanel policy={state?.policy ?? DEFAULT_POLICY} onSaved={() => refresh()} />
            </div>
          )}
          <div className="min-h-0 flex-1">
            <AgentDrawer chat={chat} llm={state?.llm ?? "..."} pending={pending} />
          </div>
        </aside>
      </div>
    </div>
  );
}
