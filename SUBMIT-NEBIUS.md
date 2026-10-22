# Submission kit - Nebius x NVIDIA Global AI Hackathon (Devpost)

Deadline: **2026-10-30 10:00 PDT**. Registered: 2026-10-22 (Devpost hanwg666). Submission draft id: 1253176. Track: **Best Apps and Agents**. Bonus: **Best Use of Tavily** (functional runtime call via `check_payer_signals`).

Hosted demo: https://chaser-six.vercel.app (must run with `LLM_PROVIDER=nebius` + `NEBIUS_API_KEY` on Vercel so the drawer shows `nebius/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`).

## A. Devpost fields

**Project name**
`Chaser`

**Tagline** (max 60)
`AR agent on Nemotron: chases invoices, reads the news first`
(57 chars)

**About the project**

*Inspiration*
Invoice chasing is a tone problem as much as a timing problem. The same "final notice" that is right for a client who is simply slow is wrong for one who filed for Chapter 11 yesterday, and pointless for one whose company was just absorbed by a bigger one with a new payables desk. We had an accounts-receivable agent with a written policy and a cited ledger; this hackathon was the push to give it a planner that runs on open weights and a look at the outside world before it escalates.

*What it does*
Chaser is a seller-side accounts-receivable agent on PayPal with an AG Grid command center. It reconciles payments to invoices (published accuracy on a benchmark), chases overdue invoices on a cadence that reads the payer's history and PayPal's viewed flag, honours a client's promise to pay, assembles dispute evidence, and decides what happens after the final notice (write-off, settlement, hand-off) under a JSON policy that says what the agent may do alone. New for this hackathon: the planner is **NVIDIA Nemotron 3 Nano on Nebius Token Factory**, and before any final notice, settlement or hand-off the agent runs **payer signals**, a Tavily news search on the client (last month) classified into distress / change / growth with the articles as evidence, auto-attached to every after-final proposal.

*How we built it*
- Model: Nebius Token Factory, OpenAI-compatible endpoint, `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` through `@ai-sdk/openai-compatible` in the Vercel AI SDK 7 agent loop (`streamText`, multi-step tools, `toolApproval` for human-in-the-loop). Nemotron returns its reasoning alongside tool calls; one chase turn is 2 steps and ~27 s on the demo data.
- Signals: `src/lib/agent/signals.ts` calls Tavily (`topic=news`, `time_range=month`, 5 results, 1 credit), classifies by keyword families, and returns evidence + a recommendation the model must weigh, not obey. Without a key it returns a demo set labelled `source: "demo"`.
- Everything about money is deterministic code (matching, cadence, predictions, policy gate); the model picks the next tool and writes the prose. That is why a 30B model behaves.
- PayPal Agent Toolkit on the sandbox; Next.js 16 + React 19 + AG Grid Community; Vercel Hobby; 129 vitest tests including the real agent loop.

*Challenges we ran into*
Nemotron's reasoning tokens count against `max_tokens`, so short completions came back empty until we raised the budget; the provider adapter had to surface the exact model id so the UI never claims a model that did not answer; and a news signal must never be mistaken for a fact, so the tool returns evidence links and a recommendation, and the demo path is labelled as a demo in the ledger.

*Accomplishments*
A planner on open weights running a 14-tool loop with policy gating; a "read the news before you escalate" step that changes the agent's decision on the demo client (Chapter 11 -> hand-off, not a final notice); and a reproducible smoke script (`npm run nebius:smoke`) that proves a real Nemotron turn in the terminal.

*What we learned*
Small open models are enough for agentic finance when the numbers are computed and the model only decides and writes. External signals belong in the agent's tool set as evidence, with provenance, not as a prompt fact.

*What's next*
Nemotron Super for the dispute-evidence drafting step, Tavily finance topic for public companies, and a signal history per client in the grid.

**Built with** (tags)
`nebius-token-factory`, `nvidia-nemotron`, `tavily`, `next.js`, `react`, `typescript`, `vercel-ai-sdk`, `ag-grid`, `paypal`, `vercel`, `vitest`

**Project existed before the submission period: what changed (required by the rules)**
Chaser was built in October 2026 for the PayPal AI Hackathon. During the Nebius submission period we (1) made Nemotron on Token Factory the default planner with explicit provider selection and a true model label, (2) added payer signals with Tavily (new tool, auto-attached to after-final proposals, demo fallback), (3) grew the test suite from 119 to 129 and added two smoke scripts that run real Nemotron turns. Commits: 6337cd3, 3085c2a, 0d75cef on https://github.com/vigohan95/chaser.

**Links**
- Repo: https://github.com/vigohan95/chaser (MIT)
- Demo: https://chaser-six.vercel.app
- Video: (YouTube, TODO)

## B. Video plan (<= 3 min, YouTube, no copyrighted music)
1. Title: Chaser on Nemotron (Nebius Token Factory). 0:00-0:05
2. Command center, drawer shows `model: nebius/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`. "Which invoices are overdue and what's next?" -> Nemotron calls propose_collections, 7-invoice plan. 0:05-0:50
3. After-final: "Acme's INV-0001 is at final notice, decide." -> propose_after_final returns the proposal with signals: Chapter 11 (demo label visible) -> hand-off, approval card. 0:50-1:40
4. Ledger row: check_payer_signals, risk, recommendation, evidence link. 1:40-2:05
5. Terminal: `npm run nebius:smoke` output (model id, steps, ms). 2:05-2:30
6. What changed + repo + end card. 2:30-2:55

## C. User steps
- Vercel chaser project: add `NEBIUS_API_KEY` (dialog prefilled), optional `TAVILY_API_KEY`; `LLM_PROVIDER=nebius` already added; then Deployments -> Redeploy.
- Devpost edit page sits behind a Cloudflare check: open the tab once so Claude can fill the form.
- Final: click Submit on Devpost before 2026-10-30 10:00 PDT.
