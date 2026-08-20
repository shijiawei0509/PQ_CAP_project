import { createHash } from "node:crypto";
import {
  INDEPENDENT_REQUEST_COUNT,
  MIXED_COHORTS,
  MIXED_COHORT_QUOTA,
  MIXED_REQUEST_COUNT,
  SEEDS,
  type Cohort,
  type CoreMethod,
  type ExperimentModel,
  type ExperimentRequest,
  type ExperimentTask,
  type IndependentCohort,
  type ScenarioId
} from "./types.js";

export interface TraceFixtures {
  models: readonly ExperimentModel[];
  tasks: readonly ExperimentTask[];
  arrivalRatePerSecond: number;
  backgroundLoadByModel?: Readonly<Record<string, number>>;
  backgroundLoadByTask?: Partial<
    Record<ExperimentTask["taskType"], Readonly<Record<string, number>>>
  >;
}

class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }
}

export function derivedSeed(seed: number, stream: string): number {
  const hex = createHash("sha256")
    .update(`${seed}\0${stream}`)
    .digest("hex")
    .slice(0, 8);
  return Number.parseInt(hex, 16) >>> 0;
}

function hashValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function traceHash(trace: readonly ExperimentRequest[]): string {
  return hashValue(trace.map(({ cohort: _cohort, ...request }) => request));
}

export function traceForMethod(
  trace: readonly ExperimentRequest[],
  _method: CoreMethod
): readonly ExperimentRequest[] {
  return trace;
}

function validateFixtures(fixtures: TraceFixtures): void {
  if (fixtures.models.length === 0) throw new Error("Trace requires models");
  if (fixtures.tasks.length === 0) throw new Error("Trace requires tasks");
  if (
    !Number.isFinite(fixtures.arrivalRatePerSecond) ||
    fixtures.arrivalRatePerSecond <= 0
  ) {
    throw new Error("Arrival rate must be positive and finite");
  }
}

function buildTrace(
  scenario: ScenarioId,
  seed: number,
  fixtures: TraceFixtures,
  requestCount: number,
  cohortAt: (index: number) => Cohort
): ExperimentRequest[] {
  validateFixtures(fixtures);
  const arrivalRandom = new Random(derivedSeed(seed, "arrival"));
  const taskRandom = new Random(derivedSeed(seed, "task"));
  const latencyRandom = new Random(derivedSeed(seed, "natural-ttft"));
  const fixedRandom = new Random(derivedSeed(seed, "fixed-model"));
  const sortedModels = [...fixtures.models].sort((a, b) =>
    a.id.localeCompare(b.id)
  );
  let arrivalTimeMs = 0;
  const rows: ExperimentRequest[] = [];
  for (let index = 0; index < requestCount; index += 1) {
    const intervalSeconds = -Math.log(
      Math.max(Number.EPSILON, 1 - arrivalRandom.next())
    ) / fixtures.arrivalRatePerSecond;
    arrivalTimeMs += intervalSeconds * 1_000;
    const task = fixtures.tasks[
      Math.min(
        fixtures.tasks.length - 1,
        Math.floor(taskRandom.next() * fixtures.tasks.length)
      )
    ];
    const naturalTtftByModel = Object.fromEntries(sortedModels.map((model) => [
      model.id,
      model.baseTtftMs * (0.9 + 0.2 * latencyRandom.next())
    ]));
    const reservedLoadByModel = Object.fromEntries(sortedModels.map((model) => [
      model.id,
      task.promptTokens + model.eta * task.maxOutputTokens
    ]));
    const fixedIndex = Math.min(
      sortedModels.length - 1,
      Math.floor(fixedRandom.next() * sortedModels.length)
    );
    const fixedModelId = sortedModels[fixedIndex].id;
    const authorizedFallbackModelIds = sortedModels
      .filter((model) =>
        model.id !== fixedModelId &&
        model.quality[task.taskType] >=
          sortedModels[fixedIndex].quality[task.taskType] - 0.02
      )
      .map((model) => model.id);
    const core = {
      requestId: `${scenario}-${seed}-${String(index).padStart(4, "0")}`,
      scenario,
      seed,
      taskId: task.taskId,
      taskType: task.taskType,
      difficulty: task.difficulty,
      arrivalTimeMs,
      promptTokens: task.promptTokens,
      maxOutputTokens: task.maxOutputTokens,
      requiredCapabilities: task.requiredCapabilities,
      reservedLoadByModel,
      naturalTtftByModel,
      backgroundLoadByModel: {
        ...(
          fixtures.backgroundLoadByTask?.[task.taskType] ??
          fixtures.backgroundLoadByModel ??
          {}
        )
      },
      fixedModelId,
      authorizedFallbackModelIds
    };
    rows.push({
      ...core,
      cohort: cohortAt(index),
      traceHash: hashValue(core)
    });
  }
  return rows;
}

export function buildIndependentTrace(
  scenario: Exclude<ScenarioId, "mixed-regular">,
  cohort: IndependentCohort,
  seed: number,
  fixtures: TraceFixtures,
  requestCount = INDEPENDENT_REQUEST_COUNT
): ExperimentRequest[] {
  return buildTrace(
    scenario,
    seed,
    fixtures,
    requestCount,
    () => cohort
  );
}

export function buildMixedTrace(
  scenario: "mixed-regular",
  seed: number,
  fixtures: TraceFixtures,
  requestCount = MIXED_REQUEST_COUNT
): ExperimentRequest[] {
  if (requestCount % MIXED_COHORTS.length !== 0) {
    throw new Error("Mixed request count must divide evenly across cohorts");
  }
  const seedIndex = Math.max(0, SEEDS.indexOf(seed as (typeof SEEDS)[number]));
  const rows = buildTrace(
    scenario,
    seed,
    fixtures,
    requestCount,
    (index) => MIXED_COHORTS[(index + seedIndex) % MIXED_COHORTS.length]
  );
  if (requestCount === MIXED_REQUEST_COUNT) {
    for (const cohort of MIXED_COHORTS) {
      const count = rows.filter((row) => row.cohort === cohort).length;
      if (count !== MIXED_COHORT_QUOTA) {
        throw new Error(`${cohort}: expected ${MIXED_COHORT_QUOTA}, received ${count}`);
      }
    }
  }
  return rows;
}
