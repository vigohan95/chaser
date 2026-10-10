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
SHOTS: list[tuple[str, str]] = [
    ("Command center", "Freelancers spend hours a week chasing money. Chaser is an AI agent that collects it for them, on PayPal, inside rules they set. Everything here is sandbox money."),
    ("AG Grid + chasing policy", "The command center is an AG Grid: twenty invoices, overdue days colour-coded, and the chasing policy is just configuration. Friendly nudge at three days, firm at ten, final at twenty-one. Accept disputes under twenty dollars. Ask me before any refund over five hundred."),
    ("Create and send an invoice", "Tell it what you did. It looks up the client, creates the PayPal invoice through the PayPal Agent Toolkit and sends it. Every step lands in an audit timeline with the reason it was allowed."),
    ("Run collections", "Run collections. The agent applies the policy and writes a different reminder for each client: a final notice for Acme at thirty-seven days, a gentle nudge for Northwind at five. Each one quotes the actual work and the pay link."),
    ("Reconcile payments", "Three payments came in without an invoice link. The agent matches them, including a partial payment and one payment covering two invoices, explains each match, and records them on PayPal."),
    ("PayPal webhook", "When a client pays, PayPal's webhook hits Chaser and the invoice is reconciled on the spot."),
    ("Approval card", "Outside the policy, it asks. A six-hundred-dollar refund is over my limit, so I get a card with the reason. I approve, and it finishes the job."),
    ("Disputes", "Disputes: the fifteen-dollar one is accepted automatically, the four-hundred-eighty-dollar one gets an evidence pack drafted for me to submit."),
    ("One agent, your rules", "Invoices, payments, disputes, tracking, subscriptions, reporting: one agent, your rules. Built on the PayPal sandbox with the PayPal Agent Toolkit, the Vercel AI SDK and AG Grid."),
]

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


