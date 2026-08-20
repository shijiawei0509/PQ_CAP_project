import { anchorLoad } from "./load-traces.js";
import {
  buildBaselineCandidates,
  type ExperimentRouter,
} from "./routers.js";
import type {
  ExperimentModel,
  ExperimentRequest,
  LoadClass,
  MethodId,
  QualityThresholds,
  ScenarioDefinition,
} from "./types.js";

export type RequestStatus =
  | "completed"
  | "rejected-capacity"
  | "rejected-router"
  | "simulated-timeout";

export interface RequestResult {
  scenario: ScenarioDefinition["id"];
  seed: number;
  method: MethodId;
  requestId: string;
  taskId: string;
  taskType: ExperimentRequest["taskType"];
  difficulty: ExperimentRequest["difficulty"];
  status: RequestStatus;
  modelId: string | null;
  arrivalTimeMs: number;
  completionTimeMs: number;
  promptTokens: number;
  maxOutputTokens: number;
  reservedLoad: number | null;
  loadBefore: number | null;
  postLoad: number | null;
  normalCapacity: number | null;
  hardCapacity: number | null;
  baseTtftMs: number | null;
  queueWaitMs: number | null;
  endToEndTtftMs: number | null;
  quality: number | null;
  nonCongested: boolean | null;
  reason: string;
  basePricePerMillion: number | null;
  lockedUnitPrice: number | null;
  dynamicCheapestQuote: number | null;
  surchargeApplied: boolean | null;
  staticCheapestModelId: string | null;
  dynamicCheapestModelId: string | null;
  priceInducedReroute: boolean | null;
  candidateCount: number;
}

interface CompletionEvent {
  timeMs: number;
  requestId: string;
  modelId: string;
  reservedLoad: number;
  completedTtftMs: number | null;
}

function compareEvent(left: CompletionEvent, right: CompletionEvent): number {
  return left.timeMs - right.timeMs ||
    left.requestId.localeCompare(right.requestId);
}

class CompletionHeap {
  private readonly values: CompletionEvent[] = [];

  peek(): CompletionEvent | undefined {
    return this.values[0];
  }

  push(value: CompletionEvent): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareEvent(this.values[parent], value) <= 0) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = value;
  }

  pop(): CompletionEvent | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first || !last || this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = 2 * index + 1;
      const right = left + 1;
      if (left >= this.values.length) break;
      const child = right < this.values.length &&
          compareEvent(this.values[right], this.values[left]) < 0
        ? right
        : left;
      if (compareEvent(last, this.values[child]) <= 0) break;
      this.values[index] = this.values[child];
      index = child;
    }
    this.values[index] = last;
    return first;
  }
}

function gini(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;
  const weighted = sorted.reduce(
    (sum, value, index) =>
      sum + (2 * (index + 1) - sorted.length - 1) * value,
    0,
  );
  return weighted / (sorted.length * total);
}

function normalizedLoadGini(
  models: readonly ExperimentModel[],
  loads: Readonly<Record<string, number>>,
): number {
  return gini(models.map(
    (model) => (loads[model.id] ?? 0) / model.normalCapacity,
  ));
}

export interface SimulationResult {
  requests: RequestResult[];
  giniEvents: Array<{
    startTimeMs: number;
    endTimeMs: number;
    gini: number;
  }>;
  timeWeightedLoadGini: number;
  mixedStateShare: number;
  capacityRejectedCount: number;
  finalExperimentLoads: Record<string, number>;
  validation: {
    finalLoadsZero: boolean;
    capacityInvariant: boolean;
  };
}

