# Submission kit - PayPal AI Hackathon (Devpost)

Deadline: **2026-11-12 12:00 PST**. Registration: done. Live demo: **https://chaser-six.vercel.app** (Vercel Hobby, auto-deploys from `main`; demo data + keyless planner until the env vars in section D are set).

## A. Devpost fields (paste as-is, edit links)

**Project name**
`Chaser`

**Tagline** (max 60 chars)
`Matches every PayPal payment to the right invoice, and what follows`
(59 chars. Alternative: `Reconciles PayPal payments, fights disputes, within your policy`)

**About the project**

*Inspiration*
PayPal already sends invoices and reminders. What eats a freelancer's evening is what happens after the money moves: a $1,400 transfer that covers two invoices, a $300 "part payment, rest next week" with no invoice attached, a $480 dispute from a client who signed off on the work. Those are judgment calls with a paper trail, and they are exactly the calls an agent should propose and a human should be able to edit before anything is written to PayPal. We wanted that agent, with its permissions written down as data rather than buried in a prompt.

*What it does*
Chaser is an accounts-receivable agent with an AG Grid command center. **Reconciliation:** it matches every unlinked PayPal payment to open invoices (exact, partial, one payment across several invoices) with a confidence and a reason, and the match review grid lets you edit any allocation, split a payment or re-point it before it is recorded through Invoicing v2. **Policy as data:** a JSON policy says what the agent may do alone (record exact matches, accept disputes under $20, refund under $500), what it must ask about, and what it may never do; every decision lands in an approval ledger citing the policy field it was made on. **Disputes:** for a dispute above your limit it assembles the evidence pack from the invoice line items, payment record, shipment tracking and reminder history, shows you the statement as an approval card, and submits it through the PayPal Disputes API (provide-evidence, or send-message while it is an inquiry). It also chases overdue invoices with reminders written from each invoice (friendly / firm / final, cadence-limited), creates and sends invoices from a sentence, adds shipment tracking and sets up retainers as subscriptions. PayPal webhooks reconcile paid invoices on the spot.

*How we built it*
- PayPal: the PayPal Agent Toolkit (`@paypal/agent-toolkit` 1.11) on the sandbox: Invoicing v2 (create, send, remind, record payment, record refund, QR, search), Transaction Search (`list_transactions`), Payments v2 (`create_refund`), Disputes v1 (list, get, accept), Shipment Tracking, Catalog and Subscriptions. The Disputes API `provide-evidence` / `send-message` endpoints are not in the toolkit, so Chaser calls them over REST (multipart evidence with tracking info and notes). PayPal Webhooks (signature-verified via `verify-webhook-signature`) drive reactive reconciliation and dispute triage. A seeder populates the sandbox through the toolkit.
- AI: Vercel AI SDK 7 agent loop (`streamText`, multi-step tools, `toolApproval` for human-in-the-loop) with Gemini / Groq / Nemotron on free tiers, behind per-visitor and global daily caps so a free key can live on the public URL. A pure policy engine evaluates every tool call (allow / ask / deny) before it runs and names the policy field it used. Deterministic tools (`match_payments`, `propose_collections`, `draft_dispute_evidence`) give the model a plan to act on, so small models behave. A keyless rule-based planner implements the same `LanguageModelV3` interface, so the product runs end-to-end with no API keys and the test suite exercises the real agent loop.
- UI: Next.js 16 App Router + React 19, AG Grid Community: the match review (editable allocations with `valueSetter`, select editor to re-point a line, split rows, over-allocation guard, cell flash, pinned totals, CSV export), the approval ledger, and the invoice / payments / disputes grids (inline per-invoice policy editing, selection-driven agent actions, live updates, custom renderers, row rules, theming API). Approval cards are rendered from the SDK's typed tool parts.
- Ops: Vercel Hobby; the server is stateless between requests (the browser carries its snapshot, hydrated per request), so the hosted demo is serverless-safe and every visitor gets an isolated copy of the business. Daily Vercel Cron sweep that only performs policy-allowed actions. 69 vitest tests including the full agent loop and the Disputes API call path.

*Challenges we ran into*
The toolkit targets Vercel AI SDK v4 while the current SDK is v7, so we wrote an adapter that keeps the official zod schemas and descriptions but re-wraps execution and inserts the policy gate. A few toolkit schema quirks (string quantities, a no-spaces regex on `accept_dispute_claim.note`, no `payment_term` on `create_invoice`) needed prompt guidance and tests. On Vercel, in-memory state drifted between function instances, so we moved the demo state into the client and hydrate it per request. Designing the approval flow so the agent can be *stopped* by policy without the conversation dying took iteration: denied calls now return a reason the model explains back to you.

