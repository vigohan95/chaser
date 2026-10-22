/** Runtime environment helpers. Evaluated at call time so Next.js never bakes them in at build. */

export function hasPayPalCredentials(): boolean {
  return !!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_CLIENT_SECRET;
}

/** Sandbox needs credentials; without them (or with MOCK_PAYPAL=1) the built-in mock serves demo data. */
export function isMockPayPal(): boolean {
  if (process.env.MOCK_PAYPAL === "1") return true;
  return !hasPayPalCredentials();
}

/** True when the operator asked for the sandbox (MOCK_PAYPAL=0) but no credentials are set yet. */
export function sandboxRequestedWithoutCredentials(): boolean {
  return process.env.MOCK_PAYPAL === "0" && !hasPayPalCredentials();
}

export function isMockLlm(): boolean {
  if (process.env.MOCK_LLM === "1") return true;
  if (process.env.MOCK_LLM === "0") return false;
  const forced = (process.env.LLM_PROVIDER ?? "").toLowerCase();
  if (forced === "google") return !process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (forced === "groq") return !process.env.GROQ_API_KEY;
  if (forced === "nebius") return !process.env.NEBIUS_API_KEY;
  return !(
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.NEBIUS_API_KEY
  );
}

export function paypalEnv() {
  return {
    clientId: process.env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
    sandbox: (process.env.PAYPAL_ENVIRONMENT ?? "sandbox").toLowerCase() !== "live",
    webhookId: process.env.PAYPAL_WEBHOOK_ID ?? "",
  };
}

export function merchantProfile() {
  const email = process.env.MERCHANT_EMAIL || "sb-merchant@business.example.com";
  return {
    businessName: process.env.MERCHANT_BUSINESS_NAME || "Vigo Design Studio",
    givenName: process.env.MERCHANT_GIVEN_NAME || "Han",
    surname: process.env.MERCHANT_SURNAME || "Vigo",
    email,
    /**
     * Invoicing v2 rejects an invoicer email that is not the PayPal account's own ("User is not associated with
     * paypal based on invoicer email", 422). A placeholder / example address is therefore omitted from create_invoice
     * and PayPal fills in the account email itself.
     */
    invoicerEmail: /\.example(\.com)?$/i.test(email) ? undefined : email,
    currency: process.env.MERCHANT_CURRENCY || "USD",
  };
}
