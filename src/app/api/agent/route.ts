import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, getToolName, isToolUIPart, streamText, toUIMessageStream, type UIMessage } from "ai";
import { agentSetup } from "@/lib/agent/run";
import { getDisputes, getInvoices } from "@/lib/paypal/backend";
import { evaluateAction } from "@/lib/policy/engine";
import { audit, getStore } from "@/lib/store";
import { readBody, statePayload, withSnapshot } from "@/lib/api";
import { isMockLlm } from "@/lib/env";
import { clientIp, takeLlmRun } from "@/lib/llm/quota";
import { approvalWaitSpan } from "@/lib/telemetry";

export const maxDuration = 60;

/** The user's Approve / Deny answers arrive as tool parts in state "approval-responded"; ledger them once each. */
async function auditApprovalResponses(messages: UIMessage[]) {
  const store = getStore();
  const seen = new Set(store.audit.map((a) => (a.output as { approval_id?: string } | undefined)?.approval_id).filter(Boolean));
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const part of m.parts) {
      if (!isToolUIPart(part) || part.state !== "approval-responded" || seen.has(part.approval.id)) continue;
      const tool = getToolName(part);
      const [invoices, disputes] = await Promise.all([getInvoices(), getDisputes()]);
      const ev = evaluateAction(tool, part.input, { policy: store.policy, invoices, disputes });
      // The wait for a human spans two requests; it is reconstructed from the "waiting for your approval" audit entry.
      const key = JSON.stringify(part.input);
      const request = store.audit.find((a) => a.decision === "approval-required" && a.tool === tool && JSON.stringify(a.input) === key);
      const waitMs = approvalWaitSpan(request, { tool, approved: part.approval.approved, rule: ev.rule });
      audit({ actor: "user", tool, action: `${ev.summary} - ${part.approval.approved ? "approved" : "denied"} by you`, decision: part.approval.approved ? "approved" : "denied", reason: part.approval.reason ?? ev.reason, rule: ev.rule, input: part.input, output: { approval_id: part.approval.id, ...(waitMs !== undefined ? { wait_ms: waitMs } : {}) } });
      seen.add(part.approval.id);
    }
  }
}

/**
 * Chat endpoint. Body: { messages: UIMessage[], snapshot?: Store }.
 * The snapshot is hydrated for this request; when the agent finishes (or pauses for approval) the new
 * view + snapshot are sent to the client as a transient `data-snapshot` part.
 */
export async function POST(req: Request) {
  const body = await readBody(req);
  const messages = (Array.isArray(body.messages) ? body.messages : []) as UIMessage[];
  // Hosted LLM keys are protected by daily caps (per visitor and global); past the cap the keyless planner takes over.
  const quota = isMockLlm() ? undefined : takeLlmRun(clientIp(req));
  const capped = quota !== undefined && !quota.allowed;
  return withSnapshot(body, async () => {
    await auditApprovalResponses(messages);
    const setup = agentSetup({ forceMock: capped });
    const modelMessages = await convertToModelMessages(messages, { tools: setup.tools, ignoreIncompleteToolCalls: true });
    const stream = createUIMessageStream({
      originalMessages: messages,
      onError: (e) => (e instanceof Error ? e.message : String(e)),
      execute: async ({ writer }) => {
        const result = streamText({
          model: setup.model,
          system: setup.system,
          messages: modelMessages,
          tools: setup.tools,
          stopWhen: setup.stopWhen,
          toolApproval: setup.toolApproval,
          onError: ({ error }) => console.error("[agent]", error),
        });
        const reader = toUIMessageStream({ stream: result.stream, originalMessages: messages, sendStart: true, sendFinish: true }).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          writer.write(value);
        }
        const payload = await statePayload();
        if (capped) payload.view.llm = `rule planner (${quota?.reason}; LLM back after ${quota?.resetsAt.slice(11, 16)} UTC)`;
        writer.write({ type: "data-snapshot", data: payload, transient: true });
      },
    });
    return createUIMessageStreamResponse({ stream });
  });
}
