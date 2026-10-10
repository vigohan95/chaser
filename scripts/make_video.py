#!/usr/bin/env python3
"""
Produce the Devpost demo video for Chaser without a camera, a microphone or paid tools.

Pipeline (all free / open source):
  1. narrate   edge-tts renders one MP3 per shot from the voice-over in SHOTS (Microsoft neural voice, no key).
  2. record    Playwright (Chromium, 1920x1080, headless) drives the real UI on the live site and captures
               frames through the CDP screencast with wall-clock timestamps; a fake cursor and a caption strip
               are injected into the page so the viewer can follow along.
  3. assemble  ffmpeg turns the frames into H.264 segments (one per shot), adds a 3 s title card and a 3 s end
               card, muxes the narration (padded to each shot) as AAC, and writes the SRT + a 1280x720 thumbnail.
  4. verify    ffprobe duration <= 178 s, audio stream present, sampled frames are not black.

Requirements: Python 3.11+, `pip install playwright edge-tts` + `python -m playwright install chromium`, and
ffmpeg/ffprobe on PATH (or in <repo>/tools/ffmpeg/**, or FFMPEG=/path/to/ffmpeg). On Windows run with
PYTHONUTF8=1. A static Windows ffmpeg build is free at https://www.gyan.dev/ffmpeg/builds/ (unzip into
tools/ffmpeg/, which is git-ignored).

Usage:
  python scripts/make_video.py                      # everything, against https://chaser-six.vercel.app
  python scripts/make_video.py --url http://localhost:3000
  python scripts/make_video.py --step assemble      # re-cut from the frames/narration already on disk
  python scripts/make_video.py --voice en-US-AvaNeural --rate -5%
  python scripts/make_video.py --url http://localhost:3100 --no-sandbox-segment   # before docs/sandbox-evidence/ exists
  python scripts/make_video.py --step assemble                                    # later: re-cut with the sandbox drop-in from the same recording

Outputs (video/, git-ignored): chaser-demo.mp4, chaser-demo.srt, chaser-demo-thumb.png, shots.json, stills/.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
LIVE_URL = "https://chaser-six.vercel.app"
REPO_URL = "https://github.com/vigohan95/chaser"
FPS = 30
HARD_CAP = 178.0  # seconds (Devpost: under 3:00; we keep 2 s of margin)
CARD_SECONDS = 3.0
NARRATION_LEAD = 0.35  # narration starts this long after the shot's first frame
SHOT_TAIL = 0.6  # every shot runs at least narration + this

# ----------------------------------------------------------------------------------------------------------
# Shot list: title shown in the caption strip + voice-over (SUBMIT.md section B, numbers verified on the UI).
# ----------------------------------------------------------------------------------------------------------
#   (key, caption title, voice-over). Order and narration follow SUBMIT.md section B (2026-10-10): reconciliation
#   and disputes lead. The "sandbox" shot is a DROP-IN that is never recorded in the browser: at assembly it is
#   built from the screenshots in docs/sandbox-evidence/ (scripts/sandbox_shots.py, once the sandbox credentials
#   exist). Until then run with --no-sandbox-segment; afterwards `--step assemble` re-cuts with it, no re-recording.
ALL_SHOTS: list[tuple[str, str, str]] = [
    ("match", "Match review", "Money arrived on PayPal. Which invoice is it? Chaser is an AI agent that answers that, on PayPal, inside rules you write down. Everything here is sandbox money."),
    ("edit", "Edit the split, record", "One payment, two invoices: the agent proposes the split and explains it. This is an AG Grid, so I can change any allocation before it touches PayPal. If my edit over-allocates, the grid stops me. If it exceeds what an invoice is owed, the policy stops the agent: it comes back as a card citing the rule."),
    ("ledger", "Approval ledger", "Approve, and it finishes. Every decision lands in the approval ledger with the policy field it was made on. The policy is data: change a number, and the next decision changes with it."),
    ("policy", "Policy as data", "Here is that policy. Accept disputes under twenty dollars. Show me evidence packs before they go. Ask before any refund over five hundred."),
    ("disputes", "Disputes: evidence pack to PayPal", "Disputes. The fifteen-dollar one is under my limit: accepted. The four-hundred-eighty-dollar one gets an evidence pack built from what Chaser already knows: the invoice line items, the payment record, the reminder history. I read the statement, approve, and it goes to PayPal through the Disputes API. Not a draft to paste somewhere: submitted."),
    ("sandbox", "PayPal sandbox", "The same code runs against the real PayPal sandbox through the PayPal Agent Toolkit: these invoices, reminders and transactions exist on PayPal."),
    ("collections", "Run collections", "Collections, inside the cadence: friendly at three days, firm at ten, final at twenty-one, never more than four. Each reminder quotes the actual work and the pay link."),
    ("invoice", "Create and send an invoice", "And the ordinary things: tell it what you did and it creates and sends the PayPal invoice."),
    ("deny", "Approval card: deny", "Outside the policy, it asks. I deny this one, and that is on the record too."),
    ("closing", "One agent, your rules", "Reconciliation you can edit, policy as data, disputes handled end to end. Built on the PayPal sandbox with the PayPal Agent Toolkit, the Vercel AI SDK and AG Grid."),
]
SANDBOX_KEY = "sandbox"
SANDBOX_EVIDENCE = REPO / "docs" / "sandbox-evidence"

# Active shot list (title, voice-over) and the keys in play; set by select_shots() from the command line.
SHOTS: list[tuple[str, str]] = []
SHOT_KEYS: list[str] = []


def select_shots(include_sandbox: bool) -> None:
    global SHOTS, SHOT_KEYS
    chosen = [s for s in ALL_SHOTS if include_sandbox or s[0] != SANDBOX_KEY]
    SHOT_KEYS = [s[0] for s in chosen]
    SHOTS = [(s[1], s[2]) for s in chosen]


def sandbox_pngs() -> list[Path]:
    return sorted(p for p in SANDBOX_EVIDENCE.glob("*.png") if p.stat().st_size > 0)


select_shots(True)

# ----------------------------------------------------------------------------------------------------------
# ffmpeg discovery
# ----------------------------------------------------------------------------------------------------------


def find_tool(name: str) -> str:
    env = os.environ.get(name.upper())
    if env and Path(env).exists():
        return env
    on_path = shutil.which(name)
    if on_path:
        return on_path
    for root in (REPO / "tools" / "ffmpeg", REPO.parents[2] / "tools" / "ffmpeg" if len(REPO.parents) > 2 else None):
        if root and root.exists():
            for p in root.rglob(f"{name}.exe" if os.name == "nt" else name):
                return str(p)
    sys.exit(f"{name} not found. Put a static build in tools/ffmpeg/ (https://www.gyan.dev/ffmpeg/builds/) or set {name.upper()}=path")


FFMPEG = find_tool("ffmpeg")
FFPROBE = find_tool("ffprobe")


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)
    if r.returncode != 0:
        print(r.stdout[-3000:], r.stderr[-3000:], file=sys.stderr)
        raise SystemExit(f"command failed ({r.returncode}): {' '.join(cmd[:4])} ...")
    return r


def media_duration(path: Path) -> float:
    out = run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)]).stdout.strip()
    return float(out)


# ----------------------------------------------------------------------------------------------------------
# 1. Narration
# ----------------------------------------------------------------------------------------------------------


def vo_path(work: Path, shot_key: str) -> Path:
    return work / "vo" / f"vo-{shot_key}.mp3"


def narrate(work: Path, voice: str, rate: str) -> list[float]:
    import edge_tts  # type: ignore

    vo_dir = work / "vo"
    vo_dir.mkdir(parents=True, exist_ok=True)

    async def render() -> None:
        for shot_key, (_, text) in zip(SHOT_KEYS, SHOTS):
            out, stamp = vo_path(work, shot_key), vo_path(work, shot_key).with_suffix(".txt")
            key = f"{voice}|{rate}|{text}"
            if out.exists() and out.stat().st_size > 0 and stamp.exists() and stamp.read_text(encoding="utf-8") == key:
                continue  # cached from a previous run with the same voice, rate and text
            await edge_tts.Communicate(text, voice, rate=rate).save(str(out))
            stamp.write_text(key, encoding="utf-8")

    asyncio.run(render())
    durations = [media_duration(vo_path(work, k)) for k in SHOT_KEYS]
    for i, d in enumerate(durations, 1):
        print(f"  narration {i}: {d:5.2f}s  {SHOTS[i-1][0]}")
    print(f"  narration total: {sum(durations):.1f}s")
    return durations


# ----------------------------------------------------------------------------------------------------------
# 2. Recording (Playwright + CDP screencast)
# ----------------------------------------------------------------------------------------------------------

OVERLAY_JS = r"""
(caption) => {
  if (!document.getElementById('demo-style')) {
    const s = document.createElement('style'); s.id = 'demo-style';
    s.textContent = `
      .h-screen { height: calc(100vh - 44px) !important; }
      #demo-cap { position: fixed; left: 0; right: 0; bottom: 0; height: 44px; background: #0f172a; color: #fff;
        font: 500 15px/1 ui-sans-serif, system-ui, "Segoe UI", sans-serif; display: flex; align-items: center;
        padding: 0 20px; gap: 14px; z-index: 2147483646; letter-spacing: .01em; }
      #demo-cap .b { font-weight: 700; } #demo-cap .m { opacity: .55; } #demo-cap .r { margin-left: auto; opacity: .7; font-size: 13px; }
      #demo-cur { position: fixed; left: 0; top: 0; width: 24px; height: 24px; z-index: 2147483647; pointer-events: none;
        transform: translate(-100px,-100px); transition: transform 16ms linear; filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.5)); }
      .demo-ripple { position: fixed; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%;
        border: 3px solid #2563eb; opacity: .9; pointer-events: none; z-index: 2147483645; animation: demo-rip .5s ease-out forwards; }
      @keyframes demo-rip { from { transform: scale(.3); opacity: .9 } to { transform: scale(1.4); opacity: 0 } }
    `;
    document.head.appendChild(s);
    const cap = document.createElement('div'); cap.id = 'demo-cap';
    cap.innerHTML = '<span class="m">Chaser demo</span><span class="b" id="demo-cap-text"></span><span class="r">chaser-six.vercel.app  ·  PayPal sandbox, play money only</span>';
    document.body.appendChild(cap);
    const cur = document.createElement('div'); cur.id = 'demo-cur';
    cur.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M3 2 L3 20 L8 15.5 L11.5 22.5 L14.5 21 L11 14.5 L17.5 14.5 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cur);
    document.addEventListener('mousemove', e => { cur.style.transform = `translate(${e.clientX - 2}px, ${e.clientY - 1}px)`; }, true);
    document.addEventListener('mousedown', e => { const r = document.createElement('div'); r.className = 'demo-ripple';
      r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; document.body.appendChild(r); setTimeout(() => r.remove(), 600); }, true);
  }
  document.getElementById('demo-cap-text').textContent = caption;
}
"""



@dataclass
class Recorder:
    page: object
    cdp: object
    frames_dir: Path
    frames: list[tuple[float, str]] = field(default_factory=list)
    shots: list[dict] = field(default_factory=list)
    pos: tuple[float, float] = (960.0, 540.0)
    _n: int = 0

    # -- screencast ---------------------------------------------------------------------------------------
    def start(self) -> None:
        self.cdp.on("Page.screencastFrame", self._on_frame)
        self.cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 92, "maxWidth": 1920, "maxHeight": 1080, "everyNthFrame": 1})

    def _on_frame(self, ev: dict) -> None:
        self._n += 1
        path = self.frames_dir / f"f{self._n:06d}.jpg"
        path.write_bytes(base64.b64decode(ev["data"]))
        self.frames.append((float(ev["metadata"]["timestamp"]), path.name))
        self.cdp.send("Page.screencastFrameAck", {"sessionId": ev["sessionId"]})

    def stop(self) -> None:
        try:
            self.cdp.send("Page.stopScreencast")
        except Exception:
            pass

    # -- pacing (always through Playwright so screencast events keep flowing) -------------------------------
    def pause(self, seconds: float) -> None:
        self.page.wait_for_timeout(int(seconds * 1000))

    def caption(self, text: str) -> None:
        self.page.evaluate(OVERLAY_JS, text)

    def begin(self, key: str) -> None:
        index = SHOT_KEYS.index(key) + 1
        self.caption(SHOTS[index - 1][0])
        self.pause(0.25)
        self.shots.append({"key": key, "index": index, "title": SHOTS[index - 1][0], "start": time.time()})

    def end(self, min_len: float) -> None:
        shot = self.shots[-1]
        remaining = min_len - (time.time() - shot["start"])
        if remaining > 0:
            self.pause(remaining)
        shot["end"] = time.time()
        shot["seconds"] = round(shot["end"] - shot["start"], 2)
        print(f"  shot {shot['key']}: {shot['seconds']:.1f}s  {shot['title']}")

    # -- mouse ----------------------------------------------------------------------------------------------
    def move(self, x: float, y: float, dur: float | None = None) -> None:
        """Ease the cursor to (x, y) over `dur` wall-clock seconds (each step is a browser round-trip, so pace by the clock)."""
        x0, y0 = self.pos
        dist = math.hypot(x - x0, y - y0)
        if dist < 1:
            return
        dur = dur if dur is not None else min(1.0, 0.3 + dist / 1800)
        t0 = time.time()
        while True:
            t = min(1.0, (time.time() - t0) / dur)
            e = t * t * (3 - 2 * t)  # smoothstep
            self.page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e)
            if t >= 1.0:
                break
            self.pause(0.012)
        self.pos = (x, y)

    def center(self, locator, dx: float = 0, dy: float = 0) -> tuple[float, float]:
        box = locator.bounding_box(timeout=8000)
        if not box:
            raise RuntimeError("element has no box")
        return box["x"] + box["width"] / 2 + dx, box["y"] + box["height"] / 2 + dy

    def hover(self, locator, dx: float = 0, dy: float = 0, dur: float | None = None) -> None:
        x, y = self.center(locator, dx, dy)
        self.move(x, y, dur)

    def click(self, locator, dx: float = 0, dy: float = 0, settle: float = 0.25) -> None:
        self.hover(locator, dx, dy)
        self.pause(0.12)
        self.page.mouse.down()
        self.pause(0.08)
        self.page.mouse.up()
        self.pause(settle)

    def type_text(self, locator, text: str, cps: float = 30) -> None:
        self.click(locator)
        self.page.keyboard.type(text, delay=int(1000 / cps))

    def edit_cell(self, cell, text: str, cps: float = 9) -> None:
        """Single-click an editable AG Grid cell, replace its value, commit with Enter."""
        self.click(cell, settle=0.4)
        self.page.keyboard.press("Control+A")
        self.page.keyboard.type(text, delay=int(1000 / cps))
        self.pause(0.35)
        self.page.keyboard.press("Enter")
        self.pause(0.45)

    # -- app helpers ----------------------------------------------------------------------------------------
    def wait_agent_done(self, timeout: float = 120) -> None:
        stop = self.page.locator("aside button:has-text('Stop')")
        try:
            stop.wait_for(state="visible", timeout=3_000)  # a resumed run (after Approve / Deny) can finish before Stop shows
        except Exception:
            pass
        stop.wait_for(state="detached", timeout=int(timeout * 1000))

    def still(self, out_dir: Path, name: str) -> None:
        out_dir.mkdir(parents=True, exist_ok=True)
        self.page.screenshot(path=str(out_dir / f"{name}.png"))


def smooth_scroll(page, selector: str, left: float | None = None, top: float | None = None) -> None:
    page.evaluate(
        "([sel, left, top]) => { const el = document.querySelector(sel); if (!el) return; el.scrollTo({ left: left ?? el.scrollLeft, top: top ?? el.scrollTop, behavior: 'smooth' }); }",
        [selector, left, top],
    )


def record(work: Path, out: Path, url: str, narration: list[float], headed: bool) -> list[dict]:
    from playwright.sync_api import sync_playwright  # type: ignore

    frames_dir = work / "frames"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True)
    stills = out / "stills"
    need = [d + NARRATION_LEAD + SHOT_TAIL for d in narration]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not headed)
        ctx = browser.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=1, color_scheme="light", locale="en-US", timezone_id="America/Los_Angeles")
        page = ctx.new_page()
        page.goto(url, wait_until="networkidle", timeout=90_000)
        page.wait_for_selector(".ag-row[row-id]", timeout=60_000)
        page.wait_for_timeout(1200)
        page.mouse.move(960, 540)
        rec = Recorder(page=page, cdp=ctx.new_cdp_session(page), frames_dir=frames_dir)
        rec.caption("")
        rec.start()
        rec.pause(0.8)
        if not rec.frames:
            raise SystemExit("screencast produced no frames")

        agent_input = page.locator("aside form input")
        send_btn = page.locator("aside form button[type=submit]")
        tab = lambda name: page.locator(f"main nav button:has-text('{name}')")  # noqa: E731
        header_btn = lambda name: page.locator(f"header button:has-text('{name}')")  # noqa: E731
        action_btn = lambda name: page.locator(f"main button:has-text('{name}')").first  # noqa: E731
        approve_btn = page.locator("aside button:has-text('Approve')")
        deny_btn = page.locator("aside button:has-text('Deny')")
        card = page.locator("aside .border-amber-400").first
        match_grid = page.locator("main .ag-root-wrapper").first  # the match review is the first grid on the Payments tab
        mr_row = lambda inv: match_grid.locator(".ag-row[row-id]").filter(has=page.locator(f".ag-cell[col-id='invoice_number']:has-text('{inv}')")).first  # noqa: E731
        mr_cell = lambda inv, col: mr_row(inv).locator(f".ag-cell[col-id='{col}']").first  # noqa: E731
        need_for = lambda key: need[SHOT_KEYS.index(key)]  # noqa: E731

        def wait_card() -> None:
            approve_btn.wait_for(timeout=60_000)
            rec.pause(0.5)

        # ---- match: Payments tab, the match review already populated ----------------------------------------
        rec.begin("match")
        rec.hover(page.locator("main .grid > div").last)  # KPI: unmatched payments
        rec.pause(0.9)
        rec.click(tab("Payments"), settle=0.9)
        mr_row("INV-0016").wait_for(timeout=20_000)
        rec.pause(0.5)
        rec.still(stills, "01-match-review")
        for inv in ("INV-0013", "INV-0014", "INV-0015", "INV-0016"):  # exact 95%, partial 70%, split 90% x2
            rec.hover(mr_cell(inv, "kind"), dur=0.45)
            rec.pause(0.55)
        rec.hover(mr_cell("INV-0015", "amount"), dur=0.5)
        rec.end(need_for("match"))

        # ---- edit: change the split, trip the guard, fix it, record, approval card --------------------------
        rec.begin("edit")
        rec.hover(mr_cell("INV-0015", "reasoning"), dx=-120)  # tooltip with the agent's reasoning
        rec.pause(1.6)
        rec.edit_cell(mr_cell("INV-0015", "amount"), "1000")  # $900 -> $1,000: the $1,400 payment is now over-allocated
        rec.pause(0.5)
        rec.hover(mr_cell("INV-0016", "amount"), dur=0.4)
        rec.pause(0.3)
        rec.still(stills, "02-over-allocation-guard")
        rec.hover(action_btn("Record"), dur=0.6)  # disabled while a payment is over-allocated
        rec.pause(1.1)
        rec.edit_cell(mr_cell("INV-0016", "amount"), "400")  # $500 -> $400: back within the payment
        rec.pause(0.6)
        rec.still(stills, "03-split-edited")
        rec.click(action_btn("Record"), settle=0.3)
        wait_card()  # $1,000 on a $900 balance: reconciliation.amountTolerance asks
        rec.hover(card.locator("p").first, dy=-4)
        rec.pause(0.6)
        rec.still(stills, "04-approval-card-reconciliation")
        rec.pause(1.4)
        rec.end(need_for("edit"))

        # ---- ledger: approve, then the approval ledger with the policy fields -------------------------------
        rec.begin("ledger")
        rec.click(approve_btn, settle=0.4)
        rec.wait_agent_done()
        rec.pause(0.9)
        rec.click(tab("Approvals"), settle=0.9)
        rule_cells = page.locator("main .ag-row[row-id] .ag-cell[col-id='rule']")
        rule_cells.first.wait_for(timeout=15_000)
        for i in range(min(5, rule_cells.count())):
            rec.hover(rule_cells.nth(i), dur=0.4)
            rec.pause(0.45)
        rec.still(stills, "05-approval-ledger")
        rec.pause(0.8)
        rec.end(need_for("ledger"))

        # ---- policy: the panel -----------------------------------------------------------------------------
        rec.begin("policy")
        rec.click(header_btn("Policy"), settle=0.6)
        for sel in ("aside label:has-text('Auto-accept disputes under') input", "aside label:has-text('Dispute evidence packs') select", "aside label:has-text('Ask me for refunds over') input"):
            rec.hover(page.locator(sel), dur=0.5)
            rec.pause(1.2)
        rec.still(stills, "06-policy-panel")
        rec.pause(0.4)
        rec.click(header_btn("Policy"), settle=0.3)
        rec.end(need_for("policy"))

        # ---- disputes: accept the small one, evidence pack for the big one, approve, submitted ---------------
        rec.begin("disputes")
        rec.click(action_btn("Review disputes"))
        wait_card()
        chips = page.locator("aside .mr-2").last.locator(".chip")
        for n in range(min(3, chips.count())):  # List disputes, Accept dispute, Build evidence pack
            rec.hover(chips.nth(n), dur=0.4)
            rec.pause(0.55)
        rec.hover(card.locator(".bg-panel").first, dy=20)
        rec.pause(0.6)
        rec.still(stills, "07-evidence-pack-card")
        rec.pause(3.2)
        rec.click(approve_btn, settle=0.4)
        rec.wait_agent_done()
        rec.pause(0.8)
        rec.click(tab("Disputes"), settle=0.9)
        rec.click(page.locator("main .ag-row[row-id='PP-D-MOCK-00480'] .ag-cell").nth(3), settle=0.7)
        rec.hover(page.locator("main .bg-panel .font-semibold").first, dy=4)
        rec.pause(0.5)
        rec.still(stills, "08-dispute-submitted")
        rec.hover(page.locator("main .ag-row[row-id='PP-D-MOCK-00480'] .ag-cell[col-id='status']").first, dur=0.6)
        rec.pause(1.2)
        rec.end(need_for("disputes"))

        # ---- collections -----------------------------------------------------------------------------------
        rec.begin("collections")
        rec.click(tab("Invoices"), settle=0.6)
        rec.click(action_btn("Run collections"))
        rec.wait_agent_done()
        rec.pause(0.8)
        chip = page.locator("aside .chip:has-text('Send reminder')").first
        chip.evaluate("el => el.scrollIntoView({ behavior: 'smooth', block: 'center' })")
        rec.pause(0.9)
        rec.click(chip, settle=0.5)
        rec.hover(page.locator("aside pre").first, dy=-20)
        rec.pause(2.6)
        rec.still(stills, "10-reminder-detail")
        rec.hover(page.locator(".ag-header-cell[col-id='reminders'], .ag-header-cell:has-text('Reminders')").first)
        rec.pause(1.0)
        rec.end(need_for("collections"))

        # ---- invoice: create + send from natural language ---------------------------------------------------
        rec.begin("invoice")
        rec.type_text(agent_input, "I finished the logo package for Acme Corp, $1,200, net 15")
        rec.pause(0.3)
        rec.click(send_btn)
        rec.wait_agent_done()
        rec.pause(0.6)
        for n in range(3):  # Look up client, Create invoice, Send invoice
            rec.hover(page.locator("aside .mr-2").last.locator(".chip").nth(n), dur=0.35)
            rec.pause(0.4)
        new_row = page.locator(".ag-row[row-id]:has-text('INV-0021')").first
        if new_row.count():
            rec.hover(new_row.locator(".ag-cell").nth(1), dur=0.6)
        rec.still(stills, "11-invoice-created")
        rec.pause(0.9)
        rec.end(need_for("invoice"))

        # ---- deny: refund over the threshold -> approval card -> Deny -> ledger row --------------------------
        rec.begin("deny")
        rec.type_text(agent_input, "Refund $600 on INV-0007")
        rec.pause(0.2)
        rec.click(send_btn)
        wait_card()
        rec.hover(card.locator("p").first, dy=-4)
        rec.still(stills, "12-refund-approval-card")
        rec.pause(1.6)
        rec.click(deny_btn, settle=0.4)
        rec.wait_agent_done()
        rec.pause(0.7)
        rec.click(tab("Approvals"), settle=0.9)
        rec.hover(page.locator("main .ag-row[row-id] .ag-cell[col-id='decision']").first, dur=0.5)
        rec.still(stills, "13-ledger-denied")
        rec.pause(1.0)
        rec.end(need_for("deny"))

        # ---- closing slide -----------------------------------------------------------------------------------
        slide = work / "slide.html"
        slide.write_text(closing_slide_html(SHOTS[-1][0]), encoding="utf-8")
        rec.begin("closing")
        page.goto(slide.as_uri(), wait_until="load")
        rec.pause(1.0)
        rec.end(need_for("closing"))
        rec.pause(0.3)

        rec.stop()
        shots = rec.shots
        frames = rec.frames
        browser.close()

    expected = [k for k in SHOT_KEYS if k != SANDBOX_KEY]
    if [s["key"] for s in shots] != expected:
        raise SystemExit(f"Recorded shots {[s['key'] for s in shots]} but the shot list is {expected}: the click sequence in record() must match the shot list / narration (see SUBMIT.md section B).")

    (work / "frames.json").write_text(json.dumps(frames), encoding="utf-8")
    (work / "shots.json").write_text(json.dumps(shots, indent=1), encoding="utf-8")
    print(f"  captured {len(frames)} frames")
    return shots


# ----------------------------------------------------------------------------------------------------------
# HTML for the title card, end card, closing slide and thumbnail
# ----------------------------------------------------------------------------------------------------------

BASE_CSS = """
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1920px; height: 1080px; overflow: hidden; background: #0b1220; color: #fff;
    font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .bg { position: absolute; inset: 0; background:
    radial-gradient(900px 600px at 15% 20%, rgba(37,99,235,.35), transparent 60%),
    radial-gradient(700px 500px at 85% 85%, rgba(16,185,129,.22), transparent 60%), #0b1220; }
  .mark { display: inline-grid; place-items: center; width: 72px; height: 72px; border-radius: 18px; background: #2563eb;
    font-weight: 800; font-size: 40px; }
  .muted { color: rgba(255,255,255,.7); }
  .cap { position: fixed; left: 0; right: 0; bottom: 0; height: 44px; background: #0f172a; color: #fff; font: 500 15px/1 ui-sans-serif, system-ui, "Segoe UI", sans-serif;
    display: flex; align-items: center; padding: 0 20px; gap: 14px; letter-spacing: .01em; }
  .cap .b { font-weight: 700 } .cap .m { opacity: .55 } .cap .r { margin-left: auto; opacity: .7; font-size: 13px }
"""


def title_card_html() -> str:
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{BASE_CSS}
  .wrap {{ position: absolute; inset: 0; display: grid; place-items: center; text-align: center; }}
  h1 {{ font-size: 120px; letter-spacing: -.02em; margin-top: 26px; }}
  p.tag {{ font-size: 40px; margin-top: 18px; color: rgba(255,255,255,.85); }}
  p.ev {{ font-size: 28px; margin-top: 56px; letter-spacing: .12em; text-transform: uppercase; color: rgba(255,255,255,.6); }}
  </style></head><body><div class="bg"></div><div class="wrap"><div>
  <div class="mark">C</div><h1>Chaser</h1>
  <p class="tag">Matches every PayPal payment to the right invoice, and handles what follows.</p>
  <p class="ev">PayPal AI Hackathon 2026</p></div></div></body></html>"""


def end_card_html() -> str:
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{BASE_CSS}
  .wrap {{ position: absolute; inset: 0; display: grid; place-items: center; text-align: center; }}
  h1 {{ font-size: 72px; letter-spacing: -.02em; margin-top: 22px; }}
  .url {{ font-size: 44px; margin-top: 40px; font-family: ui-monospace, Consolas, monospace; color: #93c5fd; }}
  .url small {{ display: block; font-size: 22px; color: rgba(255,255,255,.55); margin-bottom: 8px; font-family: ui-sans-serif, system-ui, sans-serif; letter-spacing: .1em; text-transform: uppercase; }}
  p.ft {{ font-size: 26px; margin-top: 64px; color: rgba(255,255,255,.6); }}
  </style></head><body><div class="bg"></div><div class="wrap"><div>
  <div class="mark">C</div><h1>Chaser</h1>
  <div class="url"><small>Live demo (no sign-in, sandbox money)</small>{LIVE_URL.replace('https://', '')}</div>
  <div class="url"><small>Source</small>{REPO_URL.replace('https://', '')}</div>
  <p class="ft">PayPal Agent Toolkit · PayPal Webhooks · Vercel AI SDK 7 · AG Grid Community · Next.js 16</p></div></div></body></html>"""


def closing_slide_html(caption: str) -> str:
    caps = [
        ("Invoicing v2", "create, send, remind, record payment / refund, QR, search"),
        ("Transaction Search", "payment stream for reconciliation"),
        ("Payments v2", "refunds, gated by amount"),
        ("Disputes v1", "list, get, accept under your limit; evidence packs"),
        ("Shipment Tracking", "“shipped the brand book, UPS 1Z…”"),
        ("Catalog + Subscriptions", "monthly retainers as PayPal subscriptions"),
        ("Webhooks", "signature-verified: paid, captured, disputes, subscriptions"),
    ]
    tiles = "".join(f'<li style="animation-delay:{0.25 + i * 0.22:.2f}s"><b>{t}</b><span>{d}</span></li>' for i, (t, d) in enumerate(caps))
    flow = [
        ("Command center", "AG Grid · approval cards · audit timeline · policy panel"),
        ("Agent loop", "Vercel AI SDK 7 streamText + toolApproval · keyless planner or Gemini / Groq"),
        ("Policy engine", "allow · ask · deny - every tool call, every time"),
        ("PayPal Agent Toolkit", "official zod schemas, re-wrapped with the policy gate"),
        ("PayPal sandbox", "REST APIs + webhooks (play money only)"),
    ]
    boxes = "".join(f'<div class="box" style="animation-delay:{0.6 + i * 0.3:.2f}s"><b>{t}</b><span>{d}</span></div>{"<div class=arr style=animation-delay:%.2fs>↓</div>" % (0.75 + i * 0.3) if i < len(flow) - 1 else ""}' for i, (t, d) in enumerate(flow))
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{BASE_CSS}
  .page {{ position: absolute; inset: 0 0 44px 0; padding: 70px 90px; display: grid; grid-template-columns: 1.05fr .95fr; gap: 70px; }}
  h1 {{ font-size: 64px; letter-spacing: -.02em; }} h1 small {{ display: block; font-size: 26px; color: rgba(255,255,255,.6); font-weight: 500; margin-top: 10px; letter-spacing: 0; }}
  ul {{ list-style: none; margin-top: 40px; display: grid; gap: 14px; }}
  li, .box {{ background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); border-radius: 14px; padding: 16px 20px; opacity: 0; animation: in .5s ease-out forwards; }}
  li b, .box b {{ display: block; font-size: 24px; }} li span, .box span {{ display: block; font-size: 18px; color: rgba(255,255,255,.65); margin-top: 4px; }}
  .right {{ display: flex; flex-direction: column; justify-content: center; }}
  .arr {{ text-align: center; font-size: 26px; color: rgba(255,255,255,.4); line-height: 1.1; opacity: 0; animation: in .4s ease-out forwards; }}
  .box {{ border-color: rgba(96,165,250,.45); }}
  @keyframes in {{ from {{ opacity: 0; transform: translateY(10px) }} to {{ opacity: 1; transform: none }} }}
  </style></head><body><div class="bg"></div><div class="page">
  <div><h1>One agent, your rules<small>Reconciliation you can edit · policy as data · disputes end to end. Eight PayPal toolkit areas plus webhooks.</small></h1><ul>{tiles}</ul></div>
  <div class="right">{boxes}</div></div>
  <div class="cap"><span class="m">Chaser demo</span><span class="b">{caption}</span><span class="r">chaser-six.vercel.app  ·  PayPal sandbox, play money only</span></div>
  </body></html>"""


def sandbox_slide_html(png: Path, n: int, total: int, caption: str) -> str:
    data = base64.b64encode(png.read_bytes()).decode()
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{BASE_CSS}
  .page {{ position: absolute; inset: 0 0 44px 0; display: grid; grid-template-rows: auto 1fr; padding: 26px 48px 22px; gap: 14px; }}
  h2 {{ font-size: 30px; font-weight: 600; text-align: center; letter-spacing: .01em; }} h2 b {{ color: #93c5fd; font-family: ui-monospace, Consolas, monospace; font-weight: 600; }}
  h2 small {{ display: block; font-size: 18px; font-weight: 500; color: rgba(255,255,255,.6); margin-top: 6px; }}
  .shot {{ justify-self: center; align-self: center; max-width: 100%; max-height: 100%; border-radius: 12px; box-shadow: 0 24px 70px rgba(0,0,0,.6); border: 1px solid rgba(255,255,255,.12); }}
  </style></head><body><div class="bg"></div><div class="page">
  <h2>Same code, real PayPal sandbox: <b>MOCK_PAYPAL=0</b> and the PayPal Agent Toolkit<small>{png.stem.replace('-', ' ')}  ·  {n} / {total}  ·  docs/sandbox-evidence/</small></h2>
  <img class="shot" src="data:image/png;base64,{data}"></div>
  <div class="cap"><span class="m">Chaser demo</span><span class="b">{caption}</span><span class="r">chaser-six.vercel.app  ·  PayPal sandbox, play money only</span></div>
  </body></html>"""


def thumbnail_html(bg_png: Path) -> str:
    data = base64.b64encode(bg_png.read_bytes()).decode()
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
  * {{ box-sizing: border-box; margin: 0 }} html, body {{ width: 1280px; height: 720px; overflow: hidden; font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; color: #fff; }}
  .shot {{ position: absolute; inset: 0; background: url(data:image/png;base64,{data}) center/cover; }}
  .shade {{ position: absolute; inset: 0; background: linear-gradient(90deg, rgba(11,18,32,.96) 0%, rgba(11,18,32,.85) 42%, rgba(11,18,32,.15) 70%, rgba(11,18,32,0) 100%); }}
  .txt {{ position: absolute; left: 64px; top: 150px; width: 560px; }}
  .mark {{ display: inline-grid; place-items: center; width: 64px; height: 64px; border-radius: 16px; background: #2563eb; font-weight: 800; font-size: 36px; }}
  h1 {{ font-size: 92px; letter-spacing: -.03em; margin-top: 16px; line-height: 1; }}
  p {{ font-size: 30px; margin-top: 18px; line-height: 1.25; color: rgba(255,255,255,.9); }}
  .pill {{ display: inline-block; margin-top: 28px; padding: 10px 16px; border-radius: 999px; background: rgba(255,255,255,.12); font-size: 20px; letter-spacing: .06em; text-transform: uppercase; }}
  </style></head><body><div class="shot"></div><div class="shade"></div><div class="txt"><div class="mark">C</div><h1>Chaser</h1>
  <p>Matches every PayPal payment to the right invoice, and handles what follows.</p><span class="pill">PayPal AI Hackathon 2026 · demo</span></div></body></html>"""


def render_html_png(html: str, out: Path, width: int, height: int) -> None:
    from playwright.sync_api import sync_playwright  # type: ignore

    src = out.with_suffix(".html")
    src.write_text(html, encoding="utf-8")
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
        pg.goto(src.as_uri(), wait_until="load")
        pg.wait_for_timeout(4000 if "animation" in html else 300)  # let CSS reveal animations finish
        jpeg = out.suffix.lower() in (".jpg", ".jpeg")
        pg.screenshot(path=str(out), type="jpeg" if jpeg else "png", **({"quality": 92} if jpeg else {}))
        b.close()


# ----------------------------------------------------------------------------------------------------------
# 3. Assembly
# ----------------------------------------------------------------------------------------------------------

X264 = ["-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-r", str(FPS), "-g", str(FPS * 2), "-profile:v", "high", "-level", "4.1"]


def frames_for_shot(frames: list[tuple[float, str]], start: float, end: float) -> list[tuple[str, float]]:
    """(file, duration) pairs covering [start, end]; the frame on screen at `start` is carried in."""
    idx = 0
    for i, (ts, _) in enumerate(frames):
        if ts <= start:
            idx = i
        else:
            break
    seq = [frames[idx]] + [f for f in frames[idx + 1 :] if f[0] < end]
    out: list[tuple[str, float]] = []
    for i, (ts, name) in enumerate(seq):
        t0 = max(ts, start)
        t1 = seq[i + 1][0] if i + 1 < len(seq) else end
        d = min(t1, end) - t0
        if d > 0.0005:
            out.append((name, d))
    return out


def encode_frames(frames_dir: Path, seq: list[tuple[str, float]], out: Path) -> None:
    """Resample the variable-rate screencast to constant FPS by piping, for every output tick, the JPEG that was on
    screen at that instant. (The concat demuxer's per-image `duration` is not reliable for sub-frame gaps.)"""
    total = sum(d for _, d in seq)
    n_out = max(1, int(round(total * FPS)))
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(FPS), "-c:v", "mjpeg", "-i", "pipe:0", "-vf", "format=yuv420p", "-an", *X264, str(out)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    assert proc.stdin is not None
    j, end_j = 0, seq[0][1]
    last_name, data = None, b""
    for k in range(n_out):
        t = k / FPS + 1e-6
        while t >= end_j and j < len(seq) - 1:
            j += 1
            end_j += seq[j][1]
        if seq[j][0] != last_name:
            last_name = seq[j][0]
            data = (frames_dir / last_name).read_bytes()
        proc.stdin.write(data)
    proc.stdin.close()
    err = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
    if proc.wait() != 0:
        raise SystemExit(f"ffmpeg failed for {out.name}: {err[-2000:]}")


def encode_card(png: Path, out: Path, seconds: float, fade_in: bool, fade_out: bool) -> None:
    vf = [f"fps={FPS}"]
    if fade_in:
        vf.append("fade=t=in:st=0:d=0.5")
    if fade_out:
        vf.append(f"fade=t=out:st={seconds - 0.5:.2f}:d=0.5")
    vf.append("format=yuv420p")
    run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", str(FPS), "-t", f"{seconds}", "-i", str(png), "-vf", ",".join(vf), "-an", *X264, str(out)])


def srt_time(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def sandbox_segment(work: Path, index: int, seconds: float) -> list[tuple[str, float]]:
    """The DROP-IN: one slide per screenshot in docs/sandbox-evidence/, equal time each, as (jpeg, seconds) pairs."""
    pngs = sandbox_pngs()
    if not pngs:
        raise SystemExit(f"The sandbox drop-in needs screenshots in {SANDBOX_EVIDENCE}; run scripts/sandbox_shots.py against a sandbox-mode server, or pass --no-sandbox-segment.")
    slides = work / "sandbox"
    slides.mkdir(exist_ok=True)
    seq: list[tuple[str, float]] = []
    for n, png in enumerate(pngs, 1):
        jpg = slides / f"slide{n:02d}.jpg"
        render_html_png(sandbox_slide_html(png, n, len(pngs), SHOTS[index - 1][0]), jpg, 1920, 1080)
        seq.append((jpg.name, seconds / len(pngs)))
    return seq


def assemble(work: Path, out: Path, narration: list[float]) -> Path:
    frames = [tuple(f) for f in json.loads((work / "frames.json").read_text(encoding="utf-8"))]
    shots = json.loads((work / "shots.json").read_text(encoding="utf-8"))
    seg_dir = work / "segments"
    seg_dir.mkdir(exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)

    # cards
    title_png, end_png = work / "title.png", work / "end.png"
    render_html_png(title_card_html(), title_png, 1920, 1080)
    render_html_png(end_card_html(), end_png, 1920, 1080)
    segments: list[tuple[Path, float | None, int | None]] = []  # (video, narration mp3 or None, shot index)
    encode_card(title_png, seg_dir / "00-title.mp4", CARD_SECONDS, True, True)
    segments.append((seg_dir / "00-title.mp4", None, None))

    by_key = {s["key"]: s for s in shots}
    expected = [k for k in SHOT_KEYS if k != SANDBOX_KEY]
    if list(by_key) != expected:
        raise SystemExit(f"shots.json has {list(by_key)} but the shot list needs {expected}: re-record (the sandbox drop-in is never recorded, so this is about the other shots).")
    for i, key in enumerate(SHOT_KEYS, 1):
        seg = seg_dir / f"{i:02d}-{key}.mp4"
        if key == SANDBOX_KEY:
            seq = sandbox_segment(work, i, narration[i - 1] + NARRATION_LEAD + SHOT_TAIL)
            encode_frames(work / "sandbox", seq, seg)
        else:
            shot = by_key[key]
            seq = frames_for_shot(frames, shot["start"], shot["end"])
            encode_frames(work / "frames", seq, seg)
        segments.append((seg, vo_path(work, key), i))
        print(f"  segment {i} {key}: {len(seq)} frames -> {media_duration(seg):.2f}s")

    encode_card(end_png, seg_dir / "99-end.mp4", CARD_SECONDS, True, False)
    segments.append((seg_dir / "99-end.mp4", None, None))

    # audio: each segment gets a wav exactly as long as its video; narration starts NARRATION_LEAD in
    wavs: list[Path] = []
    t = 0.0
    srt: list[str] = []
    timeline: list[dict] = []
    for seg, vo, idx in segments:
        length = media_duration(seg)
        wav = seg.with_suffix(".wav")
        if vo is None:
            run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", f"{length:.3f}", "-c:a", "pcm_s16le", str(wav)])
        else:
            delay = int(NARRATION_LEAD * 1000)
            run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", str(vo), "-af", f"adelay={delay}|{delay},apad", "-t", f"{length:.3f}", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(wav)])
            nd = narration[idx - 1]
            srt.append(f"{len(srt) + 1}\n{srt_time(t + NARRATION_LEAD)} --> {srt_time(t + NARRATION_LEAD + nd)}\n{SHOTS[idx - 1][1]}\n")
            timeline.append({"shot": idx, "title": SHOTS[idx - 1][0], "start": round(t, 2), "end": round(t + length, 2), "video_s": round(length, 2), "narration_s": round(nd, 2)})
        wavs.append(wav)
        t += length
    timeline.insert(0, {"shot": 0, "title": "Title card", "start": 0.0, "end": CARD_SECONDS, "video_s": CARD_SECONDS})
    timeline.append({"shot": len(SHOTS) + 1, "title": "End card", "start": round(t - CARD_SECONDS, 2), "end": round(t, 2), "video_s": CARD_SECONDS})

    alist = work / "audio.txt"
    alist.write_text("".join(f"file '{w.as_posix()}'\n" for w in wavs), encoding="utf-8")
    audio = work / "audio.wav"
    run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(alist), "-c", "copy", str(audio)])
    vlist = work / "video.txt"
    vlist.write_text("".join(f"file '{s.as_posix()}'\n" for s, _, _ in segments), encoding="utf-8")

    final = out / "chaser-demo.mp4"
    run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(vlist), "-i", str(audio), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-shortest", str(final)])
    (out / "chaser-demo.srt").write_text("\n".join(srt), encoding="utf-8")
    (out / "shots.json").write_text(json.dumps(timeline, indent=1), encoding="utf-8")

    # thumbnail: approval-card still (or the command center) behind the title
    bg = next((p for p in (out / "stills" / "04-approval-card-reconciliation.png", out / "stills" / "01-match-review.png") if p.exists()), None)
    if bg:
        render_html_png(thumbnail_html(bg), out / "chaser-demo-thumb.png", 1280, 720)
    # 1280x720 copies of the stills for the Devpost gallery
    for png in sorted((out / "stills").glob("*.png")):
        if png.name.endswith("-720p.png"):
            continue
        run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", str(png), "-vf", "scale=1280:720:flags=lanczos", str(png.with_name(png.stem + "-720p.png"))])
    return final


# ----------------------------------------------------------------------------------------------------------
# 4. Verification
# ----------------------------------------------------------------------------------------------------------


def verify(final: Path, work: Path) -> dict:
    probe = json.loads(run([FFPROBE, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(final)]).stdout)
    dur = float(probe["format"]["duration"])
    size = int(probe["format"]["size"])
    kinds = {s["codec_type"]: s for s in probe["streams"]}
    assert "audio" in kinds, "no audio stream"
    assert "video" in kinds, "no video stream"
    assert dur <= HARD_CAP, f"too long: {dur:.1f}s > {HARD_CAP}s"
    assert size <= 100 * 1024 * 1024, f"too big: {size / 1e6:.1f} MB"
    # sample frames and make sure none is (near) black
    samples = work / "samples"
    samples.mkdir(exist_ok=True)
    report = []
    for k, t in enumerate([1.5, 5, 25, 50, 80, 110, dur - 8, dur - 1.5]):
        if t < 0 or t > dur:
            continue
        png = samples / f"t{int(t):03d}.png"
        run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", str(final), "-frames:v", "1", str(png)])
        stats = run([FFMPEG, "-hide_banner", "-ss", f"{t:.2f}", "-i", str(final), "-frames:v", "1", "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-f", "null", "-"]).stderr
        yavg = next((float(line.split("=")[-1]) for line in stats.splitlines() if "YAVG" in line), 0.0)
        report.append({"t": round(t, 1), "png": str(png), "yavg": yavg})
        assert yavg > 16, f"frame at {t:.1f}s is black (YAVG={yavg})"
    # no stretch of (near) black longer than the card fades
    bd = run([FFMPEG, "-hide_banner", "-i", str(final), "-vf", "blackdetect=d=0.8:pix_th=0.10", "-an", "-f", "null", "-"]).stderr
    black = [line.split("]", 1)[-1].strip() for line in bd.splitlines() if "black_start" in line]
    assert not black, f"long black stretch(es): {black}"
    # audio actually has signal
    vol = run([FFMPEG, "-hide_banner", "-i", str(final), "-af", "volumedetect", "-vn", "-f", "null", "-"]).stderr
    mean_vol = next((line.split("mean_volume:")[1].strip() for line in vol.splitlines() if "mean_volume" in line), "?")
    result = {"black_stretches": black, "duration_s": round(dur, 2), "size_mb": round(size / 1048576, 1), "video": f"{kinds['video']['codec_name']} {kinds['video']['width']}x{kinds['video']['height']} {kinds['video'].get('r_frame_rate')}", "audio": f"{kinds['audio']['codec_name']} {kinds['audio'].get('sample_rate')} Hz", "mean_volume": mean_vol, "frames": report}
    print(json.dumps(result, indent=1))
    return result


# ----------------------------------------------------------------------------------------------------------


def main() -> None:
    global SANDBOX_EVIDENCE
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=LIVE_URL)
    ap.add_argument("--voice", default="en-US-AndrewNeural")
    ap.add_argument("--rate", default="-5%")
    ap.add_argument("--out", default=str(REPO / "video"))
    ap.add_argument("--work", default=str(Path(tempfile.gettempdir()) / "chaser-video"), help="scratch dir for frames/segments (hundreds of MB)")
    ap.add_argument("--step", choices=["all", "narrate", "record", "assemble", "verify"], default="all")
    ap.add_argument("--headed", action="store_true", help="show the browser while recording")
    ap.add_argument("--no-sandbox-segment", action="store_true", help="leave out the PayPal sandbox drop-in (docs/sandbox-evidence/*.png not recorded yet)")
    ap.add_argument("--sandbox-evidence", default=str(SANDBOX_EVIDENCE), help="folder with the sandbox screenshots for the drop-in")
    a = ap.parse_args()
    SANDBOX_EVIDENCE = Path(a.sandbox_evidence)
    select_shots(not a.no_sandbox_segment)
    if not a.no_sandbox_segment and a.step in ("all", "assemble") and not sandbox_pngs():
        sys.exit(f"The sandbox drop-in needs screenshots in {SANDBOX_EVIDENCE} (run scripts/sandbox_shots.py against a sandbox-mode server), or pass --no-sandbox-segment.")
    print(f"shots:  {len(SHOTS)} ({'with' if SANDBOX_KEY in SHOT_KEYS else 'without'} the sandbox drop-in)")
    work, out = Path(a.work), Path(a.out)
    work.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    print(f"ffmpeg: {FFMPEG}\nwork:   {work}\nout:    {out}")

    t0 = time.time()
    narration: list[float] = []
    if a.step in ("all", "narrate", "record", "assemble"):
        print("[1/4] narration")
        narration = narrate(work, a.voice, a.rate)
    if a.step in ("all", "record"):
        print(f"[2/4] recording {a.url}")
        record(work, out, a.url, narration, a.headed)
    final = out / "chaser-demo.mp4"
    if a.step in ("all", "assemble"):
        print("[3/4] assembling")
        final = assemble(work, out, narration)
    if a.step in ("all", "assemble", "verify"):
        print("[4/4] verifying")
        verify(final, work)
    print(f"done in {time.time() - t0:.0f}s -> {final}")


if __name__ == "__main__":
    main()
