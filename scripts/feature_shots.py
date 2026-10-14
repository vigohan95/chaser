#!/usr/bin/env python3
"""
Screenshots of the differentiating features against a local build in demo mode, for docs/screenshots/ and Devpost.

    MOCK_PAYPAL=1 MOCK_LLM=1 npx next dev -p 3100     # in another shell
    python scripts/feature_shots.py --url http://localhost:3100

Captures: the invoice grid with predicted pay date / risk / next action, the promise-to-pay badge with the detail panel,
and the after-final hand-off pack (approval card -> approved -> pack on the invoice).
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:3100")
    ap.add_argument("--out", default="docs/screenshots")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 2200, "height": 1150}, device_scale_factor=1, color_scheme="light")
        page.goto(args.url, wait_until="networkidle")
        page.wait_for_selector("text=Demo data", timeout=60_000)
        page.wait_for_selector(".ag-row", timeout=60_000)
        page.wait_for_timeout(1500)

        # 1. Grid with predictions: sort already by overdue; hover a Next action cell so the "why" tooltip shows.
        cell = page.locator(".ag-row[row-index='0'] [col-id='nextStage']").first
        cell.hover()
        page.wait_for_timeout(900)
        page.screenshot(path=str(out / "01-grid-predicted-pay-date-risk-next-action.png"))
        print("grid")

        # 2. Promise to pay: select INV-0014 (broken promise) so the detail panel shows the promise and the escalation.
        row14 = page.locator(".ag-row", has_text="INV-0014").first
        row14.scroll_into_view_if_needed()
        row14.locator(".ag-selection-checkbox input, .ag-checkbox-input").first.check()
        page.wait_for_selector("[data-testid='invoice-detail']", timeout=10_000)
        page.wait_for_timeout(700)
        page.screenshot(path=str(out / "02-promise-to-pay-badge-and-detail.png"))
        print("promise")
        row14.locator(".ag-selection-checkbox input, .ag-checkbox-input").first.uncheck()

        # 3. After-final hand-off pack: select INV-0026, ask for the pack, approve the card, show the pack + download.
        row26 = page.locator(".ag-row", has_text="INV-0026").first
        row26.scroll_into_view_if_needed()
        row26.locator(".ag-selection-checkbox input, .ag-checkbox-input").first.check()
        page.wait_for_selector("[data-testid='invoice-detail']", timeout=10_000)
        page.get_by_role("button", name=re.compile(r"Build hand-off pack")).click()
        approve = page.get_by_role("button", name=re.compile(r"^Approve"))
        approve.first.wait_for(timeout=60_000)
        page.wait_for_timeout(600)
        page.screenshot(path=str(out / "03a-after-final-handoff-approval-card.png"))
        approve.first.click()
        page.get_by_role("button", name=re.compile(r"Download hand-off pack")).wait_for(timeout=90_000)
        page.wait_for_timeout(1200)
        page.screenshot(path=str(out / "03-after-final-handoff-pack.png"))
        print("handoff")
        browser.close()
    print(f"written to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
