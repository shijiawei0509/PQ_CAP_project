import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TASK_TYPES,
  type Difficulty,
  type TaskType
} from "../../../../../../server/types.js";
import { loadOpenRouter35Models } from "../../../../../code/experiments/openrouter-35-profile.js";
import {
  QUALITY_TOLERANCES,
  type ExperimentModel,
  type ExperimentTask,
  type QualityThresholds
} from "./types.js";

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../.."
);

export const QUALITY_CSV_PATH = path.join(
  PROJECT_ROOT,
  "LLM_performance_data_2026-07-18",
  "openrouter",
  "openrouter_openevals_35_models_2026-07-18.csv"
);

export const CAPACITY_CSV_PATH = path.join(
  PROJECT_ROOT,
  "evaluation",
  "results",
  "2026-07-20-openrouter-35-real-latency",
  "openrouter-35-real-latency.csv"
);

export const CAPACITY_CSV_SHA256 =
  "10aca927140b674ec6fb8625db7d86312d144b4e13de457fccb2a583f9d0ab2a";

export const QUALITY_CSV_SHA256 =
  "96acc0305b375c0eb038ac6ac0004446b626073900f81af557c57d0b14d311dc";

export const TASK_SNAPSHOT_PATH = path.join(
  PROJECT_ROOT,
  "evaluation",
  "results",
  "2026-07-21-35-model-openrouter-heterogeneous-capacity",
  "input",
  "simulation-tasks.json"
);

export const TASK_SNAPSHOT_SHA256 =
  "e882f189b549d937fe85ef3bdddf018eda6f884f21e018a9c790027f8e918b5f";

const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard"];

export interface FrozenProfile {
  models: ExperimentModel[];
  tasks: ExperimentTask[];
  qualityThresholds: QualityThresholds;
}

export function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function verifySourceHash(
  filePath: string,
  expectedHash: string,
  label: string
): void {
  const actualHash = sha256File(filePath);
  if (actualHash !== expectedHash) {
    throw new Error(
      `${label} SHA-256 mismatch: expected ${expectedHash}, received ${actualHash}`
    );
  }
}

function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" &&
    (TASK_TYPES as readonly string[]).includes(value);
}

function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === "string" &&
    (DIFFICULTIES as readonly string[]).includes(value);
}

function assertNonnegativeInteger(value: unknown, label: string): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`${label} must be a finite nonnegative integer`);
  }
}

function validateQuality(
  quality: unknown,
  modelId: string
): asserts quality is Record<TaskType, number> {
  if (typeof quality !== "object" || quality === null || Array.isArray(quality)) {
    throw new Error(`${modelId}: quality must be an object`);
  }
  const values = quality as Record<string, unknown>;
  for (const taskType of TASK_TYPES) {
    const value = values[taskType];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      throw new Error(
        `${modelId}: quality.${taskType} must be finite and within [0, 1]`
      );
    }
  }
}

