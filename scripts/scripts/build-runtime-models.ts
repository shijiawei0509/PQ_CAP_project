import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelConfig } from "../server/types.js";

const SNAPSHOT_DATE = "2026-07-18";
const MATCH_COUNT = 35;
const DIRECT_MODEL_IDS = [
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
] as const;
const QUALITY_FIELDS = {
  coding: ["openevals_swePro_score", "openevals_sweVerified_score", "openevals_terminalBench_score"],
  math: ["openevals_aime2026_score", "openevals_hmmt2026_score", "openevals_gsm8k_score"],
  reasoning: ["openevals_gpqa_score", "openevals_hle_score", "openevals_evasionBench_score"],
  "general-qa": ["openevals_mmluPro_score"]
} as const;

type CsvRow = Record<string, string>;

export function parseCsv(text: string): CsvRow[] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/u, ""));
      records.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field || row.length) {
    row.push(field);
    records.push(row);
  }
  const headers = records.shift() ?? [];
  return records
    .filter((record) => record.some((value) => value !== ""))
    .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""])));
}

function requiredNumber(value: string, field: string, modelId: string, options?: { integer?: boolean }): number {
  const parsed = Number(value);
  if (!value || !Number.isFinite(parsed) || parsed <= 0 || (options?.integer && !Number.isInteger(parsed))) {
    throw new Error(`${modelId}: invalid ${field}`);
  }
  return parsed;
}

function score(value: string, field: string, modelId: string): number | undefined {
  if (value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${modelId}: invalid ${field}`);
  }
  return parsed;
}

function normalized(value: number): number {
  return Number((value / 100).toFixed(6));
}

export function buildQuality(row: CsvRow): { quality: ModelConfig["quality"]; source: string } {
  const modelId = row.openrouter_model_id || "unknown-model";
  const aggregate = score(row.openevals_aggregate_score, "openevals_aggregate_score", modelId);
  if (aggregate === undefined) throw new Error(`${modelId}: missing openevals_aggregate_score`);
  const fallbackDimensions: string[] = [];

  const grouped = Object.fromEntries(Object.entries(QUALITY_FIELDS).map(([taskType, fields]) => {
    const values = fields
      .map((field) => score(row[field] ?? "", field, modelId))
      .filter((value): value is number => value !== undefined);
    if (!values.length) fallbackDimensions.push(taskType);
    const value = values.length
      ? values.reduce((sum, current) => sum + current, 0) / values.length
      : aggregate;
    return [taskType, normalized(value)];
  })) as Pick<ModelConfig["quality"], "coding" | "math" | "reasoning" | "general-qa">;

  const fallback = fallbackDimensions.length ? fallbackDimensions.join(",") : "none";
  return {
    quality: {
      coding: grouped.coding,
      math: grouped.math,
      reasoning: grouped.reasoning,
      writing: normalized(aggregate),
      translation: normalized(aggregate),
      "general-qa": grouped["general-qa"]
    },
    source: `OpenEvals/OpenRouter ${row.match_method} (${SNAPSHOT_DATE}); grouped benchmarks; aggregate dimensions=writing,translation; aggregate fallback=${fallback}`
  };
}

function booleanField(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`invalid boolean value: ${value}`);
}

export function buildImportedModel(match: CsvRow, catalog: CsvRow): ModelConfig {
  const modelId = match.openrouter_model_id;
  if (!modelId || catalog.openrouter_model_id !== modelId) throw new Error("OpenRouter model identity mismatch");
  if (!["hugging_face_id_exact", "openrouter_id_exact"].includes(match.match_method)) {
    throw new Error(`${modelId}: non-exact match method`);
  }
  const inputPrice = requiredNumber(catalog.prompt_usd_per_million_tokens, "prompt price", modelId);
  const outputPrice = requiredNumber(catalog.completion_usd_per_million_tokens, "completion price", modelId);
  const contextLength = requiredNumber(catalog.context_length, "context_length", modelId, { integer: true });
  const supportsTools = booleanField(catalog.supports_tools);
  const supportsJson = booleanField(catalog.supports_structured_outputs) || booleanField(catalog.supports_response_format);
  const inputModalities = new Set(catalog.input_modalities.split("|").filter(Boolean));
  const { quality, source } = buildQuality(match);

  return {
    id: `openrouter:${modelId}`,
    name: match.openrouter_name || catalog.name,
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    upstreamModel: modelId,
    enabled: true,
    canRoute: false,
    supportsJsonMode: supportsJson,
    inputPricePerMillion: inputPrice,
    outputPricePerMillion: outputPrice,
    basePricePerMillion: inputPrice,
    gammaPerMillion: 0.5,
    normalCapacity: 32_000,
    hardCapacity: 52_000,
    eta: outputPrice / inputPrice,
    maxContextTokens: contextLength,
    capabilities: {
      vision: inputModalities.has("image"),
      tools: supportsTools,
      json: supportsJson
    },
    quality,
    qualitySource: source
  };
}

export function buildRuntimeConfig(rootDir: string): { routerModelId: string; requestTimeoutMs: number; models: ModelConfig[] } {
  const current = JSON.parse(fs.readFileSync(path.join(rootDir, "models.json"), "utf8")) as {
    routerModelId: string;
    requestTimeoutMs: number;
    models: ModelConfig[];
  };
  const dataDir = path.join(rootDir, `LLM_performance_data_${SNAPSHOT_DATE}`, "openrouter");
  const matches = parseCsv(fs.readFileSync(path.join(dataDir, `openevals_openrouter_matches_${SNAPSHOT_DATE}.csv`), "utf8"));
  const catalog = parseCsv(fs.readFileSync(path.join(dataDir, `openrouter_models_${SNAPSHOT_DATE}.csv`), "utf8"));
  if (matches.length !== MATCH_COUNT) throw new Error(`Expected ${MATCH_COUNT} exact matches, got ${matches.length}`);

  const directModels = DIRECT_MODEL_IDS.map((id) => {
    const model = current.models.find((candidate) => candidate.id === id);
    if (!model || model.provider !== "openai-compatible") throw new Error(`Missing direct model ${id}`);
    return model;
  });
  const catalogById = new Map(catalog.map((row) => [row.openrouter_model_id, row]));
  const matchedIds = new Set<string>();
  const imported = matches.map((match) => {
    if (matchedIds.has(match.openrouter_model_id)) throw new Error(`Duplicate match ${match.openrouter_model_id}`);
    matchedIds.add(match.openrouter_model_id);
    const catalogRow = catalogById.get(match.openrouter_model_id);
    if (!catalogRow) throw new Error(`Missing catalog model ${match.openrouter_model_id}`);
    return buildImportedModel(match, catalogRow);
  }).sort((left, right) => left.upstreamModel.localeCompare(right.upstreamModel));

  const models = [...directModels, ...imported];
  if (models.length !== 45 || new Set(models.map((model) => model.id)).size !== models.length) {
    throw new Error(`Expected 45 unique runtime models, got ${models.length}`);
  }
  return { routerModelId: current.routerModelId, requestTimeoutMs: current.requestTimeoutMs, models };
}

export function serializeRuntimeConfig(rootDir: string): string {
  return `${JSON.stringify(buildRuntimeConfig(rootDir), null, 2)}\n`;
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  const rootDir = path.resolve(path.dirname(modulePath), "..");
  const output = serializeRuntimeConfig(rootDir);
  fs.writeFileSync(path.join(rootDir, "models.json"), output, "utf8");
  console.log(`Generated models.json with ${JSON.parse(output).models.length} models from the ${SNAPSHOT_DATE} snapshot.`);
}
