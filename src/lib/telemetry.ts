/**
 * Tracing for the agent loop.
 *
 * The AI SDK's own integration (`@ai-sdk/otel`, registered by the caller, see scripts/trace-smoke.ts) produces the
 * spans for the agent run, each step, each model call (with token usage) and each tool execution. Two things the SDK
 * cannot see are added here as spans of their own:
 *
 *   chaser.policy.decide   the policy engine's verdict on a tool call (allow / ask / deny), with the rule it cited and
 *                          how long the check took (it reads invoices and disputes first)
 *   chaser.approval.wait   the time between the policy asking a human and the human answering; it spans two HTTP
 *                          requests, so it is built from the audit log's timestamps rather than from a live context
 *
 * Without a registered tracer provider `@opentelemetry/api` hands back a no-op tracer, so the app pays nothing.
 */
import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import type { AuditEntry } from "./paypal/types";

export const TRACER_NAME = "chaser";

export function tracer() {
  return trace.getTracer(TRACER_NAME);
}

/** Run `fn` inside a span; the span's status follows the outcome and extra attributes can be set from the result. */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      span.end();
    }
  });
}

/**
 * The human-in-the-loop wait as a span: starts when the policy wrote "waiting for your approval" to the audit log,
 * ends now (the request that carried the user's answer). Returns the wait in ms, or undefined when the request entry
 * cannot be found (nothing is recorded then; a guessed start time would be worse than no span).
 */
export function approvalWaitSpan(request: AuditEntry | undefined, response: { tool: string; approved: boolean; rule?: string }): number | undefined {
  if (!request) return undefined;
  const start = Date.parse(request.ts);
  if (!Number.isFinite(start)) return undefined;
  const end = Date.now();
  const span = tracer().startSpan("chaser.approval.wait", {
    startTime: start,
    attributes: {
      "chaser.tool": response.tool,
      "chaser.approval.decision": response.approved ? "approved" : "denied",
      "chaser.approval.wait_ms": end - start,
      ...(response.rule ? { "chaser.policy.rule": response.rule } : {}),
    },
  });
  span.end(end);
  return end - start;
}
