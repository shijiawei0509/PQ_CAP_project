import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SEEDS, type ExperimentModel, type LoadClass } from "./types.js";

export type LoadAssignments = Record<number, Record<string, LoadClass>>;

export interface FrozenCalibration {
  rate: number;
  lower: number;
  upper: number;
  iterations: number;
  observation: {
    completedCount: number;
    capacityRejectedCount: number;
    mixedStateShare: number;
  };
}

const PARENT_EXPERIMENT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export const LOAD_ASSIGNMENTS_PATH = path.join(
  PARENT_EXPERIMENT_ROOT,
  "input",
  "load-assignments.json",
);

export const CALIBRATION_PATH = path.join(
  PARENT_EXPERIMENT_ROOT,
  "output",
  "calibration.json",
);

export function anchorLoad(
  model: ExperimentModel,
  loadClass: LoadClass,
): number {
  if (loadClass === "low") return 0.4 * model.normalCapacity;
  if (loadClass === "near") return 0.9 * model.normalCapacity;
  return model.normalCapacity +
    0.4 * (model.hardCapacity - model.normalCapacity);
}

function isLoadClass(value: unknown): value is LoadClass {
  return value === "low" || value === "near" || value === "congested";
}

export function loadFrozenLoadAssignments(
  models?: readonly ExperimentModel[],
): LoadAssignments {
  const parsed = JSON.parse(
    fs.readFileSync(LOAD_ASSIGNMENTS_PATH, "utf8"),
  ) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Frozen load assignments must be an object");
  }
  const source = parsed as Record<string, unknown>;
  const expectedModelIds = models
    ? [...new Set(models.map(({ id }) => id))].sort()
    : null;
  const result = {} as LoadAssignments;
  for (const seed of SEEDS) {
    const seedValue = source[String(seed)];
    if (
      typeof seedValue !== "object" ||
      seedValue === null ||
      Array.isArray(seedValue)
    ) {
      throw new Error(`Frozen load assignments missing seed ${seed}`);
    }
    const seedSource = seedValue as Record<string, unknown>;
    const modelIds = Object.keys(seedSource).sort();
    const requiredModelIds = expectedModelIds ??
      Object.keys(source[String(SEEDS[0])] as Record<string, unknown>).sort();
    for (const modelId of requiredModelIds) {
      if (!(modelId in seedSource)) {
        throw new Error(
          `Frozen load assignments seed ${seed} missing model ${modelId}`,
        );
      }
    }
    for (const modelId of modelIds) {
      if (!requiredModelIds.includes(modelId)) {
        throw new Error(
          `Frozen load assignments seed ${seed} has unknown model ${modelId}`,
        );
      }
    }
    const assignments: Record<string, LoadClass> = {};
    for (const [modelId, loadClass] of Object.entries(seedSource)) {
      if (!isLoadClass(loadClass)) {
        throw new Error(`${seed}/${modelId}: invalid frozen load class`);
      }
      assignments[modelId] = loadClass;
    }
    result[seed] = assignments;
  }
  return result;
}

export function loadFrozenCalibration(): FrozenCalibration {
  const value = JSON.parse(fs.readFileSync(CALIBRATION_PATH, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Frozen calibration must be an object");
  }
  const calibration = value as FrozenCalibration;
  if (
    !(calibration.rate > 0) ||
    !Number.isFinite(calibration.rate) ||
    !(calibration.lower > 0) ||
    !(calibration.upper > calibration.lower) ||
    !Number.isInteger(calibration.iterations) ||
    calibration.iterations <= 0
  ) {
    throw new Error("Frozen calibration is invalid");
  }
  return calibration;
}

export function loadFrozenLambda0(): number {
  return loadFrozenCalibration().rate;
}
