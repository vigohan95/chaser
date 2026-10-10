# Submission kit - PayPal AI Hackathon (Devpost)

Deadline: **2026-11-12 12:00 PST**. Register first: https://paypalaihackathon.devpost.com/register

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
- AI: Vercel AI SDK 7 agent loop (`streamText`, multi-step tools, `toolApproval` for human-in-the-loop) with Gemini / Groq / Nemotron on free tiers. A policy engine evaluates every tool call (allow / ask / deny) before it runs. Deterministic tools (`propose_collections`, `match_payments`) give the model a plan to act on, so small models behave. A keyless rule-based planner implements the same `LanguageModelV3` interface so the product runs end-to-end with no API keys.
- UI: Next.js 16 App Router + React 19, AG Grid Community for the invoice, transaction and dispute grids (inline policy editing, selection-driven agent actions, live updates, custom renderers, row rules, pinned totals, theming API), approval cards rendered from the SDK's typed tool parts.
- Ops: Vercel Hobby, daily Vercel Cron sweep that only performs policy-allowed actions, 42 vitest tests including the full agent loop.

*Challenges we ran into*
The toolkit targets Vercel AI SDK v4 while the current SDK is v7, so we wrote an adapter that keeps the official zod schemas and descriptions but re-wraps execution and inserts the policy gate. A few toolkit schema quirks (string quantities, a no-spaces regex on `accept_dispute_claim.note`, no `payment_term` on `create_invoice`) needed prompt guidance and tests. Designing the approval flow so the agent can be *stopped* by policy without the conversation dying took iteration: denied calls now return a reason the model explains back to you.

*Accomplishments that we're proud of*
The whole product runs with zero keys, which also made it testable: the end-to-end suite runs the real AI SDK loop with the real policy gate. The reconciliation matcher handles the messy cases (partial payments, one payment for two invoices, memo hints). Reminders read like a person wrote them.

*What we learned*
Agentic commerce is mostly a policy problem. Once "what may the agent do alone" is explicit data, the LLM part gets simpler and safer, and the UI writes itself: approval cards are just the policy's edges made visible.

*What's next*
Multi-merchant auth (PayPal Log In), evidence submission through the Disputes API, Payouts for refunds to non-PayPal payers, Claude/OpenAI providers, and email delivery of reminders through the merchant's own mailbox.

**Built with** (tags)
`paypal`, `paypal-agent-toolkit`, `paypal-invoicing`, `paypal-webhooks`, `vercel-ai-sdk`, `next.js`, `react`, `typescript`, `ag-grid`, `gemini`, `groq`, `vercel`, `zod`, `vitest`

**Try it out** links
- GitHub: `https://github.com/vigohan95/chaser` (public, MIT license file in the About panel)
- Live demo: `https://chaser-<hash>.vercel.app` (mock mode, no sign-in; click "Reset demo" to restore data)

**Video**: YouTube, Public, under 3:00 (script in section B).

**Image gallery** (1280x720 PNGs, capture from the running app)
1. Command center with overdue invoices colour-coded and the agent drawer open
2. Approval card for a $600 refund with the policy reason
3. Reconciliation result: combined payment split across two invoices
4. Audit timeline with policy decisions
5. Architecture diagram (export the README Mermaid)

**Hackathon-specific fields**
- *Tools used (AI)*: Vercel AI SDK 7; Google Gemini 2.5 Flash via AI Studio (or Groq gpt-oss-120b) for the agent; a rule-based fallback planner; Claude Code assisted development.
- *Sponsor prize opt-in*: AG Grid (yes), Best Use of Agentic Commerce (yes), Best Use of PayPal + AI (yes), Best Demo Delivery (yes). APIMatic / Bryntum / Channel3 / Render: no.
- *New or existing project*: New.
- *Team*: solo.

## B. Demo video script (target 2:45; OBS screen capture, 1080p, narration via edge-tts or your voice, no music)

