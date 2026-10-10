"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { useEffect, useRef, useState } from "react";

type Helpers = Pick<UseChatHelpers<UIMessage>, "messages" | "sendMessage" | "status" | "error" | "addToolApprovalResponse" | "stop" | "setMessages">;

const SUGGESTIONS = [
  "Run collections",
  "Reconcile payments",
  "Review disputes",
  "What's outstanding?",
  "I finished the logo package for Acme Corp, $1,200, net 15",
  "Set up a $1,500 monthly retainer for Northwind Traders",
  "Refund $600 on INV-0007",
];

const HUMAN: Record<string, string> = {
  send_invoice_reminder: "Send reminder",
  create_invoice: "Create invoice",
  send_invoice: "Send invoice",
  record_payment_for_invoice: "Record payment",
  record_refund_for_invoice: "Record refund",
  create_refund: "Refund",
  accept_dispute_claim: "Accept dispute",
  create_shipment_tracking: "Add tracking",
  create_subscription: "Create subscription",
  create_subscription_plan: "Create plan",
  create_product: "Create product",
  cancel_sent_invoice: "Cancel invoice",
  propose_collections: "Plan collections",
  match_payments: "Match payments",
  lookup_customer: "Look up client",
  list_disputes: "List disputes",
  draft_dispute_evidence: "Draft evidence",
  summarize_receivables: "Summarize receivables",
  set_chase_override: "Set chasing",
  list_invoices: "List invoices",
  list_transactions: "List transactions",
};

const human = (name: string) => HUMAN[name] ?? name.replaceAll("_", " ");

