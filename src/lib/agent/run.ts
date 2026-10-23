/**
 * Shared agent wiring for the chat route and the unattended cron run.
 */
import { generateText, stepCountIs, type ModelMessage, type ToolApprovalStatus, type ToolSet } from "ai";
import { getModel } from "../llm";
import { currentMode, getDisputes, getInvoices } from "../paypal/backend";
import { evaluateAction } from "../policy/engine";
import { audit, getStore } from "../store";
import { systemPrompt } from "./system";
import { withSpan } from "../telemetry";
import { buildTools } from "./tools";

export const MAX_STEPS = 14;

export interface AgentSetup {
  model: ReturnType<typeof getModel>;
  tools: ToolSet;
  system: string;
  stopWhen: ReturnType<typeof stepCountIs>;
  /** AI SDK v7 `toolApproval` hook: the policy engine decides allow / ask / deny per tool call. */
  toolApproval: (options: { toolCall: { toolName: string; input: unknown; toolCallId?: string } }) => Promise<ToolApprovalStatus>;
}

export function agentSetup(opts: { unattended?: boolean; forceMock?: boolean } = {}): AgentSetup {
  const store = getStore();
  const tools = buildTools();
  return {
    model: getModel({ forceMock: opts.forceMock }),
    tools,
    system: systemPrompt(store.policy, currentMode()),
    stopWhen: stepCountIs(MAX_STEPS),
    toolApproval: async ({ toolCall }) => {
      // The policy check is a span of its own: the SDK sees the tool call, not the verdict or what it cost to reach it.
      // toolApproval runs outside the SDK's span context, so the span is a root; the tool call id lets a backend join it to the step.
      const ev = await withSpan("chaser.policy.decide", { "chaser.tool": toolCall.toolName, ...(toolCall.toolCallId ? { "gen_ai.tool.call.id": toolCall.toolCallId } : {}) }, async (span) => {
        const [invoices, disputes] = await Promise.all([getInvoices(), getDisputes()]);
        const verdict = evaluateAction(toolCall.toolName, toolCall.input, { policy: store.policy, invoices, disputes });
        span.setAttributes({ "chaser.policy.decision": verdict.decision, "chaser.policy.rule": verdict.rule ?? "", "chaser.policy.summary": verdict.summary });
        return verdict;
      });
      if (ev.decision === "deny") {
        audit({ actor: "policy", tool: toolCall.toolName, action: `${ev.summary} - blocked`, decision: "denied", reason: ev.reason, rule: ev.rule, input: toolCall.input });
        return { type: "denied", reason: ev.reason };
      }
      if (ev.decision === "approve") {
        if (opts.unattended) {
          audit({ actor: "policy", tool: toolCall.toolName, action: `${ev.summary} - needs you (skipped in unattended run)`, decision: "approval-required", reason: ev.reason, rule: ev.rule, input: toolCall.input });
          return { type: "denied", reason: `Needs human approval (${ev.reason}). Skipped because this run is unattended; ask again from the command center.` };
        }
        // The SDK re-runs toolApproval when the conversation continues after the user's answer; log the request once.
        const key = JSON.stringify(toolCall.input);
        const already = store.audit.slice(0, 30).some((a) => a.decision === "approval-required" && a.tool === toolCall.toolName && JSON.stringify(a.input) === key);
        if (!already) audit({ actor: "policy", tool: toolCall.toolName, action: `${ev.summary} - waiting for your approval`, decision: "approval-required", reason: ev.reason, rule: ev.rule, input: toolCall.input });
        return { type: "user-approval", reason: ev.reason };
      }
      return { type: "approved", reason: ev.reason };
    },
  };
}

/** One-shot, non-streaming run (cron sweep, tests). Policy-gated actions that need a human are skipped. */
export async function runOnce(prompt: string, opts: { unattended?: boolean; messages?: ModelMessage[] } = {}) {
  const setup = agentSetup({ unattended: opts.unattended ?? true });
  const result = await generateText({
    model: setup.model,
    system: setup.system,
    tools: setup.tools,
    stopWhen: setup.stopWhen,
    toolApproval: setup.toolApproval,
    ...(opts.messages ? { messages: [...opts.messages, { role: "user", content: prompt }] } : { prompt }),
  });
  return { text: result.text, steps: result.steps.length, toolCalls: result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)) };
}
