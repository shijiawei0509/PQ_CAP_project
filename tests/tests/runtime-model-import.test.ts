import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildImportedModel,
  buildQuality,
  buildRuntimeConfig,
  parseCsv,
  serializeRuntimeConfig
} from "../scripts/build-runtime-models.js";

const rootDir = path.resolve(process.cwd());

describe("runtime OpenRouter model import", () => {
  it("maps grouped benchmarks and falls back to aggregate deterministically", () => {
    const { quality, source } = buildQuality({
      openrouter_model_id: "test/model",
      match_method: "openrouter_id_exact",
      openevals_aggregate_score: "40",
      openevals_swePro_score: "50",
      openevals_sweVerified_score: "70",
      openevals_terminalBench_score: "",
      openevals_aime2026_score: "",
      openevals_hmmt2026_score: "",
      openevals_gsm8k_score: "",
      openevals_gpqa_score: "80",
      openevals_hle_score: "20",
      openevals_evasionBench_score: "",
      openevals_mmluPro_score: "60"
    });

    expect(quality).toEqual({
      coding: 0.6,
      math: 0.4,
      reasoning: 0.5,
      writing: 0.4,
      translation: 0.4,
      "general-qa": 0.6
    });
    expect(source).toContain("aggregate fallback=math");
  });

  it("reproduces the collected input and output prices with base price and eta", () => {
    const match = {
      openrouter_model_id: "test/model",
      openrouter_name: "Test Model",
      match_method: "openrouter_id_exact",
      openevals_aggregate_score: "50"
    };
    const catalog = {
      openrouter_model_id: "test/model",
      prompt_usd_per_million_tokens: "0.25",
      completion_usd_per_million_tokens: "1.5",
      context_length: "128000",
      supports_tools: "true",
      supports_structured_outputs: "false",
      supports_response_format: "true",
      input_modalities: "text|image",
      name: "Test Model"
    };
    const model = buildImportedModel(match, catalog);

    expect(model.basePricePerMillion).toBe(0.25);
    expect(model.eta).toBe(6);
    expect(model.basePricePerMillion * model.eta).toBe(1.5);
    expect(model.capabilities).toEqual({ vision: true, tools: true, json: true });
  });

  it("builds 10 preserved direct models and 35 strictly matched OpenRouter models", () => {
    const config = buildRuntimeConfig(rootDir);
    const imported = config.models.filter((model) => model.provider === "openrouter");

    expect(config.models).toHaveLength(45);
    expect(config.models.slice(0, 10).map((model) => model.id)).toEqual([
      "deepseek-direct",
      "deepseek-pro-direct",
      "glm-direct",
      "glm-5.1-direct",
      "glm-5-direct",
      "glm-5-turbo-direct",
      "glm-4.7-direct",
      "glm-4.6-direct",
      "qwen-platform:kimi-k2.7-code",
      "qwen-platform:qwen3.7-plus"
    ]);
    expect(imported).toHaveLength(35);
    expect(new Set(config.models.map((model) => model.id))).toHaveLength(45);
    for (const model of imported) {
      expect(model.basePricePerMillion).toBe(model.inputPricePerMillion);
      expect(model.basePricePerMillion * model.eta).toBeCloseTo(model.outputPricePerMillion!, 12);
      expect(Object.values(model.quality).every((value) => value >= 0 && value <= 1)).toBe(true);
      expect(model).toMatchObject({ normalCapacity: 32_000, hardCapacity: 52_000, gammaPerMillion: 0.5 });
    }
  });

  it("serializes deterministically", () => {
    const first = serializeRuntimeConfig(rootDir);
    const second = serializeRuntimeConfig(rootDir);
    expect(first).toBe(second);
    expect(parseCsv("a,b\n1,2\n")).toEqual([{ a: "1", b: "2" }]);
    expect(JSON.parse(first).models).toHaveLength(45);
    expect(fs.existsSync(path.join(rootDir, "models.json"))).toBe(true);
  });
});
