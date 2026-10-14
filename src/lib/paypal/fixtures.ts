/**
 * Deterministic, realistic demo data for MOCK_PAYPAL=1.
 * Dates are relative to `now` so the overdue picture is always "live".
 */
import type {
  Client,
  Dispute,
  Invoice,
  InvoiceItem,
  Product,
  Subscription,
  SubscriptionPlan,
  Tracking,
  Transaction,
} from "./types";
import { round2 } from "./types";

export const CLIENTS: Record<string, Client> = {
  acme: { business: "Acme Corp", given_name: "Dana", surname: "Whitfield", email: "billing@acme.example" },
  bluebird: { business: "Bluebird Studio", given_name: "Priya", surname: "Natarajan", email: "hello@bluebird.example" },
  northwind: { business: "Northwind Traders", given_name: "Olu", surname: "Adeyemi", email: "ap@northwind.example" },
  harbor: { business: "Harbor & Finch LLP", given_name: "Marcus", surname: "Lee", email: "accounts@harborfinch.example" },
  juniper: { business: "Juniper Bakery", given_name: "Jen", surname: "Okafor", email: "jen@juniperbakery.example" },
  solstice: { business: "Solstice Fitness", given_name: "Tomas", surname: "Rivera", email: "ops@solsticefit.example" },
  pinecrest: { business: "Pinecrest Realty", given_name: "Amy", surname: "Chen", email: "amy@pinecrest.example" },
  vireo: { business: "Vireo Labs", given_name: "Sam", surname: "Patel", email: "finance@vireolabs.example" },
};

const DAY = 86_400_000;

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(now: Date, n: number): Date {
  return new Date(now.getTime() - n * DAY);
}

function sum(items: InvoiceItem[]): number {
  return round2(items.reduce((s, i) => s + i.quantity * i.unit_amount, 0));
}

export function invoiceId(n: number): string {
  const s = String(n).padStart(4, "0");
  return `INV2-CH${s}-MOCK-${s}-DEMO`;
}

/** 17-char upper-alnum id in the style of PayPal transaction ids, derived deterministically from a seed. */
export function txnId(seed: string): string {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  let out = "";
  let x = h;
  for (let i = 0; i < 17; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += alphabet[x % alphabet.length];
  }
  return out;
}

export function paypalFee(amount: number): number {
  return round2(amount * 0.0349 + 0.49);
}

interface Spec {
  n: number;
  client: keyof typeof CLIENTS;
  items: InvoiceItem[];
  issuedDaysAgo: number;
  net: number;
  status: Invoice["status"];
  paid?: number;
  /** For paid history: when the payment landed (drives days-to-pay / lateness in the payer profile). */
  paidDaysAgo?: number;
  refunded?: number;
  reminders?: Array<{ daysAgo: number; stage: "friendly" | "firm" | "final" }>;
  reference?: string;
  note?: string;
  /** A recorded promise to pay: pay_by relative to now (negative = already passed), recorded N days ago. */
  promise?: { payByInDays: number; recordedDaysAgo: number; amount?: number; quote: string };
}