export function validateFrozenProfile(models: unknown, tasks: unknown): void {
  if (!Array.isArray(models)) {
    throw new Error("Models must be an array");
  }
  if (models.length !== 35) {
    throw new Error(`Expected 35 models, received ${models.length}`);
  }
  const modelIds = new Set<string>();
  for (const [index, value] of models.entries()) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Model at index ${index} must be an object`);
    }
    const model = value as Record<string, unknown>;
    if (typeof model.id !== "string" || model.id.length === 0) {
      throw new Error(`Model at index ${index}: id must be nonempty`);
    }
    if (modelIds.has(model.id)) {
      throw new Error(`Model IDs must be unique: ${model.id}`);
    }
    modelIds.add(model.id);
    if (
      typeof model.baseTtftMs !== "number" ||
      !Number.isFinite(model.baseTtftMs) ||
      model.baseTtftMs <= 0
    ) {
      throw new Error(`${model.id}: baseTtftMs must be finite and positive`);
    }
    if (
      typeof model.eta !== "number" ||
      !Number.isFinite(model.eta) ||
      model.eta <= 0
    ) {
      throw new Error(`${model.id}: eta must be finite and positive`);
    }
    if (
      typeof model.basePricePerMillion !== "number" ||
      !Number.isFinite(model.basePricePerMillion) ||
      model.basePricePerMillion < 0
    ) {
      throw new Error(`${model.id}: base price must be finite and nonnegative`);
    }
    if (
      typeof model.normalCapacity !== "number" ||
      !Number.isFinite(model.normalCapacity)
    ) {
      throw new Error(`${model.id}: B must be finite`);
    }
    if (
      typeof model.hardCapacity !== "number" ||
      !Number.isFinite(model.hardCapacity)
    ) {
      throw new Error(`${model.id}: C must be finite`);
    }
    if (model.normalCapacity < 24_000) {
      throw new Error(`${model.id}: B must be at least 24000`);
    }
    if (model.hardCapacity < 36_000) {
      throw new Error(`${model.id}: C must be at least 36000`);
    }
    if (model.normalCapacity >= model.hardCapacity) {
      throw new Error(`${model.id}: B must be smaller than C`);
    }
    validateQuality(model.quality, model.id);
  }

  if (!Array.isArray(tasks)) {
    throw new Error("Tasks must be an array");
  }
  if (tasks.length !== 18) {
    throw new Error(`Expected 18 tasks, received ${tasks.length}`);
  }
  const taskIds = new Set<string>();
  for (const [index, value] of tasks.entries()) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Task at index ${index} must be an object`);
    }
    const task = value as Record<string, unknown>;
    if (typeof task.taskId !== "string" || task.taskId.length === 0) {
      throw new Error(`Task at index ${index}: taskId must be nonempty`);
    }
    if (taskIds.has(task.taskId)) {
      throw new Error(`Task IDs must be unique: ${task.taskId}`);
    }
    taskIds.add(task.taskId);
    if (!isTaskType(task.taskType)) {
      throw new Error(`${task.taskId}: invalid taskType`);
    }
    if (!isDifficulty(task.difficulty)) {
      throw new Error(`${task.taskId}: invalid difficulty`);
    }
    assertNonnegativeInteger(task.promptTokens, `${task.taskId}: promptTokens`);
    assertNonnegativeInteger(
      task.maxOutputTokens,
      `${task.taskId}: maxOutputTokens`
    );
  }
}

export function freezeQualityThresholds(
  models: readonly ExperimentModel[]
): QualityThresholds {
  if (models.length === 0) {
    throw new Error("Cannot freeze thresholds from an empty model pool");
  }

  return Object.fromEntries(TASK_TYPES.map((taskType) => {
    for (const model of models) {
      validateQuality(model.quality, model.id);
    }
    const maximum = Math.max(...models.map((model) => model.quality[taskType]));
    return [
      taskType,
      Object.fromEntries(DIFFICULTIES.map((difficulty) => [
        difficulty,
        maximum - QUALITY_TOLERANCES[difficulty]
      ]))
    ];
  })) as QualityThresholds;
}

export function eligibleModels(
  models: readonly ExperimentModel[],
  taskType: TaskType,
  difficulty: Difficulty,
  thresholds: Readonly<Record<TaskType, Readonly<Record<Difficulty, number>>>>
): ExperimentModel[] {
  const threshold = thresholds[taskType][difficulty];
  return models
    .filter((model) => model.quality[taskType] >= threshold)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function loadFrozenProfile(): FrozenProfile {
  verifySourceHash(QUALITY_CSV_PATH, QUALITY_CSV_SHA256, "Quality CSV");
  verifySourceHash(CAPACITY_CSV_PATH, CAPACITY_CSV_SHA256, "Capacity CSV");
  verifySourceHash(TASK_SNAPSHOT_PATH, TASK_SNAPSHOT_SHA256, "Task snapshot");

  const sourceModels = loadOpenRouter35Models(QUALITY_CSV_PATH, CAPACITY_CSV_PATH);
  const sourceTasks = JSON.parse(fs.readFileSync(TASK_SNAPSHOT_PATH, "utf8")) as unknown;
  if (!Array.isArray(sourceTasks)) {
    throw new Error("Tasks must be an array");
  }
  const models: ExperimentModel[] = sourceModels.map((model) => ({
    id: model.id,
    baseTtftMs: model.baseTtftMs,
    basePricePerMillion: model.basePricePerMillion,
    eta: model.eta,
    normalCapacity: model.normalCapacity,
    hardCapacity: model.hardCapacity,
    quality: { ...model.quality }
  }));
  const tasks: ExperimentTask[] = sourceTasks.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Task at index ${index} must be an object`);
    }
    const task = value as Record<string, unknown>;
    return {
      taskId: task.taskId as string,
      taskType: task.taskType as TaskType,
      difficulty: task.difficulty as Difficulty,
      promptTokens: task.promptTokens as number,
      maxOutputTokens: task.maxOutputTokens as number
    };
  });

  validateFrozenProfile(models, tasks);

  return {
    models,
    tasks,
    qualityThresholds: freezeQualityThresholds(models)
  };
}
