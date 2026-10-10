import { convertToModelMessages, createUIMessageStreamResponse, streamText, toUIMessageStream, type UIMessage } from "ai";
import { agentSetup } from "@/lib/agent/run";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { messages } = (await req.json()) as { messages: UIMessage[] };
  const setup = agentSetup();
  const result = streamText({
    model: setup.model,
    system: setup.system,
    messages: await convertToModelMessages(messages, { tools: setup.tools, ignoreIncompleteToolCalls: true }),
    tools: setup.tools,
    stopWhen: setup.stopWhen,
    toolApproval: setup.toolApproval,
    onError: ({ error }) => console.error("[agent]", error),
  });
  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream, originalMessages: messages, onError: (e) => (e instanceof Error ? e.message : String(e)) }),
  });
}
