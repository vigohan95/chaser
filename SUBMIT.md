# Submission kit - PayPal AI Hackathon (Devpost)

Deadline: **2026-11-12 12:00 PST**. Registration: done. Live demo: **https://chaser-six.vercel.app** (Vercel Hobby, auto-deploys from `main`; mock PayPal + keyless planner, no env vars).

## A. Devpost fields (paste as-is, edit links)

**Project name**
`Chaser`

**Tagline** (max 60 chars)
`An AI agent that collects your invoices on PayPal, your rules.`

**About the project**

*Inspiration*
Freelancers lose hours every week chasing money. Invoices going 30+ days late is normal, and the real work is not sending the invoice, it is the follow-up: reminders that do not sound robotic, matching a $1,400 payment to the two invoices it covers, deciding whether a $15 dispute is worth fighting. We wanted an agent that does the follow-up on PayPal and only interrupts you when a decision is actually yours.

*What it does*
Chaser is an accounts-receivable agent with a command center. You describe the work ("I finished the logo package for Acme, $1,200, net 15") and it creates and sends the PayPal invoice. It chases overdue invoices under a policy you set (friendly at 3 days, firm at 10, final at 21, max 4 reminders, min 3 days apart), writing each reminder from the invoice's actual line items and pay link. It reconciles PayPal payments to invoices, including partial and combined payments, and records them. It accepts disputes under your limit and drafts evidence packs for the rest, adds shipment tracking, and sets up monthly retainers as PayPal subscriptions. Anything outside the policy (a $600 refund, cancelling an invoice) shows up as an approval card. Everything it does is in an audit timeline with the reason, and the AG Grid command center is where you see and steer it.

*How we built it*
- PayPal: the PayPal Agent Toolkit (`@paypal/agent-toolkit` 1.11) on the sandbox: Invoicing v2 (create, send, remind, record payment, record refund, QR, search), Transaction Search (`list_transactions`), Payments v2 (`create_refund`), Disputes v1 (list, get, accept), Shipment Tracking, Catalog and Subscriptions. PayPal Webhooks (signature-verified via `verify-webhook-signature`) drive reactive reconciliation and dispute triage. A seeder populates the sandbox through the toolkit.
- AI: Vercel AI SDK 7 agent loop (`streamText`, multi-step tools, `toolApproval` for human-in-the-loop) with Gemini / Groq / Nemotron on free tiers. A policy engine evaluates every tool call (allow / ask / deny) before it runs. Deterministic tools (`propose_collections`, `match_payments`) give the model a plan to act on, so small models behave. A keyless rule-based planner implements the same `LanguageModelV3` interface so the product runs end-to-end with no API keys, which is also how the hosted demo runs.
- UI: Next.js 16 App Router + React 19, AG Grid Community for the invoice, transaction and dispute grids (inline policy editing, selection-driven agent actions, live updates, custom renderers, row rules, pinned totals, theming API), approval cards rendered from the SDK's typed tool parts.
- Ops: Vercel Hobby; the server is stateless between requests (the browser carries its demo snapshot, hydrated per request), so the hosted demo is serverless-safe and every visitor gets an isolated copy of the business. Daily Vercel Cron sweep that only performs policy-allowed actions. 46 vitest tests including the full agent loop.

*Challenges we ran into*
The toolkit targets Vercel AI SDK v4 while the current SDK is v7, so we wrote an adapter that keeps the official zod schemas and descriptions but re-wraps execution and inserts the policy gate. A few toolkit schema quirks (string quantities, a no-spaces regex on `accept_dispute_claim.note`, no `payment_term` on `create_invoice`) needed prompt guidance and tests. On Vercel, in-memory state drifted between function instances, so we moved the demo state into the client and hydrate it per request. Designing the approval flow so the agent can be *stopped* by policy without the conversation dying took iteration: denied calls now return a reason the model explains back to you.

*Accomplishments that we're proud of*
The whole product runs with zero keys, which also made it testable: the end-to-end suite runs the real AI SDK loop with the real policy gate. The reconciliation matcher handles the messy cases (partial payments, one payment for two invoices, memo hints). Reminders read like a person wrote them.

