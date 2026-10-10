#!/usr/bin/env python3
"""
Screenshots of Chaser running against the PayPal sandbox, for docs/sandbox-evidence/ and the video insert.

    python scripts/sandbox_shots.py [--url http://localhost:3000] [--out docs/sandbox-evidence]

Needs `pip install playwright` + `python -m playwright install chromium`. The dev server must be running in
sandbox mode (MOCK_PAYPAL=0 with credentials in .env.local). Captures: header + invoices grid, Payments tab
(match review + transactions), Disputes tab, Approvals tab, Audit tab. Nothing is clicked that writes to PayPal.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:3000")
    ap.add_argument("--out", default="docs/sandbox-evidence")
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
        page.screenshot(path=str(out / f"{stamp}-01-invoices-sandbox.png"))
        print("invoices")
        for label, name in [("Payments", "02-payments-match-review"), ("Disputes", "03-disputes"), ("Approvals", "04-approvals-ledger"), ("Audit", "05-audit")]:
            page.get_by_role("button", name=label).first.click()
            page.wait_for_timeout(1800)
            page.screenshot(path=str(out / f"{stamp}-{name}.png"))
            print(label.lower())
        browser.close()
    print(f"written to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
