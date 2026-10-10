/**
 * Model selection. All options are free tiers that need no card:
 *  - Google AI Studio (Gemini)          GOOGLE_GENERATIVE_AI_API_KEY
 *  - Groq                               GROQ_API_KEY
 *  - Nebius Token Factory (Nemotron)    NEBIUS_API_KEY (+ NEBIUS_BASE_URL, NEBIUS_MODEL)
 * With no key at all (or MOCK_LLM=1) the deterministic mock planner drives the same tools.
 */
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { isMockLlm } from "../env";
import { MockPlannerModel } from "./mock-model";

export function getModel(): LanguageModel {
  if (isMockLlm()) return new MockPlannerModel();
  const override = process.env.LLM_MODEL;
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY });
    return google(override ?? "gemini-2.5-flash");
  }
  if (process.env.GROQ_API_KEY) {
    const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
    return groq(override ?? "openai/gpt-oss-120b");
  }
  if (process.env.NEBIUS_API_KEY) {
    const nebius = createOpenAICompatible({
      name: "nebius",
      baseURL: process.env.NEBIUS_BASE_URL ?? "https://api.tokenfactory.nebius.com/v1",
      apiKey: process.env.NEBIUS_API_KEY,
    });
    return nebius(override ?? process.env.NEBIUS_MODEL ?? "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B");
  }
  return new MockPlannerModel();
}