*Accomplishments that we're proud of*
The match review: the agent proposes, the human edits in the grid, and only then does anything reach PayPal, with over-allocation caught before it happens and over-balance lines turned into approval cards by the policy rather than by UI code. The approval ledger, where every row names the policy field it was decided on. A dispute evidence pack that goes all the way to the Disputes API instead of stopping at "paste this into the Resolution Center". And the whole product runs with zero keys, which made it testable end to end.

*What we learned*
Agentic commerce is mostly a policy problem. Once "what may the agent do alone" is explicit data, the LLM part gets simpler and safer, the UI writes itself (approval cards are the policy's edges made visible), and the audit trail becomes something a bookkeeper can read.

*What's next*
Multi-merchant auth (PayPal Log In), evidence file attachments on `provide-evidence`, Payouts for refunds to non-PayPal payers, Claude/OpenAI providers, and email delivery of reminders through the merchant's own mailbox.

**Built with** (tags)
`paypal`, `paypal-agent-toolkit`, `paypal-invoicing`, `paypal-webhooks`, `vercel-ai-sdk`, `next.js`, `react`, `typescript`, `ag-grid`, `gemini`, `groq`, `vercel`, `zod`, `vitest`

**Try it out** links
- Live demo: `https://chaser-six.vercel.app` (no sign-in; demo data, Gemini when the key is set with daily caps, keyless planner otherwise; "Reset demo" restores data; each visitor has their own copy)
- GitHub: `https://github.com/vigohan95/chaser` (public, MIT license file visible in the About panel)

**Video**: YouTube, Public, under 3:00 (plan in section B).

**Image gallery** (1280x720 PNGs, capture from the running app)
1. Payments tab: match review with the $1,400 split edited and the over-allocation guard
2. Approval card for the over-balance allocation, citing `reconciliation.amountTolerance`
3. Approvals tab: the ledger with allowed / approved by you / denied rows and policy fields
4. Disputes tab: the $480 evidence pack submitted via Disputes API provide-evidence
5. Command center with overdue invoices colour-coded and the agent drawer open
6. The same invoice / transaction in sandbox.paypal.com (from the sandbox evidence folder)

**Hackathon-specific fields**
- *Tools used (AI)*: Vercel AI SDK 7; Google Gemini 2.5 Flash via AI Studio for the agent on the hosted demo (daily-capped), a rule-based fallback planner when no key or the cap is reached; Claude Code assisted development.
- *Sponsor prize opt-in*: AG Grid (yes), Best Use of Agentic Commerce (yes), Best Use of PayPal + AI (yes), Best Demo Delivery (yes). APIMatic / Bryntum / Channel3 / Render: no.
- *New or existing project*: New.
- *Team*: solo.

## B. Demo video plan (target 2:50, hard cap 2:58)

Recording: fully automated and reproducible, no camera or microphone. `PYTHONUTF8=1 python scripts/make_video.py` (needs `pip install playwright edge-tts`, `python -m playwright install chromium`, ffmpeg on PATH) drives the live site in headless Chromium at 1920x1080, narrates each shot with edge-tts (`en-US-AndrewNeural`, -5%), and cuts the shots below plus a 3 s title card and a 3 s end card with ffmpeg into `video/chaser-demo.mp4` (H.264 + AAC), with `chaser-demo.srt`, a 1280x720 thumbnail and stills for the gallery in `video/stills/`. `video/shots.json` has the actual cut. **The shot list below is the new order (reconciliation and disputes first); the script's click sequence needs re-cutting to match it** - the narration strings in `scripts/make_video.py` `SHOTS` are already updated, the per-shot actions are not.

| Time | Shot (on the live site unless noted) | Voice-over |
|---|---|---|
| 0:00-0:08 | Title card: "Chaser - matches every PayPal payment to the right invoice, and handles what follows" (2 s), then the Payments tab with the match review already populated: three unlinked payments, the $1,400 split 90% across two invoices | "Money arrived on PayPal. Which invoice is it? Chaser is an AI agent that answers that, on PayPal, inside rules you write down. Everything here is sandbox money." |
| 0:08-0:35 | Hover the Why column (reasoning); edit the split to $1,000 / $400 - the lines turn red (over-allocated); fix to $1,000 / $400 against $900 / $500; click Record 4 allocations; three chips turn green and an amber approval card appears for the $1,000 line | "One payment, two invoices: the agent proposes the split and explains it. This is an AG Grid, so I can change any allocation before it touches PayPal. If my edit over-allocates, the grid stops me. If it exceeds what an invoice is owed, the policy stops the agent: it comes back as a card citing the rule." |
| 0:35-0:50 | Approve the card; switch to the Approvals tab; the ledger shows allowed by policy / approval required / approved by you with `reconciliation.autoRecordPartials = on` and `reconciliation.amountTolerance` in the Policy rule column | "Approve, and it finishes. Every decision lands in the approval ledger with the policy field it was made on. The policy is data: change a number, and the next decision changes with it." |
| 0:50-1:05 | Click Policy; show `disputes.autoAcceptUnder $20`, `Dispute evidence packs: show me, then submit`, `Ask me for refunds over $500` | "Here is that policy. Accept disputes under twenty dollars. Show me evidence packs before they go. Ask before any refund over five hundred." |
| 1:05-1:35 | Click Review disputes. Chips: List disputes, Accept dispute ($15), Build evidence pack ($480), then an approval card with the full seller statement (invoice line items, payment, no shipment, statement). Approve. Open the Disputes tab, click the $480 row: "submitted via Disputes API provide-evidence", status under PayPal review | "Disputes. The fifteen-dollar one is under my limit: accepted. The four-hundred-eighty-dollar one gets an evidence pack built from what Chaser already knows: the invoice line items, the payment record, the reminder history. I read the statement, approve, and it goes to PayPal through the Disputes API. Not a draft to paste somewhere: submitted." |
| 1:35-1:52 | **Sandbox insert** (local recording, `docs/sandbox-evidence/`): split screen of Chaser in "PayPal sandbox" mode listing real sandbox invoices next to the same invoice on sandbox.paypal.com; a reminder sent; Transaction Search rows | "The same code runs against the real PayPal sandbox through the PayPal Agent Toolkit: these invoices, reminders and transactions exist on PayPal." |
| 1:52-2:10 | Back on the live site, Invoices tab. Click Run collections; nine Send reminder chips; expand one to show the subject and note quoting the work and pay link; Reminders column updates | "Collections, inside the cadence: friendly at three days, firm at ten, final at twenty-one, never more than four. Each reminder quotes the actual work and the pay link." |
| 2:10-2:25 | Type `I finished the logo package for Acme Corp, $1,200, net 15`; chips Look up client, Create invoice, Send invoice; new row INV-0021 | "And the ordinary things: tell it what you did and it creates and sends the PayPal invoice." |
| 2:25-2:38 | Type `Refund $600 on INV-0007`; amber approval card with the policy reason; click Deny; the ledger gets a "denied by you" row | "Outside the policy, it asks. I deny this one, and that is on the record too." |
| 2:38-2:50 | README architecture diagram, then the repo and live URLs | "Reconciliation you can edit, policy as data, disputes handled end to end. Built on the PayPal sandbox with the PayPal Agent Toolkit, the Vercel AI SDK and AG Grid." |

If the sandbox insert is not recorded, drop shot 1:35-1:52 and extend the Disputes and Collections shots by ~8 s each.

## C. What the user must do (in order)

1. ~~Devpost: register~~ done.
2. ~~Vercel: import repo~~ done (https://chaser-six.vercel.app, auto-deploys `main`).
3. **Gemini on the hosted demo (5 min, free, recommended)**: https://aistudio.google.com/apikey -> Create API key -> Vercel -> Project `chaser` -> Settings -> Environment Variables -> add `GOOGLE_GENERATIVE_AI_API_KEY` (Production) and optionally `AGENT_LLM_RUNS_PER_IP_PER_DAY=20`, `AGENT_LLM_RUNS_PER_DAY=300` -> Deployments -> Redeploy. The drawer then says `model: gemini-2.5-flash`; past the caps visitors get the keyless planner, so the free tier cannot be burned. Do **not** put PayPal credentials on Vercel (strangers would write to your sandbox).
4. **Sandbox proof (local, ~25 min)**: section D. Needed for the README "Verified on PayPal sandbox" section and the 17 s video insert. Status 2026-10-10: not yet run - `.env.local` has `MOCK_PAYPAL=0` / `ALLOW_SANDBOX_SEED=1` but `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` were still empty after a 60-minute wait. Paste them, then either tell Claude or run `npm run seed -- --limit=8` and `npm run sandbox:check` yourself (evidence lands in `docs/sandbox-evidence/`).
5. **Video**: re-cut `scripts/make_video.py` to the section B order (the narration strings are updated; the click sequence is not), run it, upload to YouTube as Public (thumbnail `video/chaser-demo-thumb.png`, captions `video/chaser-demo.srt`).
6. **Devpost submission**: paste section A, upload the 6 gallery images, opt in to the sponsor prizes, add the YouTube link, submit before 2026-11-12 12:00 PST.

## D. Sandbox run: recommendation and exact steps

**Recommendation.** Keep the public demo on demo data (deterministic, isolated per visitor, no PayPal writes by strangers) with a Gemini key behind the daily caps (section C step 3). Do the sandbox run **locally** once: it is what lets the README say truthfully which PayPal calls were made, and it is the only source for the video insert. PayPal credentials never go to Vercel.

**Local sandbox run (no Vercel changes):**
1. In `work/hackathons/paypal-chaser/.env.local` (copy from `.env.example`) set:
   - `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`: https://developer.paypal.com/dashboard/applications/sandbox -> "Default Application" (or create `chaser-sandbox`) -> Client ID / Secret (click "Show").
   - `MOCK_PAYPAL=0`, `ALLOW_SANDBOX_SEED=1`
   - `GOOGLE_GENERATIVE_AI_API_KEY`: optional; without it the keyless planner runs the same tools.
   Claude polls this file and runs the rest of this list itself (seed, dev server, API checks, mapper fixes, screenshots into `docs/sandbox-evidence/`, README section). What only you can do:
2. **Pay one invoice as the sandbox buyer** (needs the sandbox personal login; Claude never logs in anywhere): https://developer.paypal.com/dashboard/accounts -> the personal account -> "View/Edit account" for the email + password -> open the invoice's pay link (the "Pay link" column in Chaser, or the invoice email in the sandbox buyer's notifications) in a private window -> log in as the buyer -> pay. Click **Refresh** in Chaser; the invoice flips to PAID (Transaction Search in sandbox can lag a few minutes; the invoice status does not).
3. **Open a dispute on that payment** (for the Disputes API proof): log in at https://www.sandbox.paypal.com as the same personal account -> Activity -> the payment -> "Report a problem" -> "I didn't receive the item / not as described" -> submit. Then in Chaser: Disputes tab -> the dispute -> **Build and submit evidence pack** -> Approve. Tell Claude when the dispute exists so the real `provide-evidence` / `send-message` call can be captured.
4. If anything errors, paste the message to Claude; the sandbox mappers are fixed against real responses as they appear.

**Only if you later want the hosted site on the sandbox too** (Vercel -> Project -> Settings -> Environment Variables, then redeploy):

| Name | Where the value comes from |
|---|---|
| `MOCK_PAYPAL` | `0` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal developer dashboard, Sandbox app (step 1 above) |
| `PAYPAL_WEBHOOK_ID` | PayPal dashboard -> the sandbox app -> Webhooks -> Add: URL `https://chaser-six.vercel.app/api/webhooks/paypal`, events `INVOICING.INVOICE.PAID`, `INVOICING.INVOICE.CANCELLED`, `PAYMENT.CAPTURE.COMPLETED`, `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.RESOLVED`, `BILLING.SUBSCRIPTION.ACTIVATED` -> copy the Webhook ID |
| `GOOGLE_GENERATIVE_AI_API_KEY` | https://aistudio.google.com/apikey |
| `CRON_SECRET` | any long random string (enables the daily sweep; without it `/api/cron/collections` answers 401) |
| `MERCHANT_BUSINESS_NAME`, `MERCHANT_GIVEN_NAME`, `MERCHANT_SURNAME`, `MERCHANT_EMAIL` | how invoices are signed (optional) |

## E. Pre-submission checklist

- [ ] Commits are authored as `Han Vigo <284575144+vigohan95@users.noreply.github.com>` (repo-local git config is set). Vercel blocks push-triggered deploys whose author is not attributed to the GitHub account; `hanwg666@gmail.com` is not linked to vigohan95, so commits with it show as unattributed and were blocked ("Deployment was blocked"). Alternative: add that email to https://github.com/settings/emails and verify it.
- [ ] `npm test`, `npm run build`, `npm run lint` all green on the commit you submit (CI-free: run locally)
- [ ] Repo public; LICENSE visible in GitHub About; README has setup steps and the PayPal capability list
- [ ] No secrets in git (`git grep -i "client_secret\|api_key" -- ':!*.example' ':!*.md'` is empty)
- [ ] https://chaser-six.vercel.app loads in a private window; "Reset demo" works; the approval card appears for `Refund $600 on INV-0007`
- [ ] Video < 3:00, Public, shows the app running end to end and says "sandbox"
- [ ] Devpost: tagline, about, built-with tags, links, video, 5-6 images, sponsor opt-ins, AI tools used