*What we learned*
Agentic commerce is mostly a policy problem. Once "what may the agent do alone" is explicit data, the LLM part gets simpler and safer, and the UI writes itself: approval cards are just the policy's edges made visible.

*What's next*
Multi-merchant auth (PayPal Log In), evidence submission through the Disputes API, Payouts for refunds to non-PayPal payers, Claude/OpenAI providers, and email delivery of reminders through the merchant's own mailbox.

**Built with** (tags)
`paypal`, `paypal-agent-toolkit`, `paypal-invoicing`, `paypal-webhooks`, `vercel-ai-sdk`, `next.js`, `react`, `typescript`, `ag-grid`, `gemini`, `groq`, `vercel`, `zod`, `vitest`

**Try it out** links
- Live demo: `https://chaser-six.vercel.app` (no sign-in; mock PayPal + keyless planner; "Reset demo" restores data; each visitor has their own copy)
- GitHub: `https://github.com/vigohan95/chaser` (public, MIT license file visible in the About panel)

**Video**: YouTube, Public, under 3:00 (plan in section B).

**Image gallery** (1280x720 PNGs, capture from the running app)
1. Command center with overdue invoices colour-coded and the agent drawer open
2. Approval card for a $600 refund with the policy reason
3. Reconciliation result: combined payment split across two invoices
4. Audit timeline with policy decisions
5. Architecture diagram (export the README Mermaid)
6. (If the sandbox segment is recorded) the same invoice in sandbox.paypal.com

**Hackathon-specific fields**
- *Tools used (AI)*: Vercel AI SDK 7; Google Gemini 2.5 Flash via AI Studio (or Groq gpt-oss-120b) for the agent; a rule-based fallback planner; Claude Code assisted development.
- *Sponsor prize opt-in*: AG Grid (yes), Best Use of Agentic Commerce (yes), Best Use of PayPal + AI (yes), Best Demo Delivery (yes). APIMatic / Bryntum / Channel3 / Render: no.
- *New or existing project*: New.
- *Team*: solo.

## B. Demo video plan (final; target 2:50, hard cap 2:58)

Recording setup: Chrome at 1440x900, dark-mode off, https://chaser-six.vercel.app freshly opened in a new tab (fresh snapshot). OBS screen capture at 1080p30, narration recorded separately (your voice or edge-tts `en-US-GuyNeural`), no music, cut in a free editor (Shotcut/DaVinci) or `ffmpeg`. Keep the cursor slow; let each result sit for a beat. If you record the sandbox segment (section D), insert it at 1:48 and trim 10 s elsewhere.

| Time | Shot (on the live site unless noted) | Voice-over |
|---|---|---|
| 0:00-0:10 | Title card: "Chaser - an AI agent that collects your invoices on PayPal" (2 s), then the live command center; zoom on the KPI strip: Outstanding $16,110, Overdue $14,460 | "Freelancers spend hours a week chasing money. Chaser is an AI agent that collects it for them, on PayPal, inside rules they set. Everything here is sandbox money." |
| 0:10-0:30 | Scroll the AG Grid right to the Overdue and Chase stage columns; click the Overdue header to sort; click Policy, hover the thresholds | "The command center is an AG Grid: twenty invoices, overdue days colour-coded, and the chasing policy is just configuration. Friendly nudge at three days, firm at ten, final at twenty-one. Accept disputes under twenty dollars. Ask me before any refund over five hundred." |
| 0:30-0:58 | Type in the drawer: `I finished the logo package for Acme Corp, $1,200, net 15`. Tool chips appear: Look up client, Create invoice, Send invoice. New row INV-0021 at the top; click the Audit tab briefly | "Tell it what you did. It looks up the client, creates the PayPal invoice through the PayPal Agent Toolkit and sends it. Every step lands in an audit timeline with the reason it was allowed." |
| 0:58-1:25 | Back on Invoices. Click Run collections. Chips: Plan collections, then nine Send reminder chips; expand one chip to show subject and note quoting the work and pay link; the Reminders column updates | "Run collections. The agent applies the policy and writes a different reminder for each client: a final notice for Acme at thirty-seven days, a gentle nudge for Northwind at five. Each one quotes the actual work and the pay link." |
| 1:25-1:48 | Click Reconcile payments. Switch to the Transactions tab: the three UNMATCHED rows turn into invoice chips; read the agent summary line about the $1,400 split | "Three payments came in without an invoice link. The agent matches them, including a partial payment and one payment covering two invoices, explains each match, and records them on PayPal." |
| 1:48-2:05 | Pick INV-0003 in "Simulate: client pays", click Fire webhook; the row turns green, Outstanding drops | "When a client pays, PayPal's webhook hits Chaser and the invoice is reconciled on the spot." |
| 2:05-2:28 | Type `Refund $600 on INV-0007`. The amber approval card appears with the policy reason; click Approve; the chip turns green and the summary shows the refund id | "Outside the policy, it asks. A six-hundred-dollar refund is over my limit, so I get a card with the reason. I approve, and it finishes the job." |
| 2:28-2:42 | Click Review disputes. Chips: List disputes, Accept dispute, Draft evidence. Open the Disputes tab and click the $480 row to show the evidence pack | "Disputes: the fifteen-dollar one is accepted automatically, the four-hundred-eighty-dollar one gets an evidence pack drafted for me to submit." |
| 2:42-2:50 | README prize table or the architecture diagram, then the repo and live URLs | "Invoices, payments, disputes, tracking, subscriptions, reporting: one agent, your rules. Built on the PayPal sandbox with the PayPal Agent Toolkit, the Vercel AI SDK and AG Grid." |

