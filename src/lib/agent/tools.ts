/**
 * The agent's tool set = PayPal Agent Toolkit tools (schemas verbatim, re-wrapped for AI SDK v7)
 * + Chaser's local planning tools. Every execution is written to the audit log.
 */
import { tool, type ToolSet } from "ai";
import { currentMode, execute, getDisputes, getInvoices } from "../paypal/backend";
import { getRawTools } from "../paypal/live";
import { addReminder, findInvoice as findMockInvoice } from "../paypal/mock";
import { evaluateAction } from "../policy/engine";
import { audit, getStore, overlayFor } from "../store";
import { localTools } from "./local-tools";

/** Subset of the 47 toolkit tools that matter for receivables. Keeps the model focused. */
export const PAYPAL_TOOL_NAMES = [
  // invoices
  "list_invoices",
  "get_invoice",
  "search_invoicing",
  "generate_invoice_number",
  "create_invoice",
  "send_invoice",
  "send_invoice_reminder",
  "cancel_sent_invoice",
  "generate_invoice_qr_code",
  "record_payment_for_invoice",
  "record_refund_for_invoice",
  "setup_invoice_auto_reminders",
  // payments / reporting
  "list_transactions",
  "create_refund",
  // disputes
  "list_disputes",
  "get_dispute",
  "accept_dispute_claim",
  // shipment tracking
  "create_shipment_tracking",
  "get_shipment_tracking",
  // catalog + subscriptions
  "create_product",
  "list_products",
  "create_subscription_plan",
  "list_subscription_plans",
  "create_subscription",
  "show_subscription_details",
  "cancel_subscription",
] as const;

export type PayPalToolName = (typeof PAYPAL_TOOL_NAMES)[number];

function summarize(value: unknown, max = 400): unknown {
  try {
    const s = JSON.stringify(value);
    return s.length > max ? s.slice(0, max) + "..." : value;
  } catch {
    return String(value);
  }
}

async function logExecution(name: string, input: unknown, output: unknown, error?: string) {
  const [invoices, disputes] = await Promise.all([getInvoices(), getDisputes()]);
  const ev = evaluateAction(name, input, { policy: getStore().policy, invoices, disputes });
  audit({
    actor: "agent",
    tool: name,
    action: error ? `${ev.summary} - failed` : ev.summary,
    decision: error ? "error" : ev.decision === "approve" ? "approved" : "allowed",
    reason: error ?? (ev.decision === "approve" ? `You approved this. ${ev.reason}` : ev.reason),
    input: summarize(input),
    output: summarize(output),
  });
}

/** Record reminders locally in sandbox mode (PayPal does not expose a reminder count). */
function noteReminderOverlay(name: string, input: unknown) {
  if (name !== "send_invoice_reminder" || currentMode() !== "sandbox") return;
  const i = input as { invoice_id?: string; subject?: string; note?: string };
  if (!i.invoice_id) return;
  const text = `${i.subject ?? ""} ${i.note ?? ""}`.toLowerCase();
  const stage = text.includes("final") ? "final" : text.includes("overdue") || text.includes("past due") ? "firm" : "friendly";
  overlayFor(i.invoice_id).reminders.push({ at: new Date().toISOString(), stage, subject: i.subject });
}

export function buildTools(): ToolSet {
  const raw = getRawTools();
  const tools: ToolSet = {};
  for (const name of PAYPAL_TOOL_NAMES) {
    const r = raw[name];
    if (!r) continue;
    tools[name] = tool({
      description: r.description,
      inputSchema: r.parameters,
      execute: async (input: unknown) => {
        try {
          const output = await execute(name, input);
          noteReminderOverlay(name, input);
          await logExecution(name, input, output);
          return output;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          await logExecution(name, input, undefined, message);
          return { error: message };
        }
      },
    });
  }
  Object.assign(tools, localTools);
  return tools;
}

export const __test = { addReminder, findMockInvoice };
