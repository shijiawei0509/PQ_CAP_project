import { createRandom, standardNormalFor } from "../../../code/simulation/random.js";
import {
  REQUEST_COUNT,
  type ExperimentModel,
  type ExperimentRequest,
  type ExperimentTask,
  type ScenarioDefinition
} from "./types.js";

export interface CalibrationObservation {
  completedCount: number;
  capacityRejectedCount: number;
  mixedStateShare: number;
}

export interface CalibrationResult {
  rate: number;
  lower: number;
  upper: number;
  iterations: number;
  observation: CalibrationObservation;
}

export function scenarioDefinitions(
  lambda0: number,
  seed: number,
  requestCount = REQUEST_COUNT
): Record<"S1" | "S2" | "S3", ScenarioDefinition> {
  if (!(lambda0 > 0)) throw new Error("S1 arrival rate must be positive");
  const common = { seed, requestCount };
  return {
    S1: { id: "S1", ...common, arrivalRatePerSecond: lambda0 },
    S2: { id: "S2", ...common, arrivalRatePerSecond: 1.5 * lambda0 },
    S3: {
      id: "S3",
      ...common,
      arrivalRatePerSecond: lambda0,
      burst: {
        startFraction: 0.4,
        endFraction: 0.6,
        taskTypes: ["coding", "math"],
        multiplier: 3
      }
    }
  };
}

function chooseTask(
  tasks: readonly ExperimentTask[],
  random: () => number,
  burst: ScenarioDefinition["burst"] | undefined,
  inBurst: boolean
): ExperimentTask {
  const weights = tasks.map((task) =>
    inBurst && burst?.taskTypes.includes(task.taskType) ? burst.multiplier : 1
  );
  let target = random() * weights.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < tasks.length; index += 1) {
    target -= weights[index];
    if (target <= 0) return tasks[index];
  }
  return tasks[tasks.length - 1];
}

function clippedNaturalTtft(
  model: ExperimentModel,
  scenarioId: string,
  seed: number,
  requestIndex: number
): number {
  const z = standardNormalFor(
    `quality-first-base:${scenarioId}:${seed}:${requestIndex}:${model.id}`
  );
  const multiplier = Math.max(0.9, Math.min(1.15, Math.exp(0.05 * z)));
  return model.baseTtftMs * multiplier;
}

export function buildScenarioTrace(args: {
  definition: ScenarioDefinition;
  tasks: readonly ExperimentTask[];
  models: readonly ExperimentModel[];
}): ExperimentRequest[] {
  const { definition, tasks, models } = args;
  if (tasks.length === 0 || models.length === 0) throw new Error("Trace inputs cannot be empty");
  const random = createRandom(`quality-first-arrival:${definition.id}:${definition.seed}`);
  const horizonMs =
    definition.requestCount / definition.arrivalRatePerSecond * 1_000;
  const requests = Array.from({ length: definition.requestCount }, (_, index) => {
    const arrivalTimeMs = random() * horizonMs;
    const fraction = arrivalTimeMs / horizonMs;
    const inBurst = Boolean(
      definition.burst &&
      fraction >= definition.burst.startFraction &&
      fraction < definition.burst.endFraction
    );
    const task = chooseTask(tasks, random, definition.burst, inBurst);
    return {
      ...task,
      requestId: `${definition.id}-${definition.seed}-${String(index).padStart(6, "0")}`,
      arrivalTimeMs,
      baseTtftByModel: Object.fromEntries(models.map((model) => [
        model.id,
        clippedNaturalTtft(model, definition.id, definition.seed, index)
      ]))
    };
  });
  return requests.sort((left, right) =>
    left.arrivalTimeMs - right.arrivalTimeMs ||
    left.requestId.localeCompare(right.requestId)
  );
}

function feasible(observation: CalibrationObservation): boolean {
  return observation.completedCount === REQUEST_COUNT &&
    observation.capacityRejectedCount === 0 &&
    observation.mixedStateShare >= 0.95;
}

export function calibrateBaseRate(
  evaluate: (rate: number) => CalibrationObservation,
  options: {
    lower?: number;
    upper?: number;
    iterations?: number;
  } = {}
): CalibrationResult {
  let lower = options.lower ?? 0.0001;
  let upper = options.upper ?? 1_000;
  const iterations = options.iterations ?? 30;
  let best: CalibrationResult | null = null;
  for (let index = 0; index < iterations; index += 1) {
    const rate = (lower + upper) / 2;
    const observation = evaluate(rate);
    if (feasible(observation)) {
      best = { rate, lower, upper, iterations: index + 1, observation };
      lower = rate;
    } else {
      upper = rate;
    }
  }
  if (!best) throw new Error("Calibration found no safe S1 arrival rate");
  return { ...best, lower, upper, iterations };
}
