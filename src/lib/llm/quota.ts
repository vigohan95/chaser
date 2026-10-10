/**
 * Daily caps for hosted LLM use, so a free-tier key can sit on a public deployment without being burned.
 *
 * In-memory token buckets (per client IP per UTC day, and a global per-day bucket). No database: on serverless
 * each instance keeps its own counters, so the effective cap is "per instance"; the numbers below are chosen so
 * that even a few instances stay far inside the free tier. When a bucket is empty the agent route falls back
 * to the keyless rule planner, which drives the same tools, so the product keeps working.
 *
 *   AGENT_LLM_RUNS_PER_IP_PER_DAY   default 20
 *   AGENT_LLM_RUNS_PER_DAY          default 300
 */

export interface QuotaConfig {
  perIpPerDay: number;
  perDay: number;
}

export interface QuotaVerdict {
  allowed: boolean;
  /** Why the LLM was not used (undefined when allowed). */
  reason?: string;
  remaining: { ip: number; total: number };
  resetsAt: string; // ISO, next UTC midnight
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

export function quotaConfig(): QuotaConfig {
  return { perIpPerDay: envInt("AGENT_LLM_RUNS_PER_IP_PER_DAY", 20), perDay: envInt("AGENT_LLM_RUNS_PER_DAY", 300) };
}

const state = { day: "", perIp: new Map<string, number>(), total: 0 };

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function rollover(now: Date) {
  const key = dayKey(now);
  if (state.day !== key) {
    state.day = key;
    state.perIp.clear();
    state.total = 0;
  }
}

function nextMidnight(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return d.toISOString();
}

/** Consume one LLM run for `ip` if both buckets have room. */
export function takeLlmRun(ip: string, now = new Date(), cfg = quotaConfig()): QuotaVerdict {
  rollover(now);
  const used = state.perIp.get(ip) ?? 0;
  const remaining = { ip: Math.max(0, cfg.perIpPerDay - used), total: Math.max(0, cfg.perDay - state.total) };
  const resetsAt = nextMidnight(now);
  if (remaining.total <= 0) return { allowed: false, reason: `daily LLM cap reached (${cfg.perDay} runs/day across all visitors)`, remaining, resetsAt };
  if (remaining.ip <= 0) return { allowed: false, reason: `your daily LLM cap is used up (${cfg.perIpPerDay} runs/day per visitor)`, remaining, resetsAt };
  state.perIp.set(ip, used + 1);
  state.total += 1;
  return { allowed: true, remaining: { ip: remaining.ip - 1, total: remaining.total - 1 }, resetsAt };
}

/** Peek without consuming. */
export function quotaStatus(ip: string, now = new Date(), cfg = quotaConfig()): QuotaVerdict {
  rollover(now);
  const used = state.perIp.get(ip) ?? 0;
  const remaining = { ip: Math.max(0, cfg.perIpPerDay - used), total: Math.max(0, cfg.perDay - state.total) };
  return { allowed: remaining.ip > 0 && remaining.total > 0, remaining, resetsAt: nextMidnight(now) };
}

export function resetQuota(): void {
  state.day = "";
  state.perIp.clear();
  state.total = 0;
}

/** Client IP as seen behind Vercel / proxies. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim() || "unknown";
  return req.headers.get("x-real-ip") ?? "local";
}
