/**
 * Pins the published reconciliation benchmark (docs/RECONCILIATION-BENCHMARK.md, README). If a matcher change moves
 * a number, regenerate the report with `npm run bench:recon` and update both the docs and these expectations.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderBenchMarkdown, scoreBench, type BenchFile } from "@/lib/agent/recon-bench";

const file = JSON.parse(readFileSync(new URL("./fixtures/recon-bench.json", import.meta.url), "utf8")) as BenchFile;
const r = scoreBench(file);
const rule = (name: string) => r.per_rule.find((x) => x.rule === name)!;

describe("reconciliation benchmark (tests/fixtures/recon-bench.json)", () => {
  it("has at least 60 labelled transactions across the scenario types", () => {
    expect(file.labels.length).toBe(71);
    expect(file.invoices.length).toBe(81);
    const scenarios = new Set(file.labels.map((l) => l.scenario));
    for (const s of ["memo_exact", "memo_other_payer", "partial_memo", "payer_exact", "fee_adjusted", "combined", "partial", "overpayment", "ambiguous", "duplicate", "refund", "amount_only", "currency_mismatch", "off_invoice", "repeat_instalment"]) expect(scenarios.has(s), s).toBe(true);
  });

  it("scores 70 / 71 overall and records nothing wrong automatically", () => {
    expect(r.correct).toBe(70);
    expect(r.transactions).toBe(71);
    expect(r.accuracy).toBeCloseTo(0.986, 3);
    expect(r.auto_record_predicted).toBe(53);
    expect(r.auto_record_correct).toBe(53);
    expect(r.auto_record_precision).toBe(1);
  });

  it("publishes precision / recall per rule", () => {
    const perfect = ["memo_exact", "memo_other_payer", "partial_memo", "payer_exact", "fee_adjusted", "combined", "overpayment", "ambiguous", "amount_only", "refund", "unmatched"];
    for (const name of perfect) expect([rule(name).precision, rule(name).recall], name).toEqual([1, 1]);
    expect(rule("fee_adjusted")).toMatchObject({ labelled: 6, predicted: 6, tp: 6 });
    expect(rule("refund")).toMatchObject({ labelled: 5, predicted: 5, tp: 5 });
    expect(rule("duplicate")).toMatchObject({ labelled: 4, predicted: 5, tp: 4, precision: 0.8, recall: 1 });
    expect(rule("partial")).toMatchObject({ labelled: 8, predicted: 7, tp: 7, precision: 1, recall: 0.875 });
  });

  it("the one miss is the documented known limit: a second equal instalment with no memo is held for review", () => {
    expect(r.misses).toHaveLength(1);
    expect(r.misses[0]).toMatchObject({ scenario: "repeat_instalment", expected: expect.stringContaining("partial"), got: "duplicate " });
  });

  it("renders the report with the same numbers", () => {
    const md = renderBenchMarkdown(file, r);
    expect(md).toContain("**Overall: 70 / 71 correct (98.6%).**");
    expect(md).toContain("**100% auto-record precision**");
    expect(md).toContain("| `fee_adjusted` | 6 | 6 | 6 | 100% | 100% |");
    expect(md).toContain("| `duplicate` | 4 | 5 | 4 | 80% | 100% |");
    expect(readFileSync(new URL("../docs/RECONCILIATION-BENCHMARK.md", import.meta.url), "utf8").replace(/\r\n/g, "\n")).toBe(md.replace(/\r\n/g, "\n"));
  });
});
