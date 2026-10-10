/** Daily LLM caps for the hosted demo: per-visitor and global buckets, UTC-day rollover, fallback label. */
import { beforeEach, describe, expect, it } from "vitest";
import { clientIp, quotaStatus, resetQuota, takeLlmRun } from "@/lib/llm/quota";

const cfg = { perIpPerDay: 2, perDay: 3 };
const day = new Date("2026-10-10T10:00:00Z");

beforeEach(() => resetQuota());

describe("takeLlmRun", () => {
  it("caps per visitor, then globally, and reports what is left", () => {
    expect(takeLlmRun("a", day, cfg)).toMatchObject({ allowed: true, remaining: { ip: 1, total: 2 } });
    expect(takeLlmRun("a", day, cfg)).toMatchObject({ allowed: true, remaining: { ip: 0, total: 1 } });
    expect(takeLlmRun("a", day, cfg)).toMatchObject({ allowed: false, reason: expect.stringContaining("per visitor") });
    expect(takeLlmRun("b", day, cfg)).toMatchObject({ allowed: true, remaining: { ip: 1, total: 0 } });
    expect(takeLlmRun("b", day, cfg)).toMatchObject({ allowed: false, reason: expect.stringContaining("across all visitors") });
    expect(quotaStatus("c", day, cfg).allowed).toBe(false);
    expect(takeLlmRun("a", day, cfg).resetsAt).toBe("2026-10-11T00:00:00.000Z");
  });
  it("resets at UTC midnight", () => {
    takeLlmRun("a", day, cfg);
    takeLlmRun("a", day, cfg);
    expect(takeLlmRun("a", day, cfg).allowed).toBe(false);
    expect(takeLlmRun("a", new Date("2026-10-11T00:00:01Z"), cfg).allowed).toBe(true);
  });
  it("reads the caps from the environment with safe defaults", () => {
    const prev = { ip: process.env.AGENT_LLM_RUNS_PER_IP_PER_DAY, total: process.env.AGENT_LLM_RUNS_PER_DAY };
    delete process.env.AGENT_LLM_RUNS_PER_IP_PER_DAY;
    delete process.env.AGENT_LLM_RUNS_PER_DAY;
    expect(takeLlmRun("z", day).remaining).toEqual({ ip: 19, total: 299 });
    process.env.AGENT_LLM_RUNS_PER_IP_PER_DAY = "1";
    process.env.AGENT_LLM_RUNS_PER_DAY = "abc";
    resetQuota();
    expect(takeLlmRun("z", day).remaining).toEqual({ ip: 0, total: 299 });
    if (prev.ip !== undefined) process.env.AGENT_LLM_RUNS_PER_IP_PER_DAY = prev.ip;
    else delete process.env.AGENT_LLM_RUNS_PER_IP_PER_DAY;
    if (prev.total !== undefined) process.env.AGENT_LLM_RUNS_PER_DAY = prev.total;
    else delete process.env.AGENT_LLM_RUNS_PER_DAY;
  });
  it("derives the visitor ip from proxy headers", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" } }))).toBe("203.0.113.5");
    expect(clientIp(new Request("http://x", { headers: { "x-real-ip": "198.51.100.7" } }))).toBe("198.51.100.7");
    expect(clientIp(new Request("http://x"))).toBe("local");
  });
});
