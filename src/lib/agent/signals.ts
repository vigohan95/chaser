/**
 * Payer signals: what the open web says about a client right before Chaser escalates.
 *
 * A firm or final notice to a company that just filed for bankruptcy, laid off half its staff or got acquired is
 * the wrong move; a settlement offer or a hand-off is. Conversely a client that just raised a round can be chased
 * normally. The agent calls `check_payer_signals` before a final notice or an after-final decision; the result is
 * evidence (titles, URLs, dates), a risk band and a recommendation, never a verdict the agent must obey.
 *
 * Source: Tavily search (`TAVILY_API_KEY`, topic=news, last month, 1 credit per call). Without a key, or with
 * MOCK_SIGNALS=1, a deterministic demo set is returned and labelled source "demo" so nothing is passed off as real.
 */

export type SignalRisk = "distress" | "change" | "growth" | "none" | "unknown";

export interface SignalEvidence {
  title: string;
  url: string;
  published_date?: string;
  snippet: string;
  matched: string[];
}

export interface PayerSignals {
  query: string;
  source: "tavily" | "demo";
  risk: SignalRisk;
  evidence: SignalEvidence[];
  recommendation: string;
  checked_at: string;
}

const DISTRESS = ["bankrupt", "bankruptcy", "chapter 11", "chapter 7", "insolven", "administration", "receivership", "liquidat", "shuts down", "shutting down", "ceases operations", "winding down", "layoffs", "lays off", "laid off", "missed payroll", "default", "lawsuit", "sued", "fraud", "sec charges"];
const CHANGE = ["acquired", "acquisition", "merger", "merges with", "rebrand", "new ceo", "ceo steps down", "restructur", "spin-off", "sold to"];
const GROWTH = ["raises", "raised", "funding round", "series a", "series b", "series c", "seed round", "ipo", "record revenue", "expands", "expansion", "new office", "hiring"];

function hits(text: string, words: string[]): string[] {
  const t = text.toLowerCase();
  return words.filter((w) => t.includes(w));
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  published_date?: string;
}

/** Pure classification of search results into a risk band. Exported for tests and the demo path. */
export function classifySignals(results: SearchResult[]): Pick<PayerSignals, "risk" | "evidence" | "recommendation"> {
  const evidence: SignalEvidence[] = [];
  let distress = 0;
  let change = 0;
  let growth = 0;
  for (const r of results) {
    const text = `${r.title} ${r.content}`;
    const d = hits(text, DISTRESS);
    const c = hits(text, CHANGE);
    const g = hits(text, GROWTH);
    if (d.length + c.length + g.length === 0) continue;
    distress += d.length;
    change += c.length;
    growth += g.length;
    evidence.push({ title: r.title, url: r.url, published_date: r.published_date, snippet: r.content.slice(0, 240), matched: [...d, ...c, ...g] });
  }
  let risk: SignalRisk = "none";
  if (distress > 0 && distress >= change) risk = "distress";
  else if (change > 0) risk = "change";
  else if (growth > 0) risk = "growth";
  const recommendation =
    risk === "distress"
      ? "Do not send a firm or final notice. Offer a settlement or hand the account off while there is still something to collect; cite the article in the note."
      : risk === "change"
        ? "Ownership or leadership changed. Confirm who now owns payables before escalating; a resend to a new AP contact beats a final notice."
        : risk === "growth"
          ? "The client is funded and active. Normal cadence applies; a firm tone is reasonable if they are late."
          : "No public signal found. Fall back on payment history.";
  return { risk, evidence, recommendation };
}

export async function tavilySearch(query: string, opts: { apiKey: string; maxResults?: number; fetchImpl?: typeof fetch }): Promise<SearchResult[]> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f("https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, topic: "news", search_depth: "basic", time_range: "month", max_results: opts.maxResults ?? 5, include_answer: false }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const json = (await res.json()) as { results?: Partial<SearchResult>[] };
  return (json.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", content: r.content ?? "", published_date: r.published_date }));
}

/** Demo fixtures: stable per client so the walkthrough is reproducible. Clearly labelled, never mixed with real data. */
export function demoResults(query: string, today = new Date().toISOString().slice(0, 10)): SearchResult[] {
  const q = query.toLowerCase();
  if (q.includes("acme")) return [{ title: "Acme Corp files for Chapter 11 protection", url: "https://demo.invalid/acme-chapter-11", content: "Acme Corp filed for Chapter 11 bankruptcy on Monday after missing payroll; a creditors meeting is set for next month.", published_date: today }];
  if (q.includes("bluebird")) return [{ title: "Bluebird Studio acquired by Northwind Group", url: "https://demo.invalid/bluebird-acquired", content: "Northwind Group completed its acquisition of Bluebird Studio; finance operations move to Northwind's shared services team.", published_date: today }];
  if (q.includes("vireo")) return [{ title: "Vireo Labs raises $12M Series A", url: "https://demo.invalid/vireo-series-a", content: "Vireo Labs raised a $12M Series A to expand its platform and is hiring across engineering.", published_date: today }];
  return [];
}

const FREEMAIL = /gmail|outlook|yahoo|hotmail|icloud|proton/i;

export function signalsQuery(input: { business?: string; name?: string; email?: string }): string {
  const domain = input.email?.split("@")[1];
  return [input.business || input.name, domain && !FREEMAIL.test(domain) ? domain : undefined].filter(Boolean).join(" ");
}

export function signalsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MOCK_SIGNALS !== "1" && !!env.TAVILY_API_KEY;
}

export async function payerSignals(
  input: { business?: string; name?: string; email?: string },
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): Promise<PayerSignals> {
  const query = signalsQuery(input);
  const checked_at = new Date().toISOString();
  if (!query) return { query, source: "demo", risk: "unknown", evidence: [], recommendation: "No business name or company domain to search for.", checked_at };
  if (!signalsEnabled(env)) return { query, source: "demo", checked_at, ...classifySignals(demoResults(query)) };
  try {
    const results = await tavilySearch(query, { apiKey: env.TAVILY_API_KEY!, fetchImpl });
    return { query, source: "tavily", checked_at, ...classifySignals(results) };
  } catch (e) {
    return { query, source: "tavily", risk: "unknown", evidence: [], recommendation: `Search failed (${e instanceof Error ? e.message : String(e)}); fall back on payment history.`, checked_at };
  }
}