Optional sandbox insert (adds credibility for "Best Use of PayPal + AI"; 15 s, replaces 1:48-2:05 and trims 5 s from 0:10-0:30): split screen of the local app in sandbox mode and https://www.sandbox.paypal.com showing the same invoice number, then paying it as the sandbox buyer and clicking Refresh in Chaser so it flips to PAID. Voice-over: "Here is the same flow against the real PayPal sandbox: the invoice exists on PayPal, the buyer pays it, and Chaser reconciles it."

## C. What the user must do (in order)

1. ~~Devpost: register~~ done.
2. ~~Vercel: import repo~~ done (https://chaser-six.vercel.app).
3. **Record the video** following section B (nothing to install: the live site is enough). Upload to YouTube as Public.
4. **Optional sandbox segment** (recommended, ~25 min, local only): see section D.
5. **Devpost submission**: paste section A, upload gallery images, opt in to the sponsor prizes, add the YouTube link, submit before 2026-11-12 12:00 PST.

## D. Sandbox run: recommendation and exact steps

**Recommendation.** Keep the public demo in mock mode. It is deterministic, isolated per visitor, costs nothing, exposes no keys, and the rules only require a working build plus clear run instructions (the README has both). Do a **local** sandbox run once, for the optional video insert and to be able to say truthfully that the toolkit calls were exercised against PayPal. Do **not** put PayPal or Gemini keys on Vercel: strangers would burn the free Gemini quota and create junk in your sandbox, and the mock planner already drives the same tools.

**Local sandbox run (no Vercel changes):**
1. In `work/hackathons/paypal-chaser/.env.local` (copy from `.env.example`) set:
   - `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`: https://developer.paypal.com/dashboard/applications/sandbox -> "Default Application" (or create `chaser-sandbox`) -> Client ID / Secret (click "Show").
   - `MOCK_PAYPAL=0`
   - `GOOGLE_GENERATIVE_AI_API_KEY`: https://aistudio.google.com/apikey -> Create API key (free tier, no card). Optional; without it the keyless planner runs.
2. `npm run seed -- --limit=8` creates eight demo invoices in your sandbox through the toolkit and sends them (they appear at https://www.sandbox.paypal.com/invoice/ when logged in as the sandbox *business* account).
3. `npm run dev`, open http://localhost:3000: the grid now lists the real sandbox invoices (the mode chip says "PayPal sandbox").
4. Pay one invoice as the sandbox *personal* account: https://developer.paypal.com/dashboard/accounts -> the personal account -> "View/Edit account" for the login -> open the invoice's pay link in a private window -> pay. Click **Refresh** in Chaser; the invoice flips to PAID (Transaction Search in sandbox can lag a few minutes; the invoice status does not).
5. "Run collections" / "Reconcile payments" now act on PayPal. Tell Claude if anything errors (the sandbox mappers have only been run against the mock so far).

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
