import { describe, expect, it } from "vitest";
import { activeModelId, activeProvider, NEBIUS_DEFAULT_MODEL } from "../src/lib/llm";

describe("provider selection", () => {
  it("falls back to the first key in google > groq > nebius order", () => {
    expect(activeProvider({ GOOGLE_GENERATIVE_AI_API_KEY: "g", NEBIUS_API_KEY: "n" })).toBe("google");
    expect(activeProvider({ GROQ_API_KEY: "q", NEBIUS_API_KEY: "n" })).toBe("groq");
    expect(activeProvider({ NEBIUS_API_KEY: "n" })).toBe("nebius");
    expect(activeProvider({})).toBeUndefined();
  });
  it("LLM_PROVIDER forces a provider only when its key is present", () => {
    expect(activeProvider({ LLM_PROVIDER: "nebius", GOOGLE_GENERATIVE_AI_API_KEY: "g", NEBIUS_API_KEY: "n" })).toBe("nebius");
    expect(activeProvider({ LLM_PROVIDER: "NEBIUS", GOOGLE_GENERATIVE_AI_API_KEY: "g", NEBIUS_API_KEY: "n" })).toBe("nebius");
    expect(activeProvider({ LLM_PROVIDER: "nebius", GOOGLE_GENERATIVE_AI_API_KEY: "g" })).toBeUndefined();
  });
  it("reports the Nemotron model id that will actually run", () => {
    expect(activeModelId({ LLM_PROVIDER: "nebius", NEBIUS_API_KEY: "n" })).toBe(NEBIUS_DEFAULT_MODEL);
    expect(activeModelId({ NEBIUS_API_KEY: "n", NEBIUS_MODEL: "nvidia/nemotron-3-super-120b-a12b" })).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(activeModelId({ NEBIUS_API_KEY: "n", LLM_MODEL: "x/y" })).toBe("x/y");
    expect(activeModelId({})).toBeUndefined();
  });
});
