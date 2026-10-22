#!/usr/bin/env python3
"""
Nebius x NVIDIA Global AI Hackathon demo video for Chaser. Reuses the pipeline in make_video.py (edge-tts narration,
Playwright + CDP screencast, ffmpeg assembly, ffprobe verification) with its own shot list, cards and slides.

Shots (SUBMIT-NEBIUS.md section B):
  model       the drawer's model label (read from the server) + one chase turn planned by Nemotron
  afterfinal  after-final review: payer signals per client (Chapter 11 on the demo client) -> hand-off -> approval card
  audit       approve; the Audit tab shows the news check per client, the policy decision and the approval
  terminal    slide with the verbatim output of `npm run nebius:smoke` (video/nebius/nebius-smoke.txt)
  closing     slide: what changed for this hackathon

Usage:
  npm run -s nebius:smoke > video/nebius/nebius-smoke.txt      # once; the terminal slide shows this file verbatim
  python scripts/make_video_nebius.py                           # everything against https://chaser-six.vercel.app
  python scripts/make_video_nebius.py --step record --headed
  python scripts/make_video_nebius.py --step assemble           # re-cut from the frames already on disk

Outputs (video/nebius/, git-ignored): chaser-nemotron.mp4, chaser-nemotron.srt, chaser-nemotron-thumb.png, shots.json, stills/.
"""
from __future__ import annotations

import argparse
import base64
import html
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import make_video as mv  # noqa: E402

OUT_NAME = "chaser-nemotron"
MODEL_ID = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"
SMOKE_TXT = mv.REPO / "video" / "nebius" / "nebius-smoke.txt"

SHOTS: list[tuple[str, str, str]] = [
    ("model", "Nemotron in the loop",
     "Chaser is an accounts-receivable agent on PayPal that works inside a policy you write down. For this hackathon the planner runs on open weights: NVIDIA Nemotron 3 Nano, served by Nebius Token Factory. The model label in the drawer comes from the server, so it only says Nemotron when Nemotron answered. I ask what is overdue. Nemotron reads the policy, calls the collections planner, and writes the next step for each invoice."),
    ("afterfinal", "After the final notice: read the news first",
     "Now the part a cadence cannot decide. Three invoices are past their final notice. Before Chaser proposes anything, it checks the news on each client. Northwind Traders owes two thousand six hundred dollars and the feed says Chapter eleven: risk, distress. The policy answers hand-off, not another notice. Bluebird was acquired, so confirm the new payables desk before offering a discount. The hand-off needs my approval, and it comes back as a card citing the rule it was decided on."),
    ("audit", "On the record",
     "I approve. The audit timeline keeps the whole chain: the news check per client with its recommendation, the policy decision with the field it cited, and my approval. Demo clients are labelled demo. A real client gets a live Tavily search, and the live-probe count shows that call actually ran."),
    ("terminal", "One real turn from the terminal",
     "Nothing here needs the browser. npm run nebius smoke runs one real Nemotron turn from the terminal and prints the model id, the steps, the tools and the time. Thinking is off by default in the chat template, so the chase turn takes about five seconds. With thinking on, the same turn streamed a minute of reasoning. One environment variable switches it back."),
    ("closing", "What changed for this hackathon",
     "What changed for this hackathon: Nemotron on Token Factory as the default planner with a true model label; the thinking switch; payer signals from Tavily as a tool, attached to every after-final proposal and written to the audit log; and a smoke script that proves a real turn. Source and the live demo are on the end card."),
]


def install_shots() -> None:
    """Point make_video's module globals at this shot list (its functions read them at call time)."""
    mv.SHOT_KEYS = [s[0] for s in SHOTS]
    mv.SHOTS = [(s[1], s[2]) for s in SHOTS]
    mv.SANDBOX_KEY = "__no_sandbox_dropin__"
    mv.title_card_html = title_card_html
    mv.end_card_html = end_card_html
    mv.OVERLAY_JS = mv.OVERLAY_JS.replace("PayPal sandbox, play money only", "demo data, no real money")


# ----------------------------------------------------------------------------------------------------------
# Cards and slides
# ----------------------------------------------------------------------------------------------------------

CAP_RIGHT = "chaser-six.vercel.app  ·  demo data, no real money"


