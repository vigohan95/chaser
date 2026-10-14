/*
 * Score the matcher on the labelled fixture and write the report: `npm run bench:recon`
 * (regenerate the fixture first with `npm run bench:recon:gen` when scenarios change).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderBenchMarkdown, scoreBench, type BenchFile } from "../src/lib/agent/recon-bench";

const file = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/recon-bench.json"), "utf8")) as BenchFile;
const r = scoreBench(file);
const md = renderBenchMarkdown(file, r);
writeFileSync(resolve(process.cwd(), "docs/RECONCILIATION-BENCHMARK.md"), md);
const pct = (x: number | null) => (x === null ? "-" : `${(x * 100).toFixed(1)}%`);
console.log(`overall ${r.correct}/${r.transactions} (${pct(r.accuracy)}); auto-record precision ${r.auto_record_correct}/${r.auto_record_predicted} (${pct(r.auto_record_precision)})`);
console.log("rule".padEnd(18) + "lab  pred  tp   prec     rec");
for (const s of r.per_rule) console.log(s.rule.padEnd(18) + String(s.labelled).padEnd(5) + String(s.predicted).padEnd(6) + String(s.tp).padEnd(5) + pct(s.precision).padEnd(9) + pct(s.recall));
for (const m of r.misses) console.log(`MISS ${m.transaction_id} ${m.scenario}: expected ${m.expected} | got ${m.got}`);
console.log("wrote docs/RECONCILIATION-BENCHMARK.md");