const SPECS: Spec[] = [
  { n: 1, client: "acme", items: [{ name: "Website redesign - phase 1", description: "Homepage, pricing and docs templates", quantity: 1, unit_amount: 4800 }], issuedDaysAgo: 52, net: 15, status: "UNPAID", reminders: [{ daysAgo: 32, stage: "friendly" }], reference: "PO-7781" },
  { n: 2, client: "bluebird", items: [{ name: "Brand identity package", description: "Logo system, palette, type, guidelines PDF", quantity: 1, unit_amount: 2400 }], issuedDaysAgo: 30, net: 15, status: "UNPAID" },
  { n: 3, client: "northwind", items: [{ name: "Monthly design retainer", description: "September", quantity: 1, unit_amount: 1500 }], issuedDaysAgo: 20, net: 15, status: "UNPAID" },
  { n: 4, client: "harbor", items: [{ name: "Contract illustrations", description: "12 spot illustrations for client-facing guide", quantity: 12, unit_amount: 79.17 }], issuedDaysAgo: 16, net: 14, status: "UNPAID" },
  { n: 5, client: "juniper", items: [{ name: "Menu photography", description: "Half-day shoot + 40 edited images", quantity: 1, unit_amount: 600 }], issuedDaysAgo: 10, net: 30, status: "UNPAID" },
  { n: 6, client: "solstice", items: [{ name: "Landing page", description: "Design + Webflow build", quantity: 1, unit_amount: 1800 }], issuedDaysAgo: 40, net: 30, status: "PARTIALLY_PAID", paid: 800, promise: { payByInDays: 4, recordedDaysAgo: 3, quote: "Sent $800 today, the rest goes out next week once the board signs off." } },
  { n: 7, client: "pinecrest", items: [{ name: "Listing video", description: "Edit + color grade", quantity: 3, unit_amount: 700 }], issuedDaysAgo: 26, net: 14, status: "PAID", paid: 2100 },
  { n: 8, client: "vireo", items: [{ name: "API integration sprint", description: "2-week sprint, Stripe to PayPal migration", quantity: 1, unit_amount: 3200 }], issuedDaysAgo: 39, net: 14, status: "PAID", paid: 3200 },
  { n: 9, client: "acme", items: [{ name: "SEO audit", quantity: 1, unit_amount: 750 }], issuedDaysAgo: 8, net: 15, status: "UNPAID" },
  { n: 10, client: "bluebird", items: [{ name: "Social media templates", description: "Canva pack, 24 layouts", quantity: 1, unit_amount: 420 }], issuedDaysAgo: 45, net: 15, status: "UNPAID", reminders: [{ daysAgo: 26, stage: "friendly" }, { daysAgo: 18, stage: "firm" }] },
  { n: 11, client: "northwind", items: [{ name: "Logo refresh", description: "Includes printed brand book (shipped)", quantity: 1, unit_amount: 1200 }], issuedDaysAgo: 55, net: 15, status: "PAID", paid: 1200 },
  { n: 12, client: "juniper", items: [{ name: "Holiday campaign - deposit", quantity: 1, unit_amount: 300 }], issuedDaysAgo: 6, net: 7, status: "UNPAID" },
  { n: 13, client: "harbor", items: [{ name: "Court exhibit graphics", description: "Timeline + 4 diagrams", quantity: 1, unit_amount: 1350 }], issuedDaysAgo: 35, net: 30, status: "UNPAID" },
  { n: 14, client: "solstice", items: [{ name: "Email sequence", description: "5-email onboarding flow", quantity: 1, unit_amount: 640 }], issuedDaysAgo: 28, net: 15, status: "UNPAID", promise: { payByInDays: -5, recordedDaysAgo: 11, quote: "Will pay the email sequence invoice by Friday, sorry for the delay." } },
  { n: 15, client: "vireo", items: [{ name: "Dashboard wireframes", quantity: 1, unit_amount: 900 }], issuedDaysAgo: 22, net: 15, status: "UNPAID" },
  { n: 16, client: "vireo", items: [{ name: "User interviews", description: "5 sessions + synthesis", quantity: 1, unit_amount: 500 }], issuedDaysAgo: 22, net: 15, status: "UNPAID" },
  { n: 17, client: "pinecrest", items: [{ name: "Drone footage", description: "2 properties", quantity: 1, unit_amount: 1100 }], issuedDaysAgo: 1, net: 14, status: "DRAFT" },
  { n: 18, client: "juniper", items: [{ name: "Rush fee", quantity: 1, unit_amount: 15 }], issuedDaysAgo: 18, net: 7, status: "PAID", paid: 15 },
  { n: 19, client: "solstice", items: [{ name: "Team workshop", description: "Half-day brand workshop", quantity: 1, unit_amount: 480 }], issuedDaysAgo: 24, net: 7, status: "PAID", paid: 480 },
  { n: 20, client: "pinecrest", items: [{ name: "Photo retouching", quantity: 1, unit_amount: 320 }], issuedDaysAgo: 48, net: 14, status: "PARTIALLY_REFUNDED", paid: 320, refunded: 120 },
  // Older paid invoices: the payer history the predictions and the adaptive cadence are computed from.
  { n: 21, client: "acme", items: [{ name: "Landing page copy", description: "Hero, features, FAQ", quantity: 1, unit_amount: 1100 }], issuedDaysAgo: 95, net: 15, status: "PAID", paid: 1100, paidDaysAgo: 65, reminders: [{ daysAgo: 75, stage: "friendly" }, { daysAgo: 68, stage: "firm" }] },
  { n: 22, client: "acme", items: [{ name: "Icon set", description: "48 product icons, 3 weights", quantity: 1, unit_amount: 640 }], issuedDaysAgo: 130, net: 15, status: "PAID", paid: 640, paidDaysAgo: 103, reminders: [{ daysAgo: 110, stage: "friendly" }] },
  { n: 23, client: "bluebird", items: [{ name: "Pitch deck", description: "22 slides, investor version", quantity: 1, unit_amount: 900 }], issuedDaysAgo: 80, net: 15, status: "PAID", paid: 900, paidDaysAgo: 56, reminders: [{ daysAgo: 61, stage: "friendly" }] },
  { n: 24, client: "bluebird", items: [{ name: "Event banners", description: "3 roll-up banners, print-ready", quantity: 1, unit_amount: 380 }], issuedDaysAgo: 115, net: 15, status: "PAID", paid: 380, paidDaysAgo: 94, reminders: [{ daysAgo: 96, stage: "friendly" }] },
];

