/**
 * One real agent turn against Nebius Token Factory (Nemotron) with the mock PayPal backend.
 * Usage: npx tsx scripts/nebius-smoke.ts   (reads .env.local; forces LLM_PROVIDER=nebius, MOCK_PAYPAL=1)
 * Prints the model id, the tools the model called, the reply and token usage. Never prints the key.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
process.env.LLM_PROVIDER = "nebius";
process.env.MOCK_PAYPAL = "1";
process.env.MOCK_LLM = "0";

async function main() {
  const { activeModelId } = await import("../src/lib/llm");
  const { runOnce } = await import("../src/lib/agent/run");
  console.log("model:", activeModelId());
  const t0 = Date.now();
  const r = await runOnce("Which invoices are overdue right now, and what is the next chase step for each? Keep it short.", { unattended: true });
  console.log("steps:", r.steps, "tools:", r.toolCalls.join(", ") || "(none)");
  console.log("reply:", r.text.slice(0, 600));
  console.log("ms:", Date.now() - t0);
}
main().catch((e) => { console.error("smoke failed:", e?.message ?? e); process.exit(1); });
