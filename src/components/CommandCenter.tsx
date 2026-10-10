"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { overdueDays } from "@/lib/agent/chase";
import type { Invoice, StatePayload } from "@/lib/paypal/types";
import { isOpenInvoice } from "@/lib/paypal/types";
import { DEFAULT_POLICY, type Policy } from "@/lib/policy/schema";
import type { ReconcileResult } from "@/lib/agent/reconcile";
import AgentDrawer, { type ChatMessage } from "./AgentDrawer";
import ApprovalLedger from "./ApprovalLedger";
import AuditTimeline from "./AuditTimeline";
import InvoiceGrid from "./InvoiceGrid";
import MatchReview from "./MatchReview";
import { DisputeGrid, SubscriptionsPanel, TransactionGrid } from "./OtherGrids";
import PolicyPanel from "./PolicyPanel";
import { usd } from "./grid";

type Payload = StatePayload<Policy>;
type View = Payload["view"];
type Tab = "invoices" | "payments" | "disputes" | "approvals" | "subscriptions" | "audit";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "invoices", label: "Invoices" },
  { id: "payments", label: "Payments" },
  { id: "disputes", label: "Disputes" },
  { id: "approvals", label: "Approvals" },
  { id: "subscriptions", label: "Retainers" },
  { id: "audit", label: "Audit" },
];

const STORAGE_KEY = "chaser-snapshot-v1";

/** Latest snapshot for this browser tab. Module scope (not a ref) so request bodies can read it lazily. */
let latestSnapshot: unknown;