/** First invoice sequence number the mock `create_invoice` hands out (demo data uses 1..FIRST_FREE_SEQ-1). */
export const FIRST_FREE_SEQ = SPECS.length + 1;

export function buildInvoices(now: Date): Invoice[] {
  return SPECS.map((s) => {
    const total = sum(s.items);
    const paid = s.paid ?? 0;
    const refunded = s.refunded ?? 0;
    const issued = daysAgo(now, s.issuedDaysAgo);
    const due = new Date(issued.getTime() + s.net * DAY);
    const id = invoiceId(s.n);
    const number = `INV-${String(s.n).padStart(4, "0")}`;
    return {
      id,
      invoice_number: number,
      status: s.status,
      client: CLIENTS[s.client],
      items: s.items,
      currency: "USD",
      total,
      paid,
      refunded,
      due: s.status === "DRAFT" || s.status === "CANCELLED" ? total : round2(Math.max(0, total - paid)),
      invoice_date: isoDate(issued),
      due_date: isoDate(due),
      reference: s.reference,
      note: s.note,
      paid_at: s.paidDaysAgo !== undefined ? isoDate(daysAgo(now, s.paidDaysAgo)) : undefined,
      promise: s.promise ? { pay_by: isoDate(daysAgo(now, -s.promise.payByInDays)), amount: s.promise.amount, balance_at_record: round2(Math.max(0, total - paid)), recorded_at: daysAgo(now, s.promise.recordedDaysAgo).toISOString(), source: "client_reply" as const, quote: s.promise.quote } : undefined,
      reminders: (s.reminders ?? []).map((r) => ({ at: daysAgo(now, r.daysAgo).toISOString(), stage: r.stage })),
      chase_override: "default",
      links: {
        view: `https://www.sandbox.paypal.com/invoice/p/#${id}`,
        pay: `https://www.sandbox.paypal.com/invoice/payerView/details/${id}`,
      },
    };
  });
}