def title_card_html() -> str:
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{mv.BASE_CSS}
  .wrap {{ position: absolute; inset: 0; display: grid; place-items: center; text-align: center; }}
  h1 {{ font-size: 120px; letter-spacing: -.02em; margin-top: 26px; }}
  p.tag {{ font-size: 40px; margin-top: 18px; color: rgba(255,255,255,.85); }}
  p.model {{ font-size: 26px; margin-top: 30px; font-family: ui-monospace, Consolas, monospace; color: #93c5fd; }}
  p.ev {{ font-size: 28px; margin-top: 44px; letter-spacing: .12em; text-transform: uppercase; color: rgba(255,255,255,.6); }}
  </style></head><body><div class="bg"></div><div class="wrap"><div>
  <div class="mark">C</div><h1>Chaser</h1>
  <p class="tag">An accounts-receivable agent on Nemotron: it chases invoices, and reads the news first.</p>
  <p class="model">planner: {MODEL_ID} · Nebius Token Factory</p>
  <p class="ev">Nebius x NVIDIA Global AI Hackathon 2026 · Best Apps and Agents</p></div></div></body></html>"""


def end_card_html() -> str:
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{mv.BASE_CSS}
  .wrap {{ position: absolute; inset: 0; display: grid; place-items: center; text-align: center; }}
  h1 {{ font-size: 72px; letter-spacing: -.02em; margin-top: 22px; }}
  .url {{ font-size: 44px; margin-top: 40px; font-family: ui-monospace, Consolas, monospace; color: #93c5fd; }}
  .url small {{ display: block; font-size: 22px; color: rgba(255,255,255,.55); margin-bottom: 8px; font-family: ui-sans-serif, system-ui, sans-serif; letter-spacing: .1em; text-transform: uppercase; }}
  p.ft {{ font-size: 26px; margin-top: 64px; color: rgba(255,255,255,.6); }}
  </style></head><body><div class="bg"></div><div class="wrap"><div>
  <div class="mark">C</div><h1>Chaser</h1>
  <div class="url"><small>Live demo (no sign-in, demo data, Nemotron answers)</small>{mv.LIVE_URL.replace('https://', '')}</div>
  <div class="url"><small>Source (MIT)</small>{mv.REPO_URL.replace('https://', '')}</div>
  <p class="ft">Nebius Token Factory · NVIDIA Nemotron 3 Nano · Tavily · Vercel AI SDK 7 · Next.js 16 · AG Grid</p></div></div></body></html>"""


def terminal_slide_html(caption: str) -> str:
    if not SMOKE_TXT.exists():
        raise SystemExit(f"{SMOKE_TXT} is missing: run `npm run -s nebius:smoke > {SMOKE_TXT.relative_to(mv.REPO).as_posix()}` first (the slide shows the real output).")
    raw = SMOKE_TXT.read_text(encoding="utf-8", errors="replace")
    skip = ("◇", "real", "user", "sys")
    lines = [ln.rstrip() for ln in raw.splitlines() if not ln.startswith(skip)]
    body = html.escape("\n".join(lines).strip())
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{mv.BASE_CSS}
  .page {{ position: absolute; inset: 0 0 44px 0; padding: 60px 90px; display: grid; grid-template-columns: 1.25fr .75fr; gap: 60px; align-items: start; }}
  .term {{ background: #0a0f1a; border: 1px solid rgba(255,255,255,.14); border-radius: 14px; box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden; }}
  .bar {{ height: 40px; background: #111827; display: flex; align-items: center; gap: 8px; padding: 0 16px; font-size: 14px; color: rgba(255,255,255,.55); }}
  .bar i {{ width: 12px; height: 12px; border-radius: 50%; display: inline-block; }} .bar i:nth-child(1) {{ background: #ef4444 }} .bar i:nth-child(2) {{ background: #f59e0b }} .bar i:nth-child(3) {{ background: #22c55e }}
  .bar span {{ margin-left: 10px; font-family: ui-monospace, Consolas, monospace; }}
  pre {{ margin: 0; padding: 22px 26px; font: 19px/1.45 ui-monospace, Consolas, "Cascadia Mono", monospace; color: #e5e7eb; white-space: pre-wrap; word-break: break-word; max-height: 860px; overflow: hidden; }}
  pre .p {{ color: #93c5fd }}
  h2 {{ font-size: 44px; letter-spacing: -.02em; line-height: 1.1; }}
  ul {{ list-style: none; margin-top: 30px; display: grid; gap: 14px; }}
  li {{ background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); border-radius: 14px; padding: 16px 20px; opacity: 0; animation: in .5s ease-out forwards; }}
  li b {{ display: block; font-size: 24px; }} li span {{ display: block; font-size: 18px; color: rgba(255,255,255,.65); margin-top: 4px; }}
  li code {{ font-family: ui-monospace, Consolas, monospace; color: #93c5fd; font-size: 17px; }}
  @keyframes in {{ from {{ opacity: 0; transform: translateY(10px) }} to {{ opacity: 1; transform: none }} }}
  </style></head><body><div class="bg"></div><div class="page">
  <div class="term"><div class="bar"><i></i><i></i><i></i><span>chaser - npm run nebius:smoke</span></div>
  <pre><span class="p">$</span> npm run nebius:smoke
{body}</pre></div>
  <div><h2>One real Nemotron turn, no browser</h2><ul>
   <li style="animation-delay:.3s"><b>Model id printed by the provider</b><span>The UI label and the ledger use the same source, so nothing claims a model that did not answer.</span></li>
   <li style="animation-delay:.6s"><b>Thinking off by default</b><span><code>chat_template_kwargs.enable_thinking=false</code> is injected by the provider's fetch. Chase turn: 4.9 s. With thinking on: 27 s here, a 60 s timeout on the hosted route.</span></li>
   <li style="animation-delay:.9s"><b>One variable to compare</b><span><code>NEBIUS_THINKING=1</code> turns it back on; <code>npm run nebius:signals</code> runs the after-final turn (29 s).</span></li>
  </ul></div></div>
  <div class="cap"><span class="m">Chaser demo</span><span class="b">{caption}</span><span class="r">{CAP_RIGHT}</span></div>
  </body></html>"""


def closing_slide_html(caption: str) -> str:
    changes = [
        ("Nemotron as the default planner", "LLM_PROVIDER=nebius · OpenAI-compatible against Token Factory · true model label in the UI and ledger"),
        ("The thinking switch", "enable_thinking=false by default, NEBIUS_THINKING=1 to compare · 5 s instead of a timeout"),
        ("Payer signals (Tavily)", "check_payer_signals tool · attached to every after-final proposal · per-client info row in the audit log · demo results say demo"),
        ("Proof in the terminal", "npm run nebius:smoke / nebius:signals · 132 tests, provider selection and signals covered"),
    ]
    tiles = "".join(f'<li style="animation-delay:{0.25 + i * 0.25:.2f}s"><b>{t}</b><span>{d}</span></li>' for i, (t, d) in enumerate(changes))
    flow = [
        ("Command center", "AG Grid · approval cards · audit timeline · policy panel"),
        ("Agent loop", "Vercel AI SDK 7 streamText + toolApproval · 14 tools"),
        ("Planner", MODEL_ID + " on Nebius Token Factory"),
        ("Policy engine", "allow · ask · deny - every tool call, every time"),
        ("Signals + PayPal", "Tavily news check · PayPal Agent Toolkit (sandbox)"),
    ]
    parts = []
    for i, (t, d) in enumerate(flow):
        parts.append(f'<div class="box" style="animation-delay:{0.6 + i * 0.3:.2f}s"><b>{t}</b><span>{d}</span></div>')
        if i < len(flow) - 1:
            parts.append(f'<div class="arr" style="animation-delay:{0.75 + i * 0.3:.2f}s">↓</div>')
    boxes = "".join(parts)
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{mv.BASE_CSS}
  .page {{ position: absolute; inset: 0 0 44px 0; padding: 70px 90px; display: grid; grid-template-columns: 1.05fr .95fr; gap: 70px; }}
  h1 {{ font-size: 60px; letter-spacing: -.02em; }} h1 small {{ display: block; font-size: 25px; color: rgba(255,255,255,.6); font-weight: 500; margin-top: 10px; letter-spacing: 0; }}
  ul {{ list-style: none; margin-top: 40px; display: grid; gap: 14px; }}
  li, .box {{ background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); border-radius: 14px; padding: 16px 20px; opacity: 0; animation: in .5s ease-out forwards; }}
  li b, .box b {{ display: block; font-size: 24px; }} li span, .box span {{ display: block; font-size: 18px; color: rgba(255,255,255,.65); margin-top: 4px; }}
  .right {{ display: flex; flex-direction: column; justify-content: center; }}
  .arr {{ text-align: center; font-size: 26px; color: rgba(255,255,255,.4); line-height: 1.1; opacity: 0; animation: in .4s ease-out forwards; }}
  .box {{ border-color: rgba(96,165,250,.45); }}
  @keyframes in {{ from {{ opacity: 0; transform: translateY(10px) }} to {{ opacity: 1; transform: none }} }}
  </style></head><body><div class="bg"></div><div class="page">
  <div><h1>What changed for this hackathon<small>Chaser existed before (PayPal AI Hackathon, Oct 2026). These four things are new, and every one of them is in the repo history.</small></h1><ul>{tiles}</ul></div>
  <div class="right">{boxes}</div></div>
  <div class="cap"><span class="m">Chaser demo</span><span class="b">{caption}</span><span class="r">{CAP_RIGHT}</span></div>
  </body></html>"""


def thumbnail_html(bg_png: Path) -> str:
    data = base64.b64encode(bg_png.read_bytes()).decode()
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
  * {{ box-sizing: border-box; margin: 0 }} html, body {{ width: 1280px; height: 720px; overflow: hidden; font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; color: #fff; }}
  .shot {{ position: absolute; inset: 0; background: url(data:image/png;base64,{data}) center/cover; }}
  .shade {{ position: absolute; inset: 0; background: linear-gradient(90deg, rgba(11,18,32,.96) 0%, rgba(11,18,32,.86) 44%, rgba(11,18,32,.15) 72%, rgba(11,18,32,0) 100%); }}
  .txt {{ position: absolute; left: 64px; top: 130px; width: 600px; }}
  .mark {{ display: inline-grid; place-items: center; width: 64px; height: 64px; border-radius: 16px; background: #2563eb; font-weight: 800; font-size: 36px; }}
  h1 {{ font-size: 88px; letter-spacing: -.03em; margin-top: 16px; line-height: 1; }}
  p {{ font-size: 28px; margin-top: 18px; line-height: 1.25; color: rgba(255,255,255,.9); }}
  .pill {{ display: inline-block; margin-top: 26px; padding: 10px 16px; border-radius: 999px; background: rgba(255,255,255,.12); font-size: 18px; letter-spacing: .06em; text-transform: uppercase; }}
  </style></head><body><div class="shot"></div><div class="shade"></div><div class="txt"><div class="mark">C</div><h1>Chaser</h1>
  <p>An AR agent on Nemotron: chases invoices, reads the news before it escalates.</p><span class="pill">Nebius x NVIDIA Global AI Hackathon · demo</span></div></body></html>"""


# ----------------------------------------------------------------------------------------------------------
# Recording
# ----------------------------------------------------------------------------------------------------------


def record(work: Path, out: Path, url: str, narration: list[float], headed: bool) -> list[dict]:
    from playwright.sync_api import sync_playwright  # type: ignore

    frames_dir = work / "frames"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True)
    stills = out / "stills"
    stills.mkdir(parents=True, exist_ok=True)
    need = [d + mv.NARRATION_LEAD + mv.SHOT_TAIL for d in narration]

    def need_for(key: str) -> float:
        return need[mv.SHOT_KEYS.index(key)]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not headed)
        ctx = browser.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=1, color_scheme="light", locale="en-US", timezone_id="America/Los_Angeles")
        page = ctx.new_page()
        page.goto(url, wait_until="networkidle", timeout=90_000)
        page.wait_for_selector(".ag-row[row-id]", timeout=60_000)
        page.wait_for_timeout(1200)
        page.mouse.move(960, 540)
        rec = mv.Recorder(page=page, cdp=ctx.new_cdp_session(page), frames_dir=frames_dir)
        rec.caption("")
        rec.start()
        rec.pause(0.8)
        if not rec.frames:
            raise SystemExit("screencast produced no frames")

        agent_input = page.locator("aside form input")
        send_btn = page.locator("aside form button[type=submit]")
        approve_btn = page.locator("aside button:has-text('Approve')")
        card = page.locator("aside .border-amber-400").first
        model_label = page.locator("aside div:text-matches('^model:')").first

        def tab(name: str):
            return page.locator(f"main nav button:has-text('{name}')")

        def chip(text: str):
            return page.locator(f"aside .chip:has-text('{text}')").last

        def last_reply():
            return page.locator("aside .prose-chat").last

        def wait_card_or_done(timeout: float) -> bool:
            """True when an approval card appeared; False when the run finished without one."""
            stop = page.locator("aside button:has-text('Stop')")
            t0 = time.time()
            seen_stop = False
            while time.time() - t0 < timeout:
                if approve_btn.count() and approve_btn.first.is_visible():
                    rec.pause(0.5)
                    return True
                visible = stop.count() > 0 and stop.first.is_visible()
                seen_stop = seen_stop or visible
                if seen_stop and not visible:
                    return False
                rec.pause(0.25)
            raise SystemExit(f"agent did not finish within {timeout}s")

        label_text = model_label.inner_text(timeout=10_000)
        if MODEL_ID not in label_text:
            raise SystemExit(f"The drawer says {label_text!r}, not Nemotron: the live site is not on LLM_PROVIDER=nebius (or the LLM quota fell back to the rule planner). Fix that before recording.")

        # ---- model: the label, then one chase turn -----------------------------------------------------------
        rec.begin("model")
        rec.hover(model_label, dx=-20)
        rec.pause(2.2)
        rec.still(stills, "01-model-label")
        rec.type_text(agent_input, "Which invoices are overdue right now, and what is the next chase step for each? Keep it short.")
        rec.pause(0.3)
        rec.click(send_btn)
        rec.wait_agent_done(timeout=80)
        rec.pause(0.7)
        c = chip("Plan collections")
        if c.count():
            rec.hover(c, dur=0.5)
            rec.pause(0.9)
        rec.hover(last_reply(), dy=-10, dur=0.6)
        rec.still(stills, "02-chase-turn")
        rec.pause(1.2)
        rec.end(need_for("model"))

        # ---- afterfinal: signals per client -> hand-off -> approval card ------------------------------------
        rec.begin("afterfinal")
        rec.type_text(agent_input, "Run the after-final review across all open invoices and carry out what the policy proposes.")
        rec.pause(0.3)
        rec.click(send_btn)
        got_card = wait_card_or_done(85)
        if not got_card:
            rec.pause(0.8)
            rec.type_text(agent_input, "Build the hand-off pack for INV-0026 now.")
            rec.click(send_btn)
            got_card = wait_card_or_done(70)
        if not got_card:
            raise SystemExit("no approval card after the after-final review: the hand-off should be 'ask' in the policy")
        pc = chip("propose after final")
        if pc.count():
            pc.scroll_into_view_if_needed()
            rec.pause(0.4)
            rec.click(pc, settle=0.6)  # expands input/output JSON (signals per proposal)
            pre = page.locator("aside pre").filter(has_text="Chapter 11").last
            try:
                pre.wait_for(timeout=5_000)
                pre.evaluate("el => { const t = el.textContent || ''; const i = t.indexOf('Chapter 11'); if (i > 0) el.scrollTop = Math.max(0, el.scrollHeight * (i / t.length) - 70); }")
                rec.hover(pre, dy=-30, dur=0.5)
                rec.pause(2.2)
                rec.still(stills, "03-signals-output")
            except Exception as e:  # the chip did not open (scrolled away); the audit tab shows the same signals
                print(f"  (signals JSON not shown: {e.__class__.__name__})")
        nw = page.locator("aside .border-amber-400:has-text('INV-0026')").first
        card = nw if nw.count() else card
        card.scroll_into_view_if_needed()
        rec.hover(card.locator("p").first, dy=-4)
        rec.pause(0.8)
        rec.still(stills, "04-handoff-approval-card")
        rec.pause(1.2)
        rec.end(need_for("afterfinal"))

        # ---- audit: approve, then the timeline ----------------------------------------------------------------
        rec.begin("audit")
        # Several proposals can each need approval (write-off, settlement, hand-off): approve them as they come.
        for _ in range(5):
            rec.click(approve_btn.first, settle=0.5)
            if not wait_card_or_done(80):
                break
        rec.wait_agent_done(timeout=80)
        rec.pause(0.8)
        rec.click(tab("Audit"), settle=0.9)
        sig = page.locator("main li:has-text('Payer signals for Northwind')").first
        sig.wait_for(timeout=15_000)
        sig.scroll_into_view_if_needed()
        rec.hover(sig, dy=-6)
        rec.pause(1.2)
        details = sig.locator("button:has-text('details')")
        if details.count():
            rec.click(details.first, settle=0.6)
        rec.still(stills, "05-audit-signals")
        rec.pause(1.6)
        appr = page.locator("main li:has-text('approved by you')").first
        if appr.count():
            appr.scroll_into_view_if_needed()
            rec.hover(appr, dy=-6, dur=0.6)
            rec.pause(1.4)
        rec.still(stills, "06-audit-approved")
        rec.end(need_for("audit"))

        # ---- terminal + closing slides ------------------------------------------------------------------------
        for key, builder in (("terminal", terminal_slide_html), ("closing", closing_slide_html)):
            slide = work / f"slide-{key}.html"
            slide.write_text(builder(mv.SHOTS[mv.SHOT_KEYS.index(key)][0]), encoding="utf-8")
            rec.begin(key)
            page.goto(slide.as_uri(), wait_until="load")
            rec.pause(1.0)
            if key == "terminal":
                page.screenshot(path=str(stills / "07-terminal.png"))
            rec.end(need_for(key))
        rec.pause(0.3)

        rec.stop()
        shots = rec.shots
        frames = rec.frames
        browser.close()

    if [s["key"] for s in shots] != mv.SHOT_KEYS:
        raise SystemExit(f"Recorded shots {[s['key'] for s in shots]} but the shot list is {mv.SHOT_KEYS}.")
    (work / "frames.json").write_text(json.dumps(frames), encoding="utf-8")
    (work / "shots.json").write_text(json.dumps(shots, indent=1), encoding="utf-8")
    print(f"  captured {len(frames)} frames")
    return shots


# ----------------------------------------------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=mv.LIVE_URL)
    ap.add_argument("--voice", default="en-US-AndrewNeural")
    ap.add_argument("--rate", default="-5%")
    ap.add_argument("--out", default=str(mv.REPO / "video" / "nebius"))
    ap.add_argument("--work", default=str(Path(tempfile.gettempdir()) / "chaser-video-nebius"))
    ap.add_argument("--step", choices=["all", "narrate", "record", "assemble", "verify"], default="all")
    ap.add_argument("--headed", action="store_true")
    a = ap.parse_args()
    install_shots()
    work, out = Path(a.work), Path(a.out)
    work.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    print(f"shots:  {len(mv.SHOTS)}\nffmpeg: {mv.FFMPEG}\nwork:   {work}\nout:    {out}")

    t0 = time.time()
    narration: list[float] = []
    if a.step in ("all", "narrate", "record", "assemble"):
        print("[1/4] narration")
        narration = mv.narrate(work, a.voice, a.rate)
    if a.step in ("all", "record"):
        print(f"[2/4] recording {a.url}")
        record(work, out, a.url, narration, a.headed)
    final = out / f"{OUT_NAME}.mp4"
    if a.step in ("all", "assemble"):
        print("[3/4] assembling")
        produced = mv.assemble(work, out, narration)  # writes chaser-demo.* into out
        for ext in (".mp4", ".srt"):
            src = produced.with_suffix(ext)
            if src.exists():
                src.replace(out / f"{OUT_NAME}{ext}")
        for stray in ("chaser-demo-thumb.png", "chaser-demo-thumb.html"):
            (out / stray).unlink(missing_ok=True)
        bg = next((q for q in (out / "stills" / "04-handoff-approval-card.png", out / "stills" / "02-chase-turn.png") if q.exists()), None)
        if bg:
            mv.render_html_png(thumbnail_html(bg), out / f"{OUT_NAME}-thumb.png", 1280, 720)
    if a.step in ("all", "assemble", "verify"):
        print("[4/4] verifying")
        mv.verify(final, work)
    print(f"done in {time.time() - t0:.0f}s -> {final}")


if __name__ == "__main__":
    main()
