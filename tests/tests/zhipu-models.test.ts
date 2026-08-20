import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../server/config.js";
import { routeRequest } from "../server/pqcap.js";
import type { RequestProfile } from "../server/types.js";

const models = [
  ["glm-direct", "GLM_5_2_MODEL", "glm-5.2"],
  ["glm-5.1-direct", "GLM_5_1_MODEL", "glm-5.1"],
  ["glm-5-direct", "GLM_5_MODEL", "glm-5"],
  ["glm-5-turbo-direct", "GLM_5_TURBO_MODEL", "glm-5-turbo"],
  ["glm-4.7-direct", "GLM_4_7_MODEL", "glm-4.7"],
  ["glm-4.6-direct", "GLM_4_6_MODEL", "glm-4.6"]
] as const;

type ModelEnv = (typeof models)[number][1];
const initialEnv = new Map<ModelEnv, string | undefined>(
  models.map(([, envName]) => [envName, process.env[envName]])
);

afterEach(() => {
  for (const [envName, value] of initialEnv) {
    if (value === undefined) delete process.env[envName];
    else process.env[envName] = value;
  }
});

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

describe("Zhipu text models", () => {
  it.each(models)("loads %s from %s", (modelId, envName, defaultModel) => {
    const config = loadConfig();
    const model = config.models.find((candidate) => candidate.id === modelId);
    expect(model).toMatchObject({
      provider: "openai-compatible",
      apiKeyEnv: "GLM_API_KEY",
      baseUrlEnv: "GLM_BASE_URL",
      upstreamModelEnv: envName,
      upstreamModel: initialEnv.get(envName)?.trim() || defaultModel,
      enabled: true,
      canRoute: true
    });
    expect(model!.basePricePerMillion * model!.eta)
      .toBeCloseTo(model!.outputPricePerMillion!, 12);
  });

  it("loads independent environment overrides for all six models", () => {
    for (const [, envName] of models) process.env[envName] = `override-${envName.toLowerCase()}`;
    const config = loadConfig();
    for (const [modelId, envName] of models) {
      expect(config.models.find((model) => model.id === modelId)?.upstreamModel)
        .toBe(`override-${envName.toLowerCase()}`);
    }
  });

  it.each(models)("can select %s through the fixed-model route", (modelId) => {
    const config = loadConfig();
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
  });

  it("keeps DeepSeek Flash as the first-layer router", () => {
    const config = loadConfig();
    expect(config.routerModelId).toBe("deepseek-direct");
    expect(config.models.find((model) => model.id === config.routerModelId)?.upstreamModelEnv)
      .toBe("DEEPSEEK_FLASH_MODEL");
  });
});