export function simulate(args: {
  scenario: ScenarioDefinition;
  requests: readonly ExperimentRequest[];
  models: readonly ExperimentModel[];
  thresholds: QualityThresholds;
  loadClasses: Readonly<Record<string, LoadClass>>;
  router: ExperimentRouter;
  requestTimeoutMs: number;
}): SimulationResult {
  if (args.requests.length !== args.scenario.requestCount) {
    throw new Error("Scenario request count does not match trace length");
  }

  const requests = [...args.requests].sort((left, right) =>
    left.arrivalTimeMs - right.arrivalTimeMs ||
    left.requestId.localeCompare(right.requestId)
  );
  const backgroundLoads = Object.fromEntries(args.models.map((model) => {
    const loadClass = args.loadClasses[model.id];
    if (!loadClass) {
      throw new Error(`${model.id}: missing background load class`);
    }
    return [model.id, anchorLoad(model, loadClass)];
  })) as Record<string, number>;
  const experimentLoads = Object.fromEntries(
    args.models.map((model) => [model.id, 0]),
  ) as Record<string, number>;
  const recentTtfts = Object.fromEntries(
    args.models.map((model) => [model.id, [] as number[]]),
  );
  const results: RequestResult[] = [];
  const heap = new CompletionHeap();
  let arrivalIndex = 0;
  let mixedStateCount = 0;
  let capacityRejectedCount = 0;
  let capacityInvariant = true;
  const firstArrival = requests[0]?.arrivalTimeMs ?? 0;
  const finalArrival = requests.at(-1)?.arrivalTimeMs ?? firstArrival;
  let previousEventTime = firstArrival;
  let giniIntegral = 0;
  const giniEvents: SimulationResult["giniEvents"] = [];

  const totalLoads = (): Record<string, number> => Object.fromEntries(
    args.models.map((model) => [
      model.id,
      backgroundLoads[model.id] + experimentLoads[model.id],
    ]),
  );
  const accumulateGini = (eventTime: number): void => {
    const end = Math.min(eventTime, finalArrival);
    const start = Math.min(
      Math.max(previousEventTime, firstArrival),
      finalArrival,
    );
    if (end > start) {
      const currentGini = normalizedLoadGini(args.models, totalLoads());
      giniIntegral += currentGini * (end - start);
      giniEvents.push({
        startTimeMs: start,
        endTimeMs: end,
        gini: currentGini,
      });
    }
    previousEventTime = eventTime;
  };

  while (arrivalIndex < requests.length || heap.peek()) {
    const nextArrival =
      requests[arrivalIndex]?.arrivalTimeMs ?? Number.POSITIVE_INFINITY;
    const nextCompletion =
      heap.peek()?.timeMs ?? Number.POSITIVE_INFINITY;
    const eventTime = Math.min(nextArrival, nextCompletion);
    accumulateGini(eventTime);

    // Releases deliberately precede arrivals at the same timestamp.
    while (heap.peek()?.timeMs === eventTime) {
      const event = heap.pop()!;
      experimentLoads[event.modelId] -= event.reservedLoad;
      if (Math.abs(experimentLoads[event.modelId]) < 1e-9) {
        experimentLoads[event.modelId] = 0;
      }
      if (experimentLoads[event.modelId] < 0) {
        throw new Error(`${event.modelId}: released more load than reserved`);
      }
      if (event.completedTtftMs !== null) {
        const recent = recentTtfts[event.modelId];
        recent.push(event.completedTtftMs);
        if (recent.length > 50) recent.shift();
      }
    }

    while (requests[arrivalIndex]?.arrivalTimeMs === eventTime) {
      const request = requests[arrivalIndex++];
      const candidates = buildBaselineCandidates({
        request,
        models: args.models,
        thresholds: args.thresholds,
        backgroundLoads,
        experimentLoads,
      });
      if (
        candidates.some(
          (candidate) =>
            candidate.postLoad <= candidate.model.normalCapacity,
        ) &&
        candidates.some(
          (candidate) =>
            candidate.postLoad > candidate.model.normalCapacity,
        )
      ) {
        mixedStateCount += 1;
      }

      const decision = args.router.select({
        request,
        models: args.models,
        thresholds: args.thresholds,
        backgroundLoads,
        experimentLoads,
        recentTtfts,
      });
      const selected = candidates.find(
        (candidate) => candidate.model.id === decision.modelId,
      );
      if (!selected) {
        const qualityEligible = args.models.some(
          (model) =>
            model.quality[request.taskType] >=
              args.thresholds[request.taskType][request.difficulty],
        );
        const capacityRejected = candidates.length === 0 && qualityEligible;
        if (capacityRejected) capacityRejectedCount += 1;
        results.push({
          scenario: args.scenario.id,
          seed: args.scenario.seed,
          method: args.router.id,
          requestId: request.requestId,
          taskId: request.taskId,
          taskType: request.taskType,
          difficulty: request.difficulty,
          status: capacityRejected
            ? "rejected-capacity"
            : "rejected-router",
          modelId: null,
          arrivalTimeMs: request.arrivalTimeMs,
          completionTimeMs: request.arrivalTimeMs,
          promptTokens: request.promptTokens,
          maxOutputTokens: request.maxOutputTokens,
          reservedLoad: null,
          loadBefore: null,
          postLoad: null,
          normalCapacity: null,
          hardCapacity: null,
          baseTtftMs: null,
          queueWaitMs: null,
          endToEndTtftMs: null,
          quality: null,
          nonCongested: null,
          reason: decision.reason,
          basePricePerMillion: null,
          lockedUnitPrice: null,
          dynamicCheapestQuote: null,
          surchargeApplied: null,
          staticCheapestModelId: null,
          dynamicCheapestModelId: null,
          priceInducedReroute: null,
          candidateCount: candidates.length,
        });
        continue;
      }

      if (selected.postLoad >= selected.model.hardCapacity) {
        capacityInvariant = false;
      }
      experimentLoads[selected.model.id] += selected.reservedLoad;
      const completed = selected.endToEndTtftMs <= args.requestTimeoutMs;
      const heldMs = completed
        ? selected.endToEndTtftMs
        : args.requestTimeoutMs;
      heap.push({
        timeMs: request.arrivalTimeMs + heldMs,
        requestId: request.requestId,
        modelId: selected.model.id,
        reservedLoad: selected.reservedLoad,
        completedTtftMs: completed ? selected.endToEndTtftMs : null,
      });

      const ours = args.router.id === "ours-price-first";
      if (
        ours &&
        (
          decision.lockedUnitPrice === null ||
          decision.dynamicCheapestModelId !== selected.model.id ||
          decision.staticCheapestModelId == null ||
          typeof decision.priceInducedReroute !== "boolean"
        )
      ) {
        throw new Error("Ours returned inconsistent price diagnostics");
      }
      const lockedUnitPrice = ours
        ? decision.lockedUnitPrice!
        : selected.model.basePricePerMillion;
      results.push({
        scenario: args.scenario.id,
        seed: args.scenario.seed,
        method: args.router.id,
        requestId: request.requestId,
        taskId: request.taskId,
        taskType: request.taskType,
        difficulty: request.difficulty,
        status: completed ? "completed" : "simulated-timeout",
        modelId: selected.model.id,
        arrivalTimeMs: request.arrivalTimeMs,
        completionTimeMs: request.arrivalTimeMs + heldMs,
        promptTokens: request.promptTokens,
        maxOutputTokens: request.maxOutputTokens,
        reservedLoad: selected.reservedLoad,
        loadBefore: selected.loadBefore,
        postLoad: selected.postLoad,
        normalCapacity: selected.model.normalCapacity,
        hardCapacity: selected.model.hardCapacity,
        baseTtftMs: selected.baseTtftMs,
        queueWaitMs: selected.queueWaitMs,
        endToEndTtftMs: completed ? selected.endToEndTtftMs : null,
        quality: selected.quality,
        nonCongested: selected.postLoad <= selected.model.normalCapacity,
        reason: decision.reason,
        basePricePerMillion: selected.model.basePricePerMillion,
        lockedUnitPrice,
        dynamicCheapestQuote: ours ? lockedUnitPrice : null,
        surchargeApplied: ours
          ? lockedUnitPrice > selected.model.basePricePerMillion
          : null,
        staticCheapestModelId: ours
          ? decision.staticCheapestModelId ?? null
          : null,
        dynamicCheapestModelId: ours
          ? decision.dynamicCheapestModelId ?? null
          : null,
        priceInducedReroute: ours
          ? decision.priceInducedReroute ?? false
          : null,
        candidateCount: candidates.length,
      });
    }
  }

  const finalLoadsZero = Object.values(experimentLoads).every(
    (value) => value === 0,
  );
  const arrivalWindow = finalArrival - firstArrival;
  return {
    requests: results,
    giniEvents,
    timeWeightedLoadGini: arrivalWindow > 0
      ? giniIntegral / arrivalWindow
      : 0,
    mixedStateShare: requests.length > 0
      ? mixedStateCount / requests.length
      : 0,
    capacityRejectedCount,
    finalExperimentLoads: experimentLoads,
    validation: { finalLoadsZero, capacityInvariant },
  };
}

