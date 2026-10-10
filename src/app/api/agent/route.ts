import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, streamText, toUIMessageStream, type UIMessage } from "ai";
import { agentSetup } from "@/lib/agent/run";
import { readBody, statePayload, withSnapshot } from "@/lib/api";
import { isMockLlm } from "@/lib/env";
import { clientIp, takeLlmRun } from "@/lib/llm/quota";

export const maxDuration = 60;

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
