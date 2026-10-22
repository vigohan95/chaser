import { config } from "dotenv";
config({ path: ".env.local" });
process.env.LLM_PROVIDER = "nebius";
process.env.MOCK_PAYPAL = "1";
process.env.MOCK_LLM = "0";
async function main() {
  const { runOnce } = await import("../src/lib/agent/run");
  const t0 = Date.now();
  const r = await runOnce("Acme Corp's invoice INV-0001 is at the final-notice stage. Decide what to do next and explain.", { unattended: true });
  console.log("tools:", r.toolCalls.join(", "));
  console.log("reply:", r.text.slice(0, 900));
  console.log("ms:", Date.now() - t0);
}
main().catch((e) => { console.error("failed:", e?.message ?? e); process.exit(1); });
