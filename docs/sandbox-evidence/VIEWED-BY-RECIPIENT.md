# Does PayPal tell us whether the client opened the invoice? (sandbox check, 2026-10-14)

**Question.** Chaser's viewed-aware chasing branches on whether the recipient has opened the invoice: a never-opened invoice is re-delivered with an address check instead of a firmer reminder. Before building it we checked what Invoicing v2 actually returns on a real sandbox account.

**Method.** `npx tsx scripts/sandbox-viewed-probe.ts` (reads `.env.local`; prints no credentials). For each of the 8 invoices created on 2026-10-10 it calls `GET /v2/invoicing/invoices/{id}` over plain REST with the app's own OAuth token, records the `paypal-debug-id` response header and `detail.viewed_by_recipient`, and runs the toolkit's `get_invoice` on the same id for comparison. Raw results: [`viewed-by-recipient-2026-10-14.json`](viewed-by-recipient-2026-10-14.json).

**Observed.**

| Invoice | Id | Status | HTTP | `paypal-debug-id` | `detail.viewed_by_recipient` |
|---|---|---|---|---|---|
| INV-0010 | `INV2-SUGV-GSTF-ZGG2-P5P8` | SENT | 200 | `ca4a38c505ebf` | present, `false` |
| INV-0009 | `INV2-LA6L-2CXN-UM83-A22N` | SENT | 200 | `ca4a38c541f38` | present, `false` |
| INV-0006 | `INV2-SW7C-XNJ3-BGBL-88RB` | PARTIALLY_PAID | 200 | `ca4a38c5919ec` | present, `false` |
| INV-0005 | `INV2-7X4S-X56G-UBX4-4EG6` | SENT | 200 | `ca4a38c5cdab5` | present, `false` |
| INV-0004 | `INV2-YBWC-KSCV-VAPR-9HPG` | SENT | 200 | `ca4a38c618c86` | present, `false` |
| INV-0003 | `INV2-N4JP-35BM-SKFL-4DVE` | SENT | 200 | `ca4a38c664fc7` | present, `false` |
| INV-0002 | `INV2-9YBQ-JNYE-L5MN-MQG4` | SENT | 200 | `ca4a38c69ef85` | present, `false` |
| INV-0001 | `INV2-RV76-J5VE-F7Z5-APL8` | SENT | 200 | `ca4a38c6dbfab` | present, `false` |

The same field, with the same value, comes back through the toolkit's `get_invoice` (it is the same REST resource), and it was already present in the raw `get_invoice` response saved on 2026-10-10 (`sandbox-run-2026-10-10-13-28-18.json`, `raw.get_invoice.detail.viewed_by_recipient: false`).

**Reading.** The field exists in Invoicing v2 and is returned on every invoice. It is `false` on all of ours for a mundane reason: the seed sends invoices to `*.example.com` recipients, so no human has ever opened a payer page. We did not find a sandbox-side way to flip it short of a real recipient opening the invoice link (the sandbox *personal* account can open the payer view; that is a user task, not something the agent should do). Even `INV-0006`, on which an external $800 payment was recorded by the seller, stays `false`: recording a payment is not a view.

**What Chaser does with it.**

- `src/lib/paypal/live.ts` maps `detail.viewed_by_recipient` to `Invoice.viewed_by_recipient` (`undefined` when a source does not carry it; the mock serializer emits the same field).
- Policy: `reminders.viewedAware` (default on), `reminders.unviewedAfterDays` (5), `reminders.unviewedStrategy` (`resend` | `ignore`).
- `planCollections` (`src/lib/agent/chase.ts`): when the field is `false` and the invoice is at least `unviewedAfterDays` overdue, the proposal's `channel` becomes `resend`: the reminder is still sent with `send_invoice_reminder` (which re-delivers the invoice email) and still counts against the stage and `maxReminders`, but the subject and body ask whether the invoice reached the right person and invite a corrected address, instead of pressing harder. When the field is `true` the firm / final drafts may say the invoice was opened. When the field is `undefined` nothing changes. The ledger cites `reminders.unviewedStrategy` with the days.
- Because every sandbox invoice is `false`, a "Run collections" against this sandbox re-delivers every overdue invoice rather than escalating tone. That is the correct behaviour for a book nobody has opened; it is also why the hosted demo (demo data, where most invoices are marked opened and a few are not) is the better place to see both branches side by side.

**Not claimed.** We have not observed `viewed_by_recipient: true` from PayPal. Whether it flips on the first open of the payer page or on something stricter, and how quickly, is documented by PayPal and not verified here; the code treats it as a boolean signal and nothing more.