def narrate(work: Path, voice: str, rate: str) -> list[float]:
    import edge_tts  # type: ignore

    vo_dir = work / "vo"
    vo_dir.mkdir(parents=True, exist_ok=True)

    async def render() -> None:
        for i, (_, text) in enumerate(SHOTS, 1):
            out, stamp = vo_dir / f"vo{i}.mp3", vo_dir / f"vo{i}.txt"
            key = f"{voice}|{rate}|{text}"
            if out.exists() and out.stat().st_size > 0 and stamp.exists() and stamp.read_text(encoding="utf-8") == key:
                continue  # cached from a previous run with the same voice, rate and text
            await edge_tts.Communicate(text, voice, rate=rate).save(str(out))
            stamp.write_text(key, encoding="utf-8")

    asyncio.run(render())
    durations = [media_duration(vo_dir / f"vo{i}.mp3") for i in range(1, len(SHOTS) + 1)]
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

    def begin(self, index: int) -> None:
        self.caption(f"{index} / {len(SHOTS)}  —  {SHOTS[index - 1][0]}")
        self.pause(0.25)
        self.shots.append({"index": index, "title": SHOTS[index - 1][0], "start": time.time()})

    def end(self, min_len: float) -> None:
        shot = self.shots[-1]
        remaining = min_len - (time.time() - shot["start"])
        if remaining > 0:
            self.pause(remaining)
        shot["end"] = time.time()
        shot["seconds"] = round(shot["end"] - shot["start"], 2)
        print(f"  shot {shot['index']}: {shot['seconds']:.1f}s  {shot['title']}")

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

    # -- app helpers ----------------------------------------------------------------------------------------
    def wait_agent_done(self, timeout: float = 120) -> None:
        stop = self.page.locator("aside button:has-text('Stop')")
        try:
            stop.wait_for(state="visible", timeout=15_000)
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

        grid_input = page.locator("main input[placeholder^='Filter']")
        agent_input = page.locator("aside form input")
        send_btn = page.locator("aside form button[type=submit]")
        tab = lambda name: page.locator(f"main nav button:has-text('{name}')")  # noqa: E731
        header_btn = lambda name: page.locator(f"header button:has-text('{name}')")  # noqa: E731
        action_btn = lambda name: page.locator(f"main button:has-text('{name}')").first  # noqa: E731
        app_root = "body > div.flex"

        # ---- 1. Command center + KPI zoom ----------------------------------------------------------------
        rec.begin(1)
        rec.still(stills, "01-command-center")
        rec.move(700, 640, 0.9)
        rec.pause(1.6)
        page.evaluate(f"() => {{ const r = document.querySelector('{app_root}'); r.style.transition = 'transform 1.6s cubic-bezier(.4,0,.2,1)'; r.style.transformOrigin = '0px 60px'; r.style.transform = 'scale(1.45)'; }}")
        rec.pause(1.7)
        rec.move(120, 150, 1.0)
        rec.move(560, 150, 1.6)
        rec.pause(1.8)
        page.evaluate(f"() => {{ document.querySelector('{app_root}').style.transform = 'scale(1)'; }}")
        rec.pause(1.7)
        page.evaluate(f"() => {{ const r = document.querySelector('{app_root}'); r.style.transition = ''; r.style.transform = ''; }}")
        rec.end(need[0])

        # ---- 2. AG Grid tour + policy --------------------------------------------------------------------
        rec.begin(2)
        overdue_hdr = page.locator(".ag-header-cell[col-id='overdue']")
        rec.hover(overdue_hdr)
        rec.pause(0.4)
        for n in ("0001", "0002", "0006", "0003"):  # 37d final, 15d firm, 10d firm, 5d friendly
            cell = page.locator(f".ag-row[row-id='INV2-CH{n}-MOCK-{n}-DEMO'] .ag-cell[col-id='overdue']").first
            rec.hover(cell, dur=0.4)
            rec.pause(0.2)
        smooth_scroll(page, ".ag-body-horizontal-scroll-viewport", left=420)
        rec.pause(1.3)
        smooth_scroll(page, ".ag-body-horizontal-scroll-viewport", left=0)
        rec.pause(0.9)
        # selection drives agent actions
        for rid in ("INV2-CH0001-MOCK-0001-DEMO", "INV2-CH0010-MOCK-0010-DEMO"):
            rec.click(page.locator(f".ag-row[row-id='{rid}'] .ag-selection-checkbox").first, settle=0.3)
        rec.hover(action_btn("Chase selected"))
        rec.pause(1.0)
        for rid in ("INV2-CH0001-MOCK-0001-DEMO", "INV2-CH0010-MOCK-0010-DEMO"):
            rec.click(page.locator(f".ag-row[row-id='{rid}'] .ag-selection-checkbox").first, settle=0.15)
        rec.click(header_btn("Policy"), settle=0.5)
        for label in ("Friendly nudge after", "Firm reminder after", "Final notice after", "Auto-accept disputes under", "Ask me for refunds over"):
            rec.hover(page.locator(f"aside label:has-text('{label}') input"), dur=0.45)
            rec.pause(0.45)
        rec.still(stills, "02-policy-panel")
        rec.pause(0.3)
        rec.click(header_btn("Policy"), settle=0.3)
        rec.end(need[1])

        # ---- 3. Create + send an invoice from natural language --------------------------------------------
        rec.begin(3)
        rec.type_text(agent_input, "I finished the logo package for Acme Corp, $1,200, net 15")
        rec.pause(0.3)
        rec.click(send_btn)
        rec.wait_agent_done()
        rec.pause(1.0)
        rec.type_text(grid_input, "Acme", cps=14)
        rec.pause(0.5)
        new_row = page.locator(".ag-row[row-id]:has-text('INV-0021')").first
        if new_row.count():
            rec.hover(new_row.locator(".ag-cell").nth(1))
        rec.pause(1.3)
        rec.click(grid_input)
        page.keyboard.press("Control+A")
        page.keyboard.press("Backspace")
        rec.pause(0.3)
        rec.click(tab("Audit"), settle=0.7)
        rec.hover(page.locator("main ol li").nth(1))
        rec.still(stills, "03-audit-timeline")
        rec.pause(2.0)
        rec.click(tab("Invoices"), settle=0.2)
        rec.end(need[2])

        # ---- 4. Run collections ----------------------------------------------------------------------------
        rec.begin(4)
        rec.click(action_btn("Run collections"))
        rec.wait_agent_done()
        rec.pause(0.8)
        chip = page.locator("aside .chip:has-text('Send reminder')").first
        chip.evaluate("el => el.scrollIntoView({ behavior: 'smooth', block: 'center' })")
        rec.pause(0.9)
        rec.click(chip, settle=0.5)
        rec.hover(page.locator("aside pre").first, dy=-20)
        rec.pause(3.2)
        rec.still(stills, "04-reminder-detail")
        rec.hover(page.locator(".ag-header-cell[col-id='reminders'], .ag-header-cell:has-text('Reminders')").first)
        rec.pause(1.0)
        rec.end(need[3])

        # ---- 5. Reconcile payments -----------------------------------------------------------------------
        rec.begin(5)
        rec.click(tab("Transactions"), settle=0.9)
        rec.hover(page.locator(".ag-row[row-id]:has-text('UNMATCHED')").first.locator(".ag-cell").last)
        rec.pause(0.9)
        rec.click(action_btn("Reconcile payments"))
        rec.wait_agent_done()
        rec.pause(0.8)
        summary = page.locator("aside .mr-2").last.locator("div.prose-chat").last
        rec.hover(summary, dy=-40)
        rec.still(stills, "05-reconciliation")
        rec.pause(2.0)
        rec.end(need[4])

        # ---- 6. Webhook -----------------------------------------------------------------------------------
        rec.begin(6)
        rec.click(tab("Invoices"), settle=0.5)
        sel = page.locator("header select")
        rec.hover(sel)
        rec.pause(0.3)
        sel.select_option(label="INV-0003 - Northwind Traders - $1,500.00")
        rec.pause(0.7)
        rec.click(header_btn("Fire webhook"), settle=0.6)
        paid_row = page.locator(".ag-row[row-id='INV2-CH0003-MOCK-0003-DEMO']").first
        try:
            paid_row.locator(":text('PAID')").first.wait_for(timeout=10_000)
            rec.hover(paid_row.locator(".ag-cell[col-id='status']").first)  # the row re-sorts; may be virtualized away
        except Exception:
            pass
        rec.pause(1.2)
        rec.hover(page.locator("main .grid > div").first)
        rec.pause(0.8)
        rec.end(need[5])

        # ---- 7. Approval card --------------------------------------------------------------------------------
        rec.begin(7)
        rec.type_text(agent_input, "Refund $600 on INV-0007")
        rec.pause(0.2)
        rec.click(send_btn)
        approve = page.locator("aside button:has-text('Approve')")
        approve.wait_for(timeout=60_000)
        rec.pause(0.5)
        rec.hover(page.locator("aside .border-amber-400 p").first)
        rec.still(stills, "06-approval-card")
        rec.pause(2.4)
        rec.click(approve, settle=0.4)
        rec.wait_agent_done()
        rec.pause(1.8)
        rec.end(need[6])

        # ---- 8. Disputes -------------------------------------------------------------------------------------
        rec.begin(8)
        rec.click(action_btn("Review disputes"))
        rec.wait_agent_done()
        rec.pause(0.6)
        rec.click(tab("Disputes"), settle=0.8)
        rec.click(page.locator(".ag-row[row-id]:has-text('480')").first.locator(".ag-cell").nth(3), settle=0.6)
        rec.hover(page.locator("main pre").first, dy=-10)
        rec.still(stills, "07-dispute-evidence")
        rec.pause(2.0)
        rec.end(need[7])

        # ---- 9. Closing slide ----------------------------------------------------------------------------------
        slide = work / "slide.html"
        slide.write_text(closing_slide_html(f"{len(SHOTS)} / {len(SHOTS)}  —  {SHOTS[-1][0]}"), encoding="utf-8")
        rec.begin(9)
        page.goto(slide.as_uri(), wait_until="load")
        rec.pause(1.0)
        rec.end(need[8])
        rec.pause(0.3)

        rec.stop()
        shots = rec.shots
        frames = rec.frames
        browser.close()

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
  <p class="tag">An AI agent that collects your invoices on PayPal, your rules.</p>
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
  <div><h1>One agent, your rules<small>Eight PayPal toolkit areas plus webhooks, driven by an agent that asks at the edges.</small></h1><ul>{tiles}</ul></div>
  <div class="right">{boxes}</div></div>
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
  <p>An AI agent that collects your invoices on PayPal, your rules.</p><span class="pill">PayPal AI Hackathon 2026 · demo</span></div></body></html>"""


def render_html_png(html: str, out: Path, width: int, height: int) -> None:
    from playwright.sync_api import sync_playwright  # type: ignore

    src = out.with_suffix(".html")
    src.write_text(html, encoding="utf-8")
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
        pg.goto(src.as_uri(), wait_until="load")
        pg.wait_for_timeout(4000 if "animation" in html else 300)  # let CSS reveal animations finish
        pg.screenshot(path=str(out))
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

    for shot in shots:
        i = shot["index"]
        seq = frames_for_shot(frames, shot["start"], shot["end"])
        seg = seg_dir / f"{i:02d}-shot.mp4"
        encode_frames(work / "frames", seq, seg)
        segments.append((seg, work / "vo" / f"vo{i}.mp3", i))
        print(f"  segment {i}: {len(seq)} frames -> {media_duration(seg):.2f}s")

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
    timeline.append({"shot": 10, "title": "End card", "start": round(t - CARD_SECONDS, 2), "end": round(t, 2), "video_s": CARD_SECONDS})

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
    bg = next((p for p in (out / "stills" / "06-approval-card.png", out / "stills" / "01-command-center.png") if p.exists()), None)
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
    # audio actually has signal
    vol = run([FFMPEG, "-hide_banner", "-i", str(final), "-af", "volumedetect", "-vn", "-f", "null", "-"]).stderr
    mean_vol = next((line.split("mean_volume:")[1].strip() for line in vol.splitlines() if "mean_volume" in line), "?")
    result = {"duration_s": round(dur, 2), "size_mb": round(size / 1048576, 1), "video": f"{kinds['video']['codec_name']} {kinds['video']['width']}x{kinds['video']['height']} {kinds['video'].get('r_frame_rate')}", "audio": f"{kinds['audio']['codec_name']} {kinds['audio'].get('sample_rate')} Hz", "mean_volume": mean_vol, "frames": report}
    print(json.dumps(result, indent=1))
    return result


# ----------------------------------------------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=LIVE_URL)
    ap.add_argument("--voice", default="en-US-AndrewNeural")
    ap.add_argument("--rate", default="-5%")
    ap.add_argument("--out", default=str(REPO / "video"))
    ap.add_argument("--work", default=str(Path(tempfile.gettempdir()) / "chaser-video"), help="scratch dir for frames/segments (hundreds of MB)")
    ap.add_argument("--step", choices=["all", "narrate", "record", "assemble", "verify"], default="all")
    ap.add_argument("--headed", action="store_true", help="show the browser while recording")
    a = ap.parse_args()
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
