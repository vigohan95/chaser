/**
 * Two real agent turns against Nebius Token Factory (Nemotron) with the mock PayPal backend, traced end to end:
 * the AI SDK's OpenTelemetry integration for the run / step / model-call / tool spans (with token usage) and Chaser's
 * own spans for the policy verdicts. Spans are kept in memory, printed as a tree with durations, and written to
 * traces/<timestamp>.json so the numbers in a write-up can be checked.
 *
 * Usage: npm run trace:smoke   (reads .env.local; forces LLM_PROVIDER=nebius, MOCK_PAYPAL=1). Never prints the key.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
process.env.LLM_PROVIDER = "nebius";
process.env.MOCK_PAYPAL = "1";
process.env.MOCK_LLM = "0";

import { mkdirSync, writeFileSync } from "node:fs";
import { hrTimeToMilliseconds } from "@opentelemetry/core";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";
import { OpenTelemetry } from "@ai-sdk/otel";
import { registerTelemetry } from "ai";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
registerTelemetry(new OpenTelemetry({ tracer: trace.getTracer("ai-sdk"), usage: true }));

function ms(span: ReadableSpan): number {
  return Math.round(hrTimeToMilliseconds(span.duration));
}

function pick(span: ReadableSpan): string {
  const a = span.attributes;
  const bits: string[] = [];
  if (a["gen_ai.request.model"]) bits.push(String(a["gen_ai.request.model"]));
  if (a["gen_ai.usage.input_tokens"] !== undefined) bits.push(`in=${a["gen_ai.usage.input_tokens"]} out=${a["gen_ai.usage.output_tokens"]}`);
  if (a["gen_ai.tool.name"]) bits.push(`tool=${a["gen_ai.tool.name"]}`);
  if (a["chaser.tool"]) bits.push(`tool=${a["chaser.tool"]}`);
  if (a["chaser.policy.decision"]) bits.push(`policy=${a["chaser.policy.decision"]} (${a["chaser.policy.rule"] || "no rule"})`);
  if (a["gen_ai.response.finish_reasons"]) bits.push(`finish=${a["gen_ai.response.finish_reasons"]}`);
  return bits.join("  ");
}

function printTree(spans: ReadableSpan[]): void {
  const byParent = new Map<string | undefined, ReadableSpan[]>();
  for (const s of spans) {
    const parent = s.parentSpanContext?.spanId;
    byParent.set(parent, [...(byParent.get(parent) ?? []), s]);
  }
  const walk = (parent: string | undefined, depth: number) => {
    for (const s of (byParent.get(parent) ?? []).sort((x, y) => hrTimeToMilliseconds(x.startTime) - hrTimeToMilliseconds(y.startTime))) {
      console.log(`${"  ".repeat(depth)}${s.name.padEnd(Math.max(8, 44 - depth * 2))} ${String(ms(s)).padStart(6)} ms  ${pick(s)}`);
      walk(s.spanContext().spanId, depth + 1);
    }
  };
  walk(undefined, 0);
}

async function turn(label: string, prompt: string) {
  const { runOnce } = await import("../src/lib/agent/run");
  const t0 = Date.now();
  const r = await runOnce(prompt, { unattended: true });
  console.log(`\n=== ${label}: ${r.steps} steps, tools: ${r.toolCalls.join(", ") || "(none)"}, ${Date.now() - t0} ms wall ===`);
  console.log(r.text.slice(0, 300).replace(/\n+/g, " ") + (r.text.length > 300 ? " ..." : ""));
}

async function main() {
  const { activeModelId } = await import("../src/lib/llm");
  console.log("model:", activeModelId());
  await turn("chase", "Which invoices are overdue right now, and what is the next chase step for each? Keep it short.");
  await turn("after-final", "Run the after-final review across all open invoices and carry out what the policy proposes.");
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  console.log(`\n${spans.length} spans:`);
  printTree(spans);
  const totals = spans.reduce(
    (t, s) => {
      if (s.name.startsWith("chat ")) {
        // model-call spans only: the invoke_agent span repeats the sum of its steps
        t.input += Number(s.attributes["gen_ai.usage.input_tokens"] ?? 0);
        t.output += Number(s.attributes["gen_ai.usage.output_tokens"] ?? 0);
      }
      if (s.name.startsWith("chaser.policy")) t.policyMs += ms(s);
      if (s.attributes["gen_ai.tool.name"]) t.toolMs += ms(s);
      if (s.name.startsWith("chat ")) t.modelMs += ms(s);
      return t;
    },
    { input: 0, output: 0, policyMs: 0, toolMs: 0, modelMs: 0 },
  );
  console.log("\ntotals:", totals);
  mkdirSync("traces", { recursive: true });
  const out = `traces/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(
    out,
    JSON.stringify(
      spans.map((s) => ({ name: s.name, span_id: s.spanContext().spanId, parent_id: s.parentSpanContext?.spanId, start_ms: hrTimeToMilliseconds(s.startTime), duration_ms: ms(s), attributes: s.attributes, status: s.status })),
      null,
      1,
    ),
  );
  console.log("written:", out);
  await provider.shutdown();
}

main().catch((e) => {
  console.error("trace smoke failed:", e?.message ?? e);
  process.exit(1);
});
