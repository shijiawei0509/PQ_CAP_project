import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TASK_TYPES, type TaskType } from "../../../../server/types.js";
import { loadOpenRouter35Models } from "../../../code/experiments/openrouter-35-profile.js";
import type { SimulationTaskTemplate } from "../../../code/simulation/types.js";
import {
  QUALITY_EPSILON,
  type ExperimentModel,
  type ExperimentTask
} from "./types.js";

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
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
export const TASK_SNAPSHOT_PATH = path.join(
  PROJECT_ROOT,
  "evaluation",
  "results",
  "2026-07-21-35-model-openrouter-heterogeneous-capacity",
  "input",
  "simulation-tasks.json"
);

export interface FrozenProfile {
  models: ExperimentModel[];
  tasks: ExperimentTask[];
}

export function loadFrozenProfile(): FrozenProfile {
  const sourceModels = loadOpenRouter35Models(QUALITY_CSV_PATH, CAPACITY_CSV_PATH);
  const sourceTasks = JSON.parse(
    fs.readFileSync(TASK_SNAPSHOT_PATH, "utf8")
  ) as SimulationTaskTemplate[];
  const models = sourceModels.map((model) => ({
    id: model.id,
    baseTtftMs: model.baseTtftMs,
    basePricePerMillion: model.basePricePerMillion,
    eta: model.eta,
    normalCapacity: model.normalCapacity,
    hardCapacity: model.hardCapacity,
    quality: { ...model.quality }
  }));
  const tasks = sourceTasks.map((task) => ({
    taskId: task.taskId,
    taskType: task.taskType,
    difficulty: task.difficulty,
    promptTokens: task.promptTokens,
    maxOutputTokens: task.maxOutputTokens
  }));
  if (models.length !== 35) throw new Error(`Expected 35 models, received ${models.length}`);
  if (tasks.length !== 18) throw new Error(`Expected 18 tasks, received ${tasks.length}`);
  for (const model of models) {
    if (!(model.baseTtftMs > 0)) throw new Error(`${model.id}: base TTFT must be positive`);
    if (!(model.normalCapacity < model.hardCapacity)) {
      throw new Error(`${model.id}: B must be smaller than C`);
    }
    if (!Number.isFinite(model.basePricePerMillion)) {
      throw new Error(`${model.id}: base price must be finite`);
    }
  }
  return { models, tasks };
}

export function freezeQualityThresholds(
  models: readonly ExperimentModel[],
  epsilon = QUALITY_EPSILON
): Record<TaskType, number> {
  if (models.length === 0) throw new Error("Cannot freeze thresholds from an empty model pool");
  return Object.fromEntries(TASK_TYPES.map((taskType) => [
    taskType,
    Math.max(...models.map((model) => model.quality[taskType])) - epsilon
  ])) as Record<TaskType, number>;
}

export function eligibleModels(
  models: readonly ExperimentModel[],
  taskType: TaskType,
  thresholds: Readonly<Record<TaskType, number>>
): ExperimentModel[] {
  return models
    .filter((model) => model.quality[taskType] >= thresholds[taskType])
    .sort((left, right) => left.id.localeCompare(right.id));
}
