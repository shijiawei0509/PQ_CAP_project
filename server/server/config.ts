import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TASK_TYPES, type ModelConfig } from "./types.js";

const taskQualitySchema = z.object(
  Object.fromEntries(TASK_TYPES.map((task) => [task, z.number().min(0).max(1)])) as Record<
    (typeof TASK_TYPES)[number],
    z.ZodNumber
  >
);

const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.enum(["openrouter", "openai-compatible"]),
  baseUrl: z.string().url(),
  baseUrlEnv: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1),
  upstreamModel: z.string().min(1),
  upstreamModelEnv: z.string().min(1).optional(),
  enabled: z.boolean(),
  canRoute: z.boolean(),
  supportsJsonMode: z.boolean(),
  inputPricePerMillion: z.number().min(0).nullable(),
  outputPricePerMillion: z.number().min(0).nullable(),
  basePricePerMillion: z.number().min(0),
  gammaPerMillion: z.number().min(0),
  normalCapacity: z.number().positive(),
  hardCapacity: z.number().positive(),
  eta: z.number().positive(),
  maxContextTokens: z.number().int().positive(),
  capabilities: z.object({
    vision: z.boolean(),
    tools: z.boolean(),
    json: z.boolean()
  }),
  quality: taskQualitySchema,
  qualitySource: z.string().min(1)
}).refine((model) => model.normalCapacity < model.hardCapacity, {
  message: "normalCapacity must be smaller than hardCapacity"
});

const configSchema = z.object({
  routerModelId: z.string().min(1),
  requestTimeoutMs: z.number().int().positive().default(90000),
  models: z.array(modelSchema).min(1)
});

export type AppConfig = {
  routerModelId: string;
  requestTimeoutMs: number;
  models: ModelConfig[];
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(): AppConfig {
  const configuredPath = path.join(rootDir, "models.json");
  const fallbackPath = path.join(rootDir, "models.example.json");
  const sourcePath = fs.existsSync(configuredPath) ? configuredPath : fallbackPath;
  const parsed = configSchema.parse(JSON.parse(fs.readFileSync(sourcePath, "utf8")));
  const models = parsed.models.map((model) => ({
    ...model,
    baseUrl: model.baseUrlEnv && process.env[model.baseUrlEnv]?.trim()
      ? process.env[model.baseUrlEnv]!.trim().replace(/\/+$/, "")
      : model.baseUrl,
    upstreamModel: model.upstreamModelEnv && process.env[model.upstreamModelEnv]?.trim()
      ? process.env[model.upstreamModelEnv]!.trim()
      : model.upstreamModel
  }));
  const ids = new Set(models.map((model) => model.id));

  if (ids.size !== models.length) {
    throw new Error("models.json contains duplicate model ids");
  }
  if (!ids.has(parsed.routerModelId)) {
    throw new Error(`Router model ${parsed.routerModelId} does not exist`);
  }

  return { ...parsed, models } as AppConfig;
}

export function isModelConfigured(model: ModelConfig): boolean {
  return Boolean(process.env[model.apiKeyEnv]?.trim());
}

export function publicModel(model: ModelConfig, load: number) {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    upstreamModel: model.upstreamModel,
    enabled: model.enabled,
    configured: isModelConfigured(model),
    canRoute: model.canRoute,
    basePricePerMillion: model.basePricePerMillion,
    inputPricePerMillion: model.inputPricePerMillion,
    outputPricePerMillion: model.outputPricePerMillion,
    normalCapacity: model.normalCapacity,
    hardCapacity: model.hardCapacity,
    currentLoad: load,
    quality: model.quality,
    qualitySource: model.qualitySource
  };
}
