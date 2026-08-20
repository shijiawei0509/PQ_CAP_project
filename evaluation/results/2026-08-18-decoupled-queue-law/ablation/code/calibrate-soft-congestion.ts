import {
  existsSync,
  mkdirSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  SEEDS,
  TASK_TYPES,
  type ExperimentModel,
  type ExperimentTask,
  type TaskType
} from "./types.js";
import { queueTiming } from "./queue-model.js";
import { buildIndependentTrace } from "./traces.js";

export const SOFT_LOAD_FRACTIONS = [0.20, 0.45, 0.70] as const;
export const CALIBRATION_RATE_SCALES = [
  0.125,
  0.25,
  0.5,
  1,
  2,
  4,
  8
] as const;

export interface SoftLoadState {
  seed: number;
  taskType: TaskType;
  modelId: string;
  fraction: number;
  load: number;
  normalCapacity: number;
  hardCapacity: number;
}

export interface SoftCongestionInputs {
  seed: number;
  fractions: readonly number[];
  states: SoftLoadState[];
}

export function softLoad(
  model: ExperimentModel,
  fraction: number
): number {
  if (!SOFT_LOAD_FRACTIONS.includes(
    fraction as (typeof SOFT_LOAD_FRACTIONS)[number]
  )) {
    throw new Error("Unregistered soft-congestion fraction");
  }
  return model.normalCapacity +
    fraction * (model.hardCapacity - model.normalCapacity);
}

export function buildSoftCongestionInputs(
  models: readonly ExperimentModel[],
  thresholds: Readonly<Record<TaskType, number>>,
  seed: number,
  tasks?: readonly ExperimentTask[]
): SoftCongestionInputs {
  const sorted = [...models].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const seedIndex = Math.max(0, SEEDS.indexOf(seed as (typeof SEEDS)[number]));
  const states = TASK_TYPES.flatMap((taskType, taskIndex) =>
    sorted
      .filter((model) => model.quality[taskType] >= thresholds[taskType])
      .map((model, modelIndex): SoftLoadState => {
        const nominalFraction = SOFT_LOAD_FRACTIONS[
          (seedIndex + taskIndex + modelIndex) % SOFT_LOAD_FRACTIONS.length
        ];
        const taskWorkloads = (tasks ?? [])
          .filter((task) => task.taskType === taskType)
          .map((task) =>
            task.promptTokens + model.eta * task.maxOutputTokens
          );
        const maximumWorkload = taskWorkloads.length > 0
          ? Math.max(...taskWorkloads)
          : 0;
        const capacityGap = model.hardCapacity - model.normalCapacity;
        const safeUpper = 0.8 - (maximumWorkload + 1) / capacityGap;
        const fraction = safeUpper > 0
          ? Math.min(nominalFraction, safeUpper)
          : nominalFraction;
        return {
          seed,
          taskType,
          modelId: model.id,
          fraction,
          load: model.normalCapacity +
            fraction * (model.hardCapacity - model.normalCapacity),
          normalCapacity: model.normalCapacity,
          hardCapacity: model.hardCapacity
        };
      })
  );
  return { seed, fractions: SOFT_LOAD_FRACTIONS, states };
}

export interface CalibrationObservation {
  arrivalRate: number;
  completionRate: number;
  capacityFailureRate: number;
}

export function observeBalancedReference(args: {
  models: readonly ExperimentModel[];
  tasks: readonly ExperimentTask[];
  thresholds: Readonly<Record<TaskType, number>>;
  seed: number;
  backgroundLoadByTask: Partial<
    Record<TaskType, Readonly<Record<string, number>>>
  >;
  arrivalRate: number;
  requestCount: number;
}): CalibrationObservation {
  const trace = buildIndependentTrace(
    "soft-congestion",
    "quality-first",
    args.seed,
    {
      models: args.models,
      tasks: args.tasks,
      arrivalRatePerSecond: args.arrivalRate,
      backgroundLoadByTask: args.backgroundLoadByTask
    },
    args.requestCount
  );
  const experimentLoads = Object.fromEntries(
    args.models.map((model) => [model.id, 0])
  );
  const releases: Array<{
    timeMs: number;
    modelId: string;
    reservedLoad: number;
  }> = [];
  let cursor = 0;
  let completed = 0;
  let capacityFailures = 0;
  for (const request of trace) {
    releases.sort((left, right) => left.timeMs - right.timeMs);
    while (releases[0] && releases[0].timeMs <= request.arrivalTimeMs) {
      const release = releases.shift()!;
      experimentLoads[release.modelId] = Math.max(
        0,
        experimentLoads[release.modelId] - release.reservedLoad
      );
    }
    const candidates = args.models
      .filter((model) =>
        model.quality[request.taskType] >= args.thresholds[request.taskType]
      )
      .map((model) => {
        const reservedLoad = request.reservedLoadByModel[model.id];
        const postLoad =
          (request.backgroundLoadByModel[model.id] ?? 0) +
          experimentLoads[model.id] +
          reservedLoad;
        return { model, reservedLoad, postLoad };
      })
      .filter(({ model, postLoad }) => postLoad < model.hardCapacity)
      .sort((left, right) => left.model.id.localeCompare(right.model.id));
    if (candidates.length === 0) {
      capacityFailures += 1;
      continue;
    }
    const selected = candidates[cursor % candidates.length];
    cursor += 1;
    const naturalTtftMs = request.naturalTtftByModel[selected.model.id];
    const timing = queueTiming(
      selected.postLoad,
      selected.model.normalCapacity,
      selected.model.hardCapacity,
      naturalTtftMs
    );
    if (!timing) {
      capacityFailures += 1;
      continue;
    }
    experimentLoads[selected.model.id] += selected.reservedLoad;
    releases.push({
      timeMs: request.arrivalTimeMs + timing.endToEndTtftMs,
      modelId: selected.model.id,
      reservedLoad: selected.reservedLoad
    });
    completed += 1;
  }
  return {
    arrivalRate: args.arrivalRate,
    completionRate: completed / trace.length,
    capacityFailureRate: capacityFailures / trace.length
  };
}

export interface CalibrationResult {
  router: "balanced-reference";
  interval: readonly [number, number];
  selectedArrivalRate: number;
  observations: CalibrationObservation[];
  formalMethodReads: 0;
  objective: "avoid-universal-hard-cap-failure";
}

function isFeasible(observation: CalibrationObservation): boolean {
  return observation.completionRate >= 0.995 &&
    observation.capacityFailureRate <= 0.01;
}

export function calibrateArrivalRate(args: {
  interval: readonly [number, number];
  observations: readonly CalibrationObservation[];
}): CalibrationResult {
  if (
    args.interval[0] <= 0 ||
    args.interval[1] <= args.interval[0] ||
    args.observations.length === 0
  ) {
    throw new Error("Invalid calibration search");
  }
  const observations = [...args.observations].sort((left, right) =>
    left.arrivalRate - right.arrivalRate
  );
  const selected = observations.filter(isFeasible).at(-1);
  if (!selected) {
    throw new Error(
      "No feasible Balanced Reference Router arrival rate: " +
      JSON.stringify(observations)
    );
  }
  return {
    router: "balanced-reference",
    interval: args.interval,
    selectedArrivalRate: selected.arrivalRate,
    observations,
    formalMethodReads: 0,
    objective: "avoid-universal-hard-cap-failure"
  };
}

export function writeFrozenSoftScenario(
  root: string,
  value: unknown
): void {
  const filePath = resolve(root, "input", "soft-congestion-scenario.json");
  if (existsSync(filePath)) {
    throw new Error("Soft-congestion formal scenario is already frozen");
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