| Time | On screen | Narration |
|---|---|---|
| 0:00-0:12 | Title card "Chaser - an AI agent that collects your invoices on PayPal", then the grid with INV-0001 "37d overdue" in red | "Freelancers spend hours a week chasing money. Chaser is an AI agent that collects it for them, on PayPal, inside rules they set. Everything you see is the PayPal sandbox." |
| 0:12-0:35 | Pan the AG Grid: sort by overdue, filter "Acme", select two rows, open the Policy panel, change "Ask me for refunds over" to 500 | "The command center is an AG Grid: 20 invoices, overdue days colour-coded, chasing policy editable per row. The policy says: friendly nudge at 3 days, firm at 10, final at 21; accept disputes under $20; ask me before any refund over $500." |
| 0:35-1:05 | Type "I finished the logo package for Acme Corp, $1,200, net 15". Show tool chips: lookup_customer, create_invoice, send_invoice. New row appears; audit timeline entry | "Tell it what you did. It looks up the client, creates the PayPal invoice through the Agent Toolkit and sends it. Each step is logged with why it was allowed." |
| 1:05-1:30 | Click "Run collections". Chips for propose_collections then several send_invoice_reminder. Expand one reminder: subject + note quoting the work and pay link. Reminders column updates | "Run collections: the agent applies the policy and writes a different reminder for each client, a final notice for Acme at 37 days, a gentle nudge for Northwind at 5." |
| 1:30-1:50 | Choose INV-0003 in "Simulate: client pays", click "Fire webhook". Row turns green; audit shows the webhook | "When a client pays, PayPal's webhook hits Chaser and the invoice is reconciled instantly." |
| 1:50-2:15 | Click "Reconcile payments". Transactions tab shows three UNMATCHED rows becoming matched; the agent's summary explains the $1,400 split across two invoices | "Three payments came in without an invoice link. The agent matches them, including a partial payment and one payment covering two invoices, and records them on PayPal." |
| 2:15-2:35 | Type "Refund $600 on INV-0007". Approval card appears with the policy reason; click Approve; chip turns green | "Outside the policy, it asks. A $600 refund is over my limit, so I get a card. I approve, and it finishes." |
| 2:35-2:50 | Click "Review disputes". $15 accepted; $480 shows "draft ready"; open Disputes tab and the evidence pack | "Disputes: the $15 one is accepted automatically, the $480 one gets an evidence pack drafted for me." |
| 2:50-2:58 | README prize table or architecture diagram, repo URL | "Invoices, payments, disputes, tracking, subscriptions, reporting: one agent, your rules. Built on the PayPal sandbox with the PayPal Agent Toolkit, the Vercel AI SDK and AG Grid." |

Recording notes: start from **Reset demo** so the numbers match; run `npm run dev` with a Gemini key for natural reminder copy (or without for the deterministic planner, which also works); keep the browser at 1440x900 so the drawer and grid both fit.

## C. What the user must do (in order)

1. **Devpost**: register at https://paypalaihackathon.devpost.com/register and click "Join hackathon".
2. **PayPal sandbox app**: https://developer.paypal.com/dashboard/applications/sandbox -> Create App (name `chaser-sandbox`, type Merchant) -> copy **Client ID** and **Secret** into `work/hackathons/paypal-chaser/.env.local` as `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`, set `MOCK_PAYPAL=0`. Do not paste them into chat. Note the sandbox *personal* account login under Testing Tools -> Sandbox Accounts (https://developer.paypal.com/dashboard/accounts) for paying invoices in the video.
3. **LLM key** (one): Google AI Studio https://aistudio.google.com/apikey (`GOOGLE_GENERATIVE_AI_API_KEY`) or Groq https://console.groq.com/keys (`GROQ_API_KEY`). Paste into `.env.local`.
4. **GitHub**: Claude creates the public repo `vigohan95/chaser` with `gh` (MIT license shows in About). Nothing for you to do if `gh auth status` is logged in as vigohan95.
5. **Vercel**: https://vercel.com/signup with GitHub -> Import `vigohan95/chaser` -> add environment variables (list below) -> Deploy. Hobby plan, no card.
6. **Webhook (optional but good for the video)**: Dashboard -> your sandbox app -> Add Webhook -> URL `https://<your-vercel-domain>/api/webhooks/paypal`, events `INVOICING.INVOICE.PAID`, `INVOICING.INVOICE.CANCELLED`, `PAYMENT.CAPTURE.COMPLETED`, `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.RESOLVED`, `BILLING.SUBSCRIPTION.ACTIVATED` -> copy the Webhook ID into `PAYPAL_WEBHOOK_ID`.
7. **YouTube**: upload the MP4 Claude renders, set Public, paste the link in Devpost.
8. **Devpost submission**: paste section A, upload gallery images, opt in to the sponsor prizes, submit before 2026-11-12 12:00 PST.

### Environment variables for Vercel

| Name | Value |
|---|---|
| `MOCK_PAYPAL` | `1` for the public demo (no sandbox calls from strangers), `0` for your own sandbox run |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | from step 2 (only if `MOCK_PAYPAL=0`) |
| `PAYPAL_WEBHOOK_ID` | from step 6 |
| `GOOGLE_GENERATIVE_AI_API_KEY` or `GROQ_API_KEY` | from step 3 (omit to use the keyless planner) |
| `CRON_SECRET` | any long random string |
| `MERCHANT_BUSINESS_NAME`, `MERCHANT_GIVEN_NAME`, `MERCHANT_SURNAME`, `MERCHANT_EMAIL` | how invoices are signed |

## D. Pre-submission checklist

- [ ] `npm test`, `npm run build`, `npm run lint` all green on the commit you submit
- [ ] Repo public; LICENSE visible in GitHub About; README has setup steps and the PayPal capability list
- [ ] No secrets in git (`git grep -i "client_secret\|api_key" -- ':!*.example' ':!*.md'` is empty)
- [ ] Vercel URL loads in a private window; "Reset demo" works
- [ ] Video < 3:00, Public, shows the app running end to end and says "sandbox"
- [ ] Devpost: tagline, about, built-with tags, links, video, 5 images, sponsor opt-ins, AI tools used