function Linkify({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer">
            {p.length > 60 ? p.slice(0, 57) + "..." : p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function describeInput(tool: string, input: unknown): { title: string; lines: string[] } {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const amount = (v: unknown) => (v && typeof v === "object" ? `$${(v as { value?: string }).value ?? ""}` : v !== undefined ? `$${String(v)}` : "");
  switch (tool) {
    case "send_invoice_reminder":
      return { title: `Reminder for ${String(i.invoice_id ?? "")}`, lines: [`Subject: ${String(i.subject ?? "")}`, String(i.note ?? "")] };
    case "create_refund":
    case "record_refund_for_invoice":
      return { title: `Refund ${amount(i.amount) || "(full amount)"}`, lines: [i.invoice_id ? `Invoice ${String(i.invoice_id)}` : "", i.capture_id ? `Capture ${String(i.capture_id)}` : "", String(i.note_to_payer ?? "")].filter(Boolean) };
    case "accept_dispute_claim":
      return { title: `Accept dispute ${String(i.dispute_id ?? "")}`, lines: [String(i.note ?? "")] };
    case "record_payment_for_invoice":
      return { title: `Record ${amount(i.amount) || "full"} payment on ${String(i.invoice_id ?? "")}`, lines: [String(i.note ?? "")] };
    case "create_invoice": {
      const items = Array.isArray(i.items) ? (i.items as Array<Record<string, unknown>>) : [];
      const rec = (Array.isArray(i.primary_recipients) ? (i.primary_recipients as Array<Record<string, unknown>>)[0] : undefined)?.billing_info as Record<string, unknown> | undefined;
      return { title: "Create invoice", lines: [`To: ${String(rec?.business_name ?? rec?.email_address ?? "")}`, ...items.map((it) => `${String(it.quantity ?? 1)} x ${String(it.name ?? "")} @ ${amount(it.unit_amount)}`)] };
    }
    case "cancel_sent_invoice":
      return { title: `Cancel invoice ${String(i.invoice_id ?? "")}`, lines: [String(i.note ?? "")] };
    default:
      return { title: human(tool), lines: [JSON.stringify(input).slice(0, 300)] };
  }
}

function ApprovalCard({ tool, input, reason, onDecide }: { tool: string; input: unknown; reason?: string; onDecide: (approved: boolean) => void }) {
  const d = describeInput(tool, input);
  return (
    <div className="rounded-lg border-2 border-amber-400 bg-amber-50 p-3 text-sm dark:border-amber-500 dark:bg-amber-950/30">
      <div className="flex items-center gap-2">
        <span className="rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">Approval needed</span>
        <span className="font-semibold">{d.title}</span>
      </div>
      {reason && <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">Policy: {reason}</p>}
      <div className="mt-2 space-y-1 whitespace-pre-wrap rounded bg-panel p-2 text-xs">
        {d.lines.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <button className="btn btn-primary" onClick={() => onDecide(true)}>
          Approve
        </button>
        <button className="btn" onClick={() => onDecide(false)}>
          Deny
        </button>
      </div>
    </div>
  );
}

function ToolChip({ name, state, input, output, errorText }: { name: string; state: string; input: unknown; output: unknown; errorText?: string }) {
  const [open, setOpen] = useState(false);
  const outObj = output && typeof output === "object" ? (output as Record<string, unknown>) : undefined;
  const failed = state === "output-error" || !!outObj?.error;
  const denied = state === "output-denied";
  const icon = failed ? "x" : denied ? "-" : state === "output-available" ? "ok" : "...";
  const tone = failed ? "border-red-300 text-bad" : denied ? "border-slate-300 text-muted line-through" : state === "output-available" ? "border-green-300 text-ok" : "border-border text-muted";
  return (
    <div className="text-xs">
      <button className={`chip ${tone}`} onClick={() => setOpen(!open)} title={state}>
        <span className="font-mono text-[10px]">{icon}</span> {human(name)}
      </button>
      {denied && <span className="ml-2 text-muted">blocked by policy</span>}
      {outObj?.error ? <span className="ml-2 text-bad">{String(outObj.error)}</span> : null}
      {open && (
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-background p-2 font-mono text-[10px]">
          {`input: ${JSON.stringify(input, null, 1)}\n`}
          {output !== undefined ? `output: ${JSON.stringify(output, null, 1)}` : errorText ? `error: ${errorText}` : ""}
        </pre>
      )}
    </div>
  );
}

export default function AgentDrawer({ chat, llm, pending }: { chat: Helpers; llm: string; pending?: string }) {
  const { messages, sendMessage, status, error, addToolApprovalResponse, stop, setMessages } = chat;
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const busy = status === "streaming" || status === "submitted";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  useEffect(() => {
    if (pending) setInput(pending);
  }, [pending]);

  const send = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    sendMessage({ text: t });
    setInput("");
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div>
          <div className="text-sm font-semibold">Agent</div>
          <div className="text-[11px] text-muted">model: {llm}</div>
        </div>
        <div className="flex gap-1">
          {busy && (
            <button className="btn" onClick={stop}>
              Stop
            </button>
          )}
          {messages.length > 0 && !busy && (
            <button className="btn" onClick={() => setMessages([])}>
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted">
            Tell Chaser what you did, or ask it to chase, reconcile or handle disputes. It acts on PayPal within your policy and asks before anything outside it.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "ml-8" : "mr-2"}>
            <div className={`rounded-lg px-3 py-2 text-sm ${m.role === "user" ? "bg-accent text-white" : "bg-panel border border-border"}`}>
              <div className="space-y-2">
                {m.parts.map((part, idx) => {
                  if (part.type === "text") {
                    return (
                      <div key={idx} className="prose-chat whitespace-pre-wrap">
                        <Linkify text={part.text} />
                      </div>
                    );
                  }
                  if (isToolUIPart(part)) {
                    const name = getToolName(part);
                    if (part.state === "approval-requested") {
                      return <ApprovalCard key={idx} tool={name} input={part.input} reason={part.approval.requestReason} onDecide={(approved) => addToolApprovalResponse({ id: part.approval.id, approved, reason: approved ? "Approved in the command center" : "Denied in the command center" })} />;
                    }
                    if (part.state === "approval-responded") {
                      return (
                        <div key={idx} className="text-xs">
                          <span className="chip">{human(name)}</span> <span className={part.approval.approved ? "text-ok" : "text-bad"}>{part.approval.approved ? "approved by you" : "denied by you"}</span>
                        </div>
                      );
                    }
                    return <ToolChip key={idx} name={name} state={part.state} input={part.input} output={"output" in part ? part.output : undefined} errorText={"errorText" in part ? part.errorText : undefined} />;
                  }
                  return null;
                })}
              </div>
            </div>
          </div>
        ))}
        {busy && <div className="text-xs text-muted">working...</div>}
        {error && <div className="rounded border border-red-300 bg-red-50 p-2 text-xs text-bad dark:bg-red-950/30">{error.message}</div>}
        <div ref={endRef} />
      </div>

      <div className="border-t border-border p-2">
        <div className="mb-2 flex flex-wrap gap-1">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip hover:border-accent hover:text-accent" onClick={() => send(s)} disabled={busy}>
              {s}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="e.g. I finished the website for Bluebird, $2,400, net 30" className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent" />
          <button type="submit" className="btn btn-primary" disabled={busy || !input.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
