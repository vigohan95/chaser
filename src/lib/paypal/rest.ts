/**
 * Plain PayPal REST calls for the few endpoints the Agent Toolkit does not cover:
 * webhook signature verification and the Disputes API's provide-evidence / send-message.
 * Same sandbox app credentials as the toolkit; client-credentials OAuth.
 */
import { paypalEnv } from "../env";

let tokenCache: { key: string; token: string; exp: number } | undefined;

export function paypalBaseUrl(): string {
  return paypalEnv().sandbox ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
}

export async function getAccessToken(): Promise<string> {
  const { clientId, clientSecret, sandbox } = paypalEnv();
  const key = `${clientId}|${sandbox}`;
  if (tokenCache && tokenCache.key === key && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const res = await fetch(`${paypalBaseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal OAuth failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { key, token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

export class PayPalRestError extends Error {
  constructor(message: string, public readonly status: number, public readonly details?: unknown) {
    super(message);
  }
}

async function readError(res: Response): Promise<never> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = await res.text().catch(() => "");
  }
  const b = (body && typeof body === "object" ? body : {}) as { message?: string; name?: string; details?: Array<{ issue?: string; description?: string }> };
  const detail = (b.details ?? []).map((d) => d.description || d.issue || "").filter(Boolean).join("; ");
  throw new PayPalRestError(`${b.name ?? "PAYPAL_ERROR"} ${res.status}: ${b.message ?? ""}${detail ? ` (${detail})` : ""}`.trim(), res.status, body);
}

export type EvidenceType = "PROOF_OF_FULFILLMENT" | "PROOF_OF_DELIVERY" | "PROOF_OF_REFUND" | "ITEM_DESCRIPTION" | "COPY_OF_CONTRACT" | "OTHER";

export interface EvidenceSubmission {
  evidence_type: EvidenceType;
  /** Free text, max 2000 characters per the Disputes API. */
  notes: string;
  tracking?: { carrier_name: string; tracking_number: string };
}

export interface EvidenceResult {
  dispute_id: string;
  channel: "provide-evidence" | "send-message";
  status: number;
  links?: unknown;
}

/**
 * Disputes API, seller side. A dispute in the INQUIRY stage only accepts messages (send-message);
 * a claim (CHARGEBACK stage, status REQUIRED_ACTION) accepts evidence (provide-evidence, multipart/form-data
 * with an `input` JSON part and optional evidence files).
 */
export async function submitDisputeEvidence(disputeId: string, submission: EvidenceSubmission, stage: string | undefined, opts: { fetchImpl?: typeof fetch } = {}): Promise<EvidenceResult> {
  const f = opts.fetchImpl ?? fetch;
  const token = await getAccessToken();
  const base = `${paypalBaseUrl()}/v1/customer/disputes/${encodeURIComponent(disputeId)}`;
  const notes = submission.notes.slice(0, 2000);
  if (stage === "INQUIRY") {
    const res = await f(`${base}/send-message`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ message: notes }) });
    if (!res.ok) await readError(res);
    const data = (await res.json().catch(() => ({}))) as { links?: unknown };
    return { dispute_id: disputeId, channel: "send-message", status: res.status, links: data.links };
  }
  const evidence: Record<string, unknown> = { evidence_type: submission.evidence_type, notes };
  if (submission.tracking) evidence.evidence_info = { tracking_info: [submission.tracking] };
  const form = new FormData();
  form.append("input", new Blob([JSON.stringify({ evidences: [evidence] })], { type: "application/json" }), "input.json");
  const res = await f(`${base}/provide-evidence`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  if (!res.ok) await readError(res);
  const data = (await res.json().catch(() => ({}))) as { links?: unknown };
  return { dispute_id: disputeId, channel: "provide-evidence", status: res.status, links: data.links };
}

/** POST /v1/notifications/verify-webhook-signature. */
export async function verifyWebhookSignatureRest(headers: Headers, rawBody: string): Promise<{ ok: boolean; reason?: string }> {
  const { webhookId } = paypalEnv();
  if (!webhookId) return { ok: false, reason: "PAYPAL_WEBHOOK_ID is not set" };
  const h = (k: string) => headers.get(k) ?? "";
  try {
    const token = await getAccessToken();
    const res = await fetch(`${paypalBaseUrl()}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_algo: h("paypal-auth-algo"),
        cert_url: h("paypal-cert-url"),
        transmission_id: h("paypal-transmission-id"),
        transmission_sig: h("paypal-transmission-sig"),
        transmission_time: h("paypal-transmission-time"),
        webhook_id: webhookId,
        webhook_event: JSON.parse(rawBody),
      }),
    });
    const data = (await res.json()) as { verification_status?: string };
    return data.verification_status === "SUCCESS" ? { ok: true } : { ok: false, reason: `verification_status=${data.verification_status ?? res.status}` };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