function loadSavedSnapshot(): unknown {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function saveSnapshot(snapshot: unknown) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* quota or private mode: the in-memory copy still works for this page */
  }
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border border-border bg-panel px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`text-lg font-semibold ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

/**
 * The command center owns the demo state: the server is stateless between requests (serverless-safe), so the
 * browser keeps the snapshot it last received and sends it with every call. Each visitor gets an isolated demo.
 */
export default function CommandCenter() {
  const [view, setView] = useState<View | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Tab>("invoices");
  const [selected, setSelected] = useState<Invoice[]>([]);
  const [showPolicy, setShowPolicy] = useState(false);
  const [pending, setPending] = useState<string | undefined>();
  const [simInvoice, setSimInvoice] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const apply = useCallback((payload: Payload) => {
    latestSnapshot = payload.snapshot;
    saveSnapshot(payload.snapshot);
    setView(payload.view);
    setLoadError("");
  }, []);

  /** POST a state-bearing request with the current snapshot and apply the returned payload. */
  const call = useCallback(
    async (url: string, body: Record<string, unknown> = {}, method = "POST") => {
      try {
        const init: RequestInit = method === "GET" ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, snapshot: latestSnapshot }) };
        const res = await fetch(url, init);
        const data = (await res.json()) as Payload & { error?: string };
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
        apply(data);
        return data;
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
        return undefined;
      }
    },
    [apply],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await call("/api/state");
    setRefreshing(false);
  }, [call]);

  /** Match preview for the match-review grid (pure; records nothing). */
  const fetchMatches = useCallback(async (): Promise<ReconcileResult | undefined> => {
    try {
      const res = await fetch("/api/reconcile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ snapshot: latestSnapshot }) });
      const data = (await res.json()) as ReconcileResult & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      return data;
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  }, []);

  const chat = useChat<ChatMessage>({
    id: "chaser-command-center",
    transport: new DefaultChatTransport({ api: "/api/agent", body: () => ({ snapshot: latestSnapshot }) }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onData: (part) => {
      if (part.type === "data-snapshot") apply(part.data as Payload);
    },
    onError: () => refresh(),
  });
  const busy = chat.status === "streaming" || chat.status === "submitted";

  // First load: continue a saved demo from this tab, else fetch fresh demo data.
  useEffect(() => {
    const saved = loadSavedSnapshot();
    const id = setTimeout(() => {
      latestSnapshot = saved;
      void call("/api/state", {}, saved ? "POST" : "GET");
    }, 0);
    return () => clearTimeout(id);
  }, [call]);

  // Sandbox mode: PayPal is the source of truth, so poll it (webhooks land there too). Mock mode needs no polling.
  useEffect(() => {
    if (view?.mode !== "sandbox" || busy) return;
    const id = setInterval(() => void call("/api/state"), 10_000);
    return () => clearInterval(id);
  }, [view?.mode, busy, call]);

  const now = useMemo(() => new Date(view?.now ?? 0), [view?.now]);
  const kpis = useMemo(() => {
    if (!view) return null;
    const open = view.invoices.filter(isOpenInvoice);
    const overdue = open.filter((i) => overdueDays(i, now) > 0);
    const since = now.getTime() - 30 * 86_400_000;
    return {
      outstanding: open.reduce((a, i) => a + i.due, 0),
      overdue: overdue.reduce((a, i) => a + i.due, 0),
      overdueCount: overdue.length,
      collected: view.transactions.filter((t) => t.type === "PAYMENT" && t.status === "S" && new Date(t.date).getTime() >= since).reduce((a, t) => a + t.amount, 0),
      disputes: view.disputes.filter((d) => d.status !== "RESOLVED").length,
      unmatched: view.transactions.filter((t) => t.type === "PAYMENT" && t.status === "S" && !t.invoice_id).length,
    };
  }, [view, now]);

  const ask = (text: string) => {
    if (busy) return;
    chat.sendMessage({ text });
  };

  const onOverrideChanged = useCallback((id: string, override: Invoice["chase_override"]) => void call(`/api/invoices/${encodeURIComponent(id)}`, { chase_override: override }, "PATCH"), [call]);

  const savePolicy = useCallback(
    async (policy: Policy) => {
      const data = await call("/api/policy", { policy }, "PUT");
      return data ? undefined : "Could not save the policy.";
    },
    [call],
  );

  const resetDemo = async () => {
    chat.setMessages([]);
    await call("/api/seed");
  };

  const simulatePayment = async () => {
    const id = simInvoice || view?.invoices.find((i) => isOpenInvoice(i) && overdueDays(i, now) > 0)?.id;
    if (!id) return;
    await call("/api/simulate", { event: "INVOICING.INVOICE.PAID", invoice_id: id });
    setSimInvoice("");
  };

  const openInvoices = view?.invoices.filter(isOpenInvoice) ?? [];

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
        {view && (
          <span className={`chip ${view.mode === "sandbox" ? "border-accent text-accent" : "text-muted"}`} title={view.mode === "sandbox" ? "Acting on your PayPal sandbox account through the PayPal Agent Toolkit. Play money only." : "Demo data: sandbox-shaped PayPal responses served in-process, isolated per visitor. Add sandbox credentials and the same agent acts on PayPal."}>
            {view.mode === "sandbox" ? "PayPal sandbox" : "Demo data"}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {view?.mode === "mock" && (
            <>
              <select value={simInvoice} onChange={(e) => setSimInvoice(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1.5 text-xs">
                <option value="">Simulate: client pays (oldest overdue)</option>
                {openInvoices.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.invoice_number} - {i.client.business} - {usd(i.due)}
                  </option>
                ))}
              </select>
              <button className="btn" onClick={simulatePayment} disabled={busy} title="Fires an INVOICING.INVOICE.PAID webhook through the real handler">
                Fire webhook
              </button>
              <button className="btn" onClick={resetDemo} disabled={busy}>
                Reset demo
              </button>
            </>
          )}
          <button className="btn" onClick={refresh} disabled={busy || refreshing} title={view?.mode === "sandbox" ? "Re-list invoices, transactions and disputes from PayPal" : "Re-derive the view"}>
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
          <button className={`btn ${showPolicy ? "border-accent text-accent" : ""}`} onClick={() => setShowPolicy(!showPolicy)}>
            Policy
          </button>
        </div>
      </header>

      {loadError && <div className="border-b border-red-300 bg-red-50 px-4 py-1 text-xs text-bad dark:bg-red-950/30">Something went wrong: {loadError}</div>}

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
            <button className="btn btn-primary" onClick={() => ask("Reconcile payments")} disabled={busy || !view} title="Match every unlinked PayPal payment to the right invoice (exact, partial, split) and record it">
              Reconcile payments
            </button>
            <button className="btn" onClick={() => ask("Review disputes")} disabled={busy || !view} title="Accept small disputes under your limit; build and submit evidence packs for the rest">
              Review disputes
            </button>
            <button className="btn" onClick={() => ask("Run collections")} disabled={busy || !view} title="Send policy-driven reminders written from each invoice">
              Run collections
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
              {TABS.map((t) => (
                <button key={t.id} onClick={() => setTab(t.id)} className={`rounded px-2.5 py-1 ${tab === t.id ? "bg-accent text-white" : "hover:text-accent"}`}>
                  {t.label}
                  {view && t.id === "invoices" ? ` (${openInvoices.length})` : ""}
                  {view && t.id === "payments" && kpis?.unmatched ? ` (${kpis.unmatched})` : ""}
                  {view && t.id === "disputes" && kpis?.disputes ? ` (${kpis.disputes})` : ""}
                  {view && t.id === "approvals" ? ` (${view.audit.filter((a) => a.actor === "policy" || a.decision === "approved" || a.decision === "denied").length})` : ""}
                  {view && t.id === "audit" ? ` (${view.audit.length})` : ""}
                </button>
              ))}
            </nav>
          </div>

          <div className="min-h-0 flex-1">
            {!view && !loadError && <div className="text-sm text-muted">Loading...</div>}
            {view && tab === "invoices" && <InvoiceGrid invoices={view.invoices} policy={view.policy} now={now} onSelection={setSelected} onOverrideChanged={onOverrideChanged} />}
            {view && tab === "payments" && (
              <div className="flex h-full flex-col gap-3">
                <div className="min-h-0 flex-[1.1]">
                  <MatchReview transactions={view.transactions} invoices={view.invoices} fetchMatches={fetchMatches} onRecord={ask} busy={busy} />
                </div>
                <div className="min-h-0 flex-1">
                  <TransactionGrid transactions={view.transactions} invoices={view.invoices} />
                </div>
              </div>
            )}
            {view && tab === "disputes" && <DisputeGrid disputes={view.disputes} invoices={view.invoices} onAsk={ask} busy={busy} />}
            {view && tab === "approvals" && <ApprovalLedger entries={view.audit} policy={view.policy} />}
            {view && tab === "subscriptions" && <SubscriptionsPanel plans={view.plans} subscriptions={view.subscriptions} />}
            {view && tab === "audit" && (
              <div className="h-full overflow-y-auto pr-1">
                <AuditTimeline entries={view.audit} />
              </div>
            )}
          </div>
        </main>

        <aside className="flex w-[420px] shrink-0 flex-col border-l border-border bg-background">
          {showPolicy && (
            <div className="max-h-[55%] overflow-y-auto p-3">
              <PolicyPanel policy={view?.policy ?? DEFAULT_POLICY} onSave={savePolicy} />
            </div>
          )}
          <div className="min-h-0 flex-1">
            <AgentDrawer chat={chat} llm={view?.llm ?? "..."} pending={pending} />
          </div>
        </aside>
      </div>
    </div>
  );
}
