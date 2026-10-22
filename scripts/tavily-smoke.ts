import { config } from "dotenv";
config({ path: ".env.local" });
async function main() {
  const { payerSignals } = await import("../src/lib/agent/signals");
  const r = await payerSignals({ business: "Acme Corp", email: "ap@acme.com" });
  console.log("source:", r.source, "risk:", r.risk, "evidence:", r.evidence.length, "query:", r.query);
  for (const e of r.evidence.slice(0, 3)) console.log(" -", e.published_date, e.title.slice(0, 80), e.url);
}
main().catch((e) => { console.error("failed:", e?.message ?? e); process.exit(1); });
