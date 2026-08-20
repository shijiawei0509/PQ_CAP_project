import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../server/config.js";
import { routeRequest } from "../server/pqcap.js";
import type { RequestProfile } from "../server/types.js";

const initialFlashModel = process.env.DEEPSEEK_FLASH_MODEL;
const initialProModel = process.env.DEEPSEEK_PRO_MODEL;

function restoreEnv(name: "DEEPSEEK_FLASH_MODEL" | "DEEPSEEK_PRO_MODEL", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv("DEEPSEEK_FLASH_MODEL", initialFlashModel);
  restoreEnv("DEEPSEEK_PRO_MODEL", initialProModel);
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

describe("DeepSeek direct models", () => {
  it("keeps Flash as the first-layer router and exposes Pro as a routable candidate", () => {
    const config = loadConfig();
    expect(config.routerModelId).toBe("deepseek-direct");
    expect(config.models.find((model) => model.id === "deepseek-direct")).toMatchObject({
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseUrlEnv: "DEEPSEEK_BASE_URL",
      upstreamModelEnv: "DEEPSEEK_FLASH_MODEL",
      upstreamModel: initialFlashModel?.trim() || "deepseek-v4-flash",
      enabled: true,
      canRoute: true
    });
    expect(config.models.find((model) => model.id === "deepseek-pro-direct")).toMatchObject({
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseUrlEnv: "DEEPSEEK_BASE_URL",
      upstreamModelEnv: "DEEPSEEK_PRO_MODEL",
      upstreamModel: initialProModel?.trim() || "deepseek-v4-pro",
      enabled: true,
      canRoute: true
    });
  });

  it("loads Flash and Pro model names from their independent environment variables", () => {
    process.env.DEEPSEEK_FLASH_MODEL = "flash-env-override";
    process.env.DEEPSEEK_PRO_MODEL = "pro-env-override";

    const config = loadConfig();
    expect(config.models.find((model) => model.id === "deepseek-direct")?.upstreamModel)
      .toBe("flash-env-override");
    expect(config.models.find((model) => model.id === "deepseek-pro-direct")?.upstreamModel)
      .toBe("pro-env-override");
  });

  it.each(["deepseek-direct", "deepseek-pro-direct"])(
    "can select %s through the fixed-model route",
    (modelId) => {
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
    }
  );
});
