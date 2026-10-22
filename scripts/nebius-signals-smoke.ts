import { config } from "dotenv";
config({ path: ".env.local" });
process.env.LLM_PROVIDER = "nebius";
process.env.MOCK_PAYPAL = "1";
process.env.MOCK_LLM = "0";
async function main() {
  const { runOnce } = await import("../src/lib/agent/run");
  const t0 = Date.now();
  const r = await runOnce(process.argv[2] ?? "Run the after-final review: which invoices are past their final notice, what does the policy propose for each, and what does the news say about those clients? Carry out what you can.", { unattended: true });
  console.log("tools:", r.toolCalls.join(", "));
  console.log("reply:", r.text.slice(0, 900));
  console.log("ms:", Date.now() - t0);
}
main().catch((e) => { console.error("failed:", e?.message ?? e); process.exit(1); });
