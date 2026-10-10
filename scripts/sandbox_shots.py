#!/usr/bin/env python3
"""
Screenshots of Chaser running against the PayPal sandbox, for docs/sandbox-evidence/ and the video insert.

    python scripts/sandbox_shots.py [--url http://localhost:3000] [--out docs/sandbox-evidence]

Needs `pip install playwright` + `python -m playwright install chromium`. The dev server must be running in
sandbox mode (MOCK_PAYPAL=0 with credentials in .env.local). Captures the invoices grid, optionally a real
"Run collections" (--run-collections: sends sandbox reminders through send_invoice_reminder and dumps the audit
log as JSON), the approval ledger and the audit timeline. File names double as the captions of the video drop-in.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:3000")
    ap.add_argument("--out", default="docs/sandbox-evidence")
    ap.add_argument("--run-collections", action="store_true", help="click Run collections (sends real sandbox reminders) and dump the audit log")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%d")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=1)
        page.goto(args.url, wait_until="networkidle")
        page.wait_for_selector("text=PayPal sandbox", timeout=60_000)
        page.wait_for_timeout(2500)
        page.screenshot(path=str(out / "01-sandbox-invoices-listed-through-the-toolkit.png"))
        print("invoices")
        if args.run_collections:
            # The real agent path against the sandbox: propose_collections -> send_invoice_reminder per overdue invoice.
            page.locator("button", has_text="Run collections").first.click()
            page.wait_for_timeout(1500)
            page.wait_for_selector("text=/Collections run complete|Nothing to chase|Something went wrong/", timeout=180_000)
            page.wait_for_selector("text=working...", state="detached", timeout=60_000)  # the final data-snapshot part lands after the summary
            page.wait_for_timeout(2500)
            page.screenshot(path=str(out / "02-sandbox-reminders-sent-with-send-invoice-reminder.png"))
            print("collections")
            snap = page.evaluate("sessionStorage.getItem('chaser-snapshot-v1')")
            if snap:
                data = json.loads(snap)
                audit = [{k: e.get(k) for k in ("ts", "actor", "tool", "action", "decision", "reason", "rule", "input", "output")} for e in data.get("audit", [])]
                (out / f"{stamp}-collections-audit.json").write_text(json.dumps({"captured_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "mode": "sandbox", "audit": audit, "overlay": data.get("overlay")}, indent=2), encoding="utf-8")
                print(f"audit entries: {len(audit)}")
        for label, name in [("Approvals", "03-sandbox-approval-ledger-policy-decisions"), ("Audit", "04-sandbox-audit-timeline")]:
            page.locator("button", has_text=label).first.click()
            page.wait_for_timeout(1800)
            page.screenshot(path=str(out / f"{name}.png"))
            print(label.lower())
        browser.close()
    print(f"written to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