export interface CandidatePreflightObservation {
  scenario: ScenarioDefinition["id"];
  seed: number;
  requestId: string;
  taskType: ExperimentRequest["taskType"];
  difficulty: ExperimentRequest["difficulty"];
  candidateCount: number;
}

export interface CandidatePreflightStratum {
  scenario: ScenarioDefinition["id"];
  seed: number;
  taskType: ExperimentRequest["taskType"];
  difficulty: ExperimentRequest["difficulty"];
  requestCount: number;
  atLeastThreeCount: number;
  atLeastThreeShare: number;
}

export interface CandidatePreflightResult {
  requestCount: number;
  strata: CandidatePreflightStratum[];
}

export function validateCandidateSufficiency(
  observations: readonly CandidatePreflightObservation[],
): CandidatePreflightResult {
  const insufficient = observations.find(
    ({ candidateCount }) => candidateCount < 2,
  );
  if (insufficient) {
    throw new Error(
      `${insufficient.requestId}: every request must have at least 2 candidates`,
    );
  }

  const groups = new Map<string, CandidatePreflightObservation[]>();
  for (const observation of observations) {
    const key = [
      observation.taskType,
      observation.difficulty,
      observation.scenario,
      observation.seed,
    ].join("|");
    const group = groups.get(key);
    if (group) group.push(observation);
    else groups.set(key, [observation]);
  }
  const strata = [...groups.values()].map((group) => {
    const first = group[0];
    const atLeastThreeCount = group.filter(
      ({ candidateCount }) => candidateCount >= 3,
    ).length;
    return {
      scenario: first.scenario,
      seed: first.seed,
      taskType: first.taskType,
      difficulty: first.difficulty,
      requestCount: group.length,
      atLeastThreeCount,
      atLeastThreeShare: atLeastThreeCount / group.length,
    };
  }).sort((left, right) =>
    left.taskType.localeCompare(right.taskType) ||
    left.difficulty.localeCompare(right.difficulty) ||
    left.scenario.localeCompare(right.scenario) ||
    left.seed - right.seed
  );
  const sparse = strata.find(({ atLeastThreeShare }) =>
    atLeastThreeShare < 0.95
  );
  if (sparse) {
    throw new Error(
      `Each task/difficulty/scenario/seed stratum requires 95% with at least 3 candidates`,
    );
  }
  return { requestCount: observations.length, strata };
}

export const assertCandidatePreflight = validateCandidateSufficiency;