export function buildTransactions(now: Date, invoices: Invoice[]): Transaction[] {
  const byNumber = (n: number) => invoices.find((i) => i.invoice_number === `INV-${String(n).padStart(4, "0")}`)!;
  const pay = (
    seed: string,
    inv: Invoice | undefined,
    client: Client,
    amount: number,
    days: number,
    memo?: string,
  ): Transaction => ({
    id: txnId(seed),
    date: daysAgo(now, days).toISOString(),
    type: "PAYMENT",
    amount,
    fee: paypalFee(amount),
    currency: "USD",
    status: "S",
    payer_email: client.email,
    payer_name: `${client.given_name} ${client.surname}`,
    memo,
    invoice_id: inv?.id,
    capture_id: txnId(seed + "-cap"),
  });
  return [
    pay("t7", byNumber(7), CLIENTS.pinecrest, 2100, 12, "INV-0007"),
    pay("t8", byNumber(8), CLIENTS.vireo, 3200, 25, "INV-0008"),
    pay("t11", byNumber(11), CLIENTS.northwind, 1200, 40, "Logo refresh"),
    pay("t6", byNumber(6), CLIENTS.solstice, 800, 9, "Landing page - first half"),
    pay("t18", byNumber(18), CLIENTS.juniper, 15, 15),
    pay("t19", byNumber(19), CLIENTS.solstice, 480, 20, "Workshop"),
    pay("t20", byNumber(20), CLIENTS.pinecrest, 320, 46),
    pay("t21", byNumber(21), CLIENTS.acme, 1100, 65, "INV-0021 sorry for the delay"),
    pay("t22", byNumber(22), CLIENTS.acme, 640, 103, "Icon set"),
    pay("t23", byNumber(23), CLIENTS.bluebird, 900, 56, "INV-0023"),
    pay("t24", byNumber(24), CLIENTS.bluebird, 380, 94),
    {
      id: txnId("r20"),
      date: daysAgo(now, 30).toISOString(),
      type: "REFUND",
      amount: -120,
      fee: -round2(120 * 0.0349),
      currency: "USD",
      status: "S",
      payer_email: CLIENTS.pinecrest.email,
      payer_name: "Amy Chen",
      memo: "Partial refund - one image unusable",
      invoice_id: byNumber(20).id,
    },
    // Unmatched payments: PayPal did not link these to an invoice (client paid via Send Money)
    pay("u13", undefined, CLIENTS.harbor, 1350, 2, "Exhibit graphics - thanks Han"),
    pay("u14", undefined, CLIENTS.solstice, 300, 3, "part payment, rest next week"),
    pay("u15", undefined, CLIENTS.vireo, 1400, 1, "Oct invoices (wireframes + interviews)"),
  ];
}

export function buildDisputes(now: Date, invoices: Invoice[], transactions: Transaction[]): Dispute[] {
  const inv18 = invoices.find((i) => i.invoice_number === "INV-0018")!;
  const inv19 = invoices.find((i) => i.invoice_number === "INV-0019")!;
  const t18 = transactions.find((t) => t.invoice_id === inv18.id)!;
  const t19 = transactions.find((t) => t.invoice_id === inv19.id)!;
  return [
    {
      id: "PP-D-MOCK-00015",
      transaction_id: t18.id,
      invoice_id: inv18.id,
      amount: 15,
      currency: "USD",
      reason: "UNAUTHORISED",
      status: "OPEN_INQUIRIES",
      life_cycle_stage: "INQUIRY",
      created: daysAgo(now, 2).toISOString(),
      seller_response_due: daysAgo(now, -8).toISOString(),
      buyer_email: CLIENTS.juniper.email,
      buyer_name: "Jen Okafor",
    },
    {
      id: "PP-D-MOCK-00480",
      transaction_id: t19.id,
      invoice_id: inv19.id,
      amount: 480,
      currency: "USD",
      reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      status: "REQUIRED_ACTION",
      life_cycle_stage: "CHARGEBACK",
      created: daysAgo(now, 4).toISOString(),
      seller_response_due: daysAgo(now, -6).toISOString(),
      buyer_email: CLIENTS.solstice.email,
      buyer_name: "Tomas Rivera",
    },
  ];
}

export function buildTrackings(now: Date, invoices: Invoice[], transactions: Transaction[]): Tracking[] {
  const inv11 = invoices.find((i) => i.invoice_number === "INV-0011")!;
  const t11 = transactions.find((t) => t.invoice_id === inv11.id)!;
  return [
    {
      transaction_id: t11.id,
      invoice_id: inv11.id,
      tracking_number: "1Z999AA10123456784",
      carrier: "UPS",
      status: "DELIVERED",
      shipped_at: daysAgo(now, 36).toISOString(),
    },
  ];
}

export function buildProducts(): Product[] {
  return [{ id: "PROD-MOCK-RETAINER", name: "Monthly design retainer", type: "SERVICE", description: "Up to 20 hours of design work per month" }];
}

export function buildPlans(): SubscriptionPlan[] {
  return [
    {
      id: "P-MOCK-RETAINER-1500",
      product_id: "PROD-MOCK-RETAINER",
      name: "Design retainer - $1,500/month",
      amount: 1500,
      currency: "USD",
      interval_unit: "MONTH",
      interval_count: 1,
      status: "ACTIVE",
    },
  ];
}

export function buildSubscriptions(): Subscription[] {
  return [];
}
