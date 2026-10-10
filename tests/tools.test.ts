import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { localTools } from "@/lib/agent/local-tools";
import { buildTools, PAYPAL_TOOL_NAMES } from "@/lib/agent/tools";
import { getRawTools } from "@/lib/paypal/live";

const tools = buildTools();
const schema = (name: string) => (tools[name] as { inputSchema: z.ZodTypeAny }).inputSchema;

describe("tool set", () => {
  it("re-wraps every selected PayPal Agent Toolkit tool with its original schema and description", () => {
    const raw = getRawTools();
    expect(Object.keys(raw).length).toBeGreaterThanOrEqual(40);
    for (const name of PAYPAL_TOOL_NAMES) {
      expect(raw[name], name).toBeDefined();
      expect(tools[name], name).toBeDefined();
      expect(tools[name].description).toBe(raw[name].description);
      expect(schema(name)).toBe(raw[name].parameters);
      expect(typeof tools[name].execute).toBe("function");
    }
  });
  it("includes the local planning tools", () => {
    for (const name of Object.keys(localTools)) expect(tools[name]).toBeDefined();
  });
});

describe("tool schemas", () => {
  it("create_invoice accepts the shape the agent sends and rejects missing items", () => {
    const ok = schema("create_invoice").safeParse({
      currency_code: "USD",
      invoice_date: "2026-10-08",
      note: "Net 15",
      primary_recipients: [{ billing_info: { business_name: "Acme Corp", name: { given_name: "Dana", surname: "Whitfield" }, email_address: "billing@acme.example" } }],
      items: [{ name: "Logo package", quantity: "1", unit_amount: { currency_code: "USD", value: "1200.00" } }],
    });
    expect(ok.success, JSON.stringify(ok)).toBe(true);
    // toolkit quirks worth knowing: quantity is a string, money values are decimal strings
    expect(schema("create_invoice").safeParse({ currency_code: "USD", primary_recipients: [{ billing_info: { email_address: "a@b.c" } }], items: [{ name: "x", quantity: 1, unit_amount: { currency_code: "USD", value: "1.00" } }] }).success).toBe(false);
    expect(schema("create_invoice").safeParse({ currency_code: "USD", primary_recipients: [] }).success).toBe(false);
  });
  it("reminders need an invoice id; disputes need a note without spaces (toolkit regex)", () => {
    expect(schema("send_invoice_reminder").safeParse({ invoice_id: "INV2-1", subject: "s", note: "n" }).success).toBe(true);
    expect(schema("send_invoice_reminder").safeParse({ subject: "s" }).success).toBe(false);
    expect(schema("accept_dispute_claim").safeParse({ dispute_id: "PP-D-1", note: "Accepted_per_policy" }).success).toBe(true);
    expect(schema("accept_dispute_claim").safeParse({ dispute_id: "PP-D-1", note: "accepted per policy" }).success).toBe(false);
    expect(schema("accept_dispute_claim").safeParse({ dispute_id: "PP-D-1" }).success).toBe(false);
  });
  it("record_payment_for_invoice constrains the method enum", () => {
    expect(schema("record_payment_for_invoice").safeParse({ invoice_id: "x", method: "PAYPAL", amount: { currency_code: "USD", value: "10.00" } }).success).toBe(true);
    expect(schema("record_payment_for_invoice").safeParse({ invoice_id: "x", method: "VENMO" }).success).toBe(false);
  });
  it("tracking requires a transaction and tracking number", () => {
    expect(schema("create_shipment_tracking").safeParse({ transaction_id: "8AB12345CD678901E", tracking_number: "1Z999AA10123456784", carrier: "UPS" }).success).toBe(true);
    expect(schema("create_shipment_tracking").safeParse({ transaction_id: "T", tracking_number: "1Z" }).success).toBe(false); // transaction ids are 12-255 chars
    expect(schema("create_shipment_tracking").safeParse({ tracking_number: "1Z" }).success).toBe(false);
    expect(schema("create_refund").safeParse({ capture_id: "8AB12345CD678901E", amount: { currency_code: "USD", value: "10.00" } }).success).toBe(true);
  });
  it("local tools validate their input", () => {
    expect(schema("set_chase_override").safeParse({ invoice_id: "INV-0001", override: "paused" }).success).toBe(true);
    expect(schema("set_chase_override").safeParse({ invoice_id: "INV-0001", override: "nuke" }).success).toBe(false);
    expect(schema("lookup_customer").safeParse({}).success).toBe(false);
    expect(schema("propose_collections").safeParse({ invoice_ids: ["INV-0001"] }).success).toBe(true);
  });
});
