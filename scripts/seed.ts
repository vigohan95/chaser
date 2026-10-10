/* Seed the PayPal sandbox with demo invoices: `npm run seed` (reads .env.local). */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(file: string) {
  try {
    for (const line of readFileSync(resolve(process.cwd(), file), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no file */
  }
}

async function main() {
  loadEnv(".env.local");
  loadEnv(".env");
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    console.error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing. Put your sandbox app credentials in .env.local (see .env.example).");
    process.exit(1);
  }
  process.env.MOCK_PAYPAL = "0";
  const { seedSandbox } = await import("../src/lib/paypal/seed");
  const report = await seedSandbox({ log: (m) => console.log(m), send: process.argv.includes("--no-send") ? false : true, limit: Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 12) });
  console.log(`\nDone: ${report.created.length} created, ${report.failed.length} failed.`);
  if (report.failed.length) process.exitCode = 1;
}

main();
