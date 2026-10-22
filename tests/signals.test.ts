import { describe, expect, it } from "vitest";
import { classifySignals, demoResults, payerSignals, signalsQuery, tavilySearch } from "../src/lib/agent/signals";

describe("payer signals", () => {
  it("classifies distress over change over growth", () => {
    const d = classifySignals([{ title: "X files for Chapter 11", url: "u", content: "bankruptcy after layoffs" }]);
    expect(d.risk).toBe("distress");
    expect(d.evidence[0].matched).toContain("chapter 11");
    const c = classifySignals([{ title: "X acquired by Y", url: "u", content: "the acquisition closed" }]);
    expect(c.risk).toBe("change");
    const g = classifySignals([{ title: "X raises $5M", url: "u", content: "seed round, hiring" }]);
    expect(g.risk).toBe("growth");
    const n = classifySignals([{ title: "X launches new logo", url: "u", content: "nothing financial" }]);
    expect(n.risk).toBe("none");
    expect(n.evidence).toHaveLength(0);
  });

  it("builds the query from business name and company domain, skipping freemail", () => {
    expect(signalsQuery({ business: "Acme Corp", email: "ap@acme.com" })).toBe("Acme Corp acme.com");
    expect(signalsQuery({ business: "Acme Corp", email: "joe@gmail.com" })).toBe("Acme Corp");
    expect(signalsQuery({ name: "Jane Doe" })).toBe("Jane Doe");
    expect(signalsQuery({})).toBe("");
  });

  it("returns labelled demo results without a key, never pretending to be live", async () => {
    const r = await payerSignals({ business: "Acme Corp", email: "ap@acme.com" }, {});
    expect(r.source).toBe("demo");
    expect(r.risk).toBe("distress");
    expect(r.evidence[0].url).toMatch(/demo\.invalid/);
    const none = await payerSignals({ business: "Harbor & Finch LLP" }, {});
    expect(none.risk).toBe("none");
    expect(demoResults("vireo")[0].title).toMatch(/Series A/);
  });

  it("calls Tavily with the news topic and classifies what comes back", async () => {
    const calls: Array<{ url: string; body: unknown; auth: string }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: headers.Authorization });
      return new Response(JSON.stringify({ results: [{ title: "Acme Corp lays off 40%", url: "https://news.example/acme", content: "Acme Corp laid off 40% of staff", published_date: "2026-10-20" }] }), { status: 200 });
    }) as typeof fetch;
    const r = await payerSignals({ business: "Acme Corp" }, { TAVILY_API_KEY: "tvly-test" }, fetchImpl);
    expect(r.source).toBe("tavily");
    expect(r.risk).toBe("distress");
    expect(calls[0].url).toBe("https://api.tavily.com/search");
    expect(calls[0].auth).toBe("Bearer tvly-test");
    expect(calls[0].body).toMatchObject({ query: "Acme Corp", topic: "news", time_range: "month", search_depth: "basic" });
  });

  it("degrades to unknown when the search fails", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 432 })) as typeof fetch;
    const r = await payerSignals({ business: "Acme Corp" }, { TAVILY_API_KEY: "tvly-test" }, fetchImpl);
    expect(r.risk).toBe("unknown");
    expect(r.recommendation).toMatch(/432/);
    await expect(tavilySearch("x", { apiKey: "k", fetchImpl })).rejects.toThrow(/432/);
  });

  it("MOCK_SIGNALS=1 forces the demo path even with a key", async () => {
    const r = await payerSignals({ business: "Bluebird Studio" }, { TAVILY_API_KEY: "tvly-test", MOCK_SIGNALS: "1" });
    expect(r.source).toBe("demo");
    expect(r.risk).toBe("change");
  });
});

describe("after-final proposals carry payer signals", () => {
  it("attaches a labelled demo signal per client when no Tavily key is set", async () => {
    const prev = { ...process.env };
    delete process.env.TAVILY_API_KEY;
    process.env.MOCK_PAYPAL = "1";
    const { localTools } = await import("../src/lib/agent/local-tools");
    const r = (await localTools.propose_after_final.execute!({}, { toolCallId: "t", messages: [] })) as { proposals: Array<{ client: string; signals: { source: string; risk: string; evidence: unknown[] } }> };
    for (const p of r.proposals) {
      expect(p.signals.source).toBe("demo");
      expect(["distress", "change", "growth", "none", "unknown"]).toContain(p.signals.risk);
    }
    process.env = prev;
  });
});
