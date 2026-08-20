import type { ModelConfig } from "../server/types.js";

export function makeModel(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: "model-a",
    name: "Model A",
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKeyEnv: "TEST_PROVIDER_KEY",
    upstreamModel: "model-a",
    enabled: true,
    canRoute: true,
    supportsJsonMode: true,
    inputPricePerMillion: 0.2,
    outputPricePerMillion: 0.4,
    basePricePerMillion: 1,
    gammaPerMillion: 0.5,
    normalCapacity: 1_000,
    hardCapacity: 2_000,
    eta: 1,
    maxContextTokens: 128_000,
    capabilities: { vision: false, tools: true, json: true },
    quality: {
      coding: 0.9,
      math: 0.9,
      reasoning: 0.9,
      writing: 0.9,
      translation: 0.9,
      "general-qa": 0.9
    },
    qualitySource: "test",
    ...overrides
  };
}
