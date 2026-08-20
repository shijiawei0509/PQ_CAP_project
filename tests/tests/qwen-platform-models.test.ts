import { describe, expect, it } from "vitest";
import { loadConfig } from "../server/config.js";
import { routeRequest } from "../server/pqcap.js";
import type { RequestProfile } from "../server/types.js";

const profile: RequestProfile = {
  taskType: "coding",
  difficulty: "hard",
  requirements: {
    minContextTokens: 1,
    needsVision: false,
    needsTools: false,
    needsJsonOutput: false,
    contextPattern: "single"
  },
  confidence: 1,
  source: "manual"
};

describe("DashScope direct models", () => {
  const config = loadConfig();

  it.each([
    ["qwen-platform:kimi-k2.7-code", "kimi-k2.7-code"],
    ["qwen-platform:qwen3.7-plus", "qwen3.7-plus"]
  ])("loads %s as a routable shared-provider model", (modelId, upstreamModel) => {
    const model = config.models.find((candidate) => candidate.id === modelId);
    expect(model).toMatchObject({
      provider: "openai-compatible",
      apiKeyEnv: "Qwen_platform_API_KEY",
      baseUrlEnv: "Qwen_platform_BASE_URL",
      upstreamModel,
      enabled: true,
      canRoute: true
    });
    expect(model!.basePricePerMillion * model!.eta).toBeCloseTo(model!.outputPricePerMillion!, 12);
  });

  it("can select each new model through the fixed-model route", () => {
    for (const modelId of ["qwen-platform:kimi-k2.7-code", "qwen-platform:qwen3.7-plus"]) {
      const decision = routeRequest({
        models: config.models,
        loads: new Map(),
        profile,
        preference: { mode: "fixed", fixedModelId: modelId, fixedFallback: "unavailable" },
        prompt: "Implement a bounded FIFO queue.",
        maxOutputTokens: 128,
        configuredOverride: new Set([modelId])
      });
      expect(decision.selectedModelId).toBe(modelId);
    }
  });
});
