/**
 * Model selection. All options are free tiers that need no card:
 *  - Google AI Studio (Gemini)          GOOGLE_GENERATIVE_AI_API_KEY
 *  - Groq                               GROQ_API_KEY
 *  - Nebius Token Factory (Nemotron)    NEBIUS_API_KEY (+ NEBIUS_BASE_URL, NEBIUS_MODEL)
 * With several keys set, LLM_PROVIDER=nebius|google|groq picks one explicitly; otherwise the first key in the
 * order above wins. With no key at all (or MOCK_LLM=1) the deterministic mock planner drives the same tools.
 */
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { isMockLlm } from "../env";
import { MockPlannerModel } from "./mock-model";

export type Provider = "google" | "groq" | "nebius";
type Env = Record<string, string | undefined>;

export const NEBIUS_DEFAULT_MODEL = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";
export const NEBIUS_DEFAULT_BASE_URL = "https://api.tokenfactory.nebius.com/v1";

/** Which hosted provider is active, or undefined when the rule planner runs. */
export function activeProvider(env: Env = process.env): Provider | undefined {
  const forced = (env.LLM_PROVIDER ?? "").toLowerCase();
  const keyed: Record<Provider, boolean> = {
    google: !!env.GOOGLE_GENERATIVE_AI_API_KEY,
    groq: !!env.GROQ_API_KEY,
    nebius: !!env.NEBIUS_API_KEY,
  };
  if (forced === "google" || forced === "groq" || forced === "nebius") return keyed[forced] ? forced : undefined;
  return (["google", "groq", "nebius"] as Provider[]).find((p) => keyed[p]);
}

/** Model id the active provider will run (what the UI shows next to "model:"). */
export function activeModelId(env: Env = process.env): string | undefined {
  const p = activeProvider(env);
  if (!p) return undefined;
  if (env.LLM_MODEL) return env.LLM_MODEL;
  if (p === "google") return "gemini-2.5-flash";
  if (p === "groq") return "openai/gpt-oss-120b";
  return env.NEBIUS_MODEL ?? NEBIUS_DEFAULT_MODEL;
}

export function getModel(opts: { forceMock?: boolean } = {}): LanguageModel {
  if (opts.forceMock || isMockLlm()) return new MockPlannerModel();
  const provider = activeProvider();
  const modelId = activeModelId();
  if (provider === "google") {
    const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY });
    return google(modelId!);
  }
  if (provider === "groq") {
    const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
    return groq(modelId!);
  }
  if (provider === "nebius") {
    const nebius = createOpenAICompatible({
      name: "nebius",
      baseURL: process.env.NEBIUS_BASE_URL ?? NEBIUS_DEFAULT_BASE_URL,
      apiKey: process.env.NEBIUS_API_KEY,
    });
    return nebius(modelId!);
  }
  return new MockPlannerModel();
}
