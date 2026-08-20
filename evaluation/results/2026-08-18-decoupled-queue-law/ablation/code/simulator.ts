import {
  buildCandidates,
  routeCandidates
} from "./routers.js";
import type {
  CoreMethod,
  DecisionCandidate,
  ExperimentModel,
  ExperimentRequest,
  FormalMethod,
  MethodConfig,
  RequestResult,
  TaskType
} from "./types.js";

interface ReleaseEvent {
  timeMs: number;
  modelId: string;
  reservedLoad: number;
}

export interface SimulationResult {
  requests: RequestResult[];
  timeWeightedLoadGini: number;
  finalExperimentLoadByModel: Record<string, number>;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function loadDispersion(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = average(values);
  if (mean === 0) return 0;
  let absoluteDifference = 0;
  for (const left of values) {
    for (const right of values) {
      absoluteDifference += Math.abs(left - right);
    }
  }
  return absoluteDifference / (2 * values.length ** 2 * mean);
}

function emptyRow(
  request: ExperimentRequest,
  method: FormalMethod | CoreMethod
): RequestResult {
  return {
    scenario: request.scenario,
    seed: request.seed,
    method,
    cohort: request.cohort,
    requestId: request.requestId,
    traceHash: request.traceHash,
    status: "rejected",
    completed: false,
    modelId: null,
    currentLoad: null,
    reservedLoad: null,
    postLoad: null,
    normalCapacity: null,
    hardCapacity: null,
    quality: null,
    lockedPayment: null,
    naturalTtftMs: null,
    queueWaitMs: null,
    endToEndTtftMs: null,
    fixedModelId: request.fixedModelId ?? null,
    fixedAdhered: request.cohort.startsWith("fixed") ? false : null,
    fallbackActivated: request.cohort === "fixed-fallback",
    fallbackSucceeded: request.cohort === "fixed-fallback" ? false : null
  };
}

export function simulate(args: {
  method: FormalMethod | CoreMethod;
  models: readonly ExperimentModel[];
  thresholds: Readonly<Record<TaskType, number>>;
  requests: readonly ExperimentRequest[];
  config: MethodConfig;
  routeNonFixedAs?: "cohort" | "quality-first";
}): SimulationResult {
  const requestOrder = new Map(
    args.requests.map((request, index) => [request.requestId, index])
  );
  const sortedRequests = [...args.requests].sort((left, right) =>
    left.arrivalTimeMs - right.arrivalTimeMs ||
    left.requestId.localeCompare(right.requestId)
  );
  const experimentLoads = Object.fromEntries(
    args.models.map((model) => [model.id, 0])
  );
  let backgroundLoads: Readonly<Record<string, number>> = {};
  const releases: ReleaseEvent[] = [];
  const requestRows: RequestResult[] = [];
  const modelById = new Map(args.models.map((model) => [model.id, model]));
  const startTime = sortedRequests[0]?.arrivalTimeMs ?? 0;
  const endTime = sortedRequests.at(-1)?.arrivalTimeMs ?? startTime;
  let previousTime = startTime;
  let weightedDispersion = 0;

  const normalizedLoads = (): number[] => args.models.map((model) =>
    ((backgroundLoads[model.id] ?? 0) + experimentLoads[model.id]) /
      model.normalCapacity
  );
  const accumulateUntil = (timeMs: number): void => {
    const boundedTime = Math.min(timeMs, endTime);
    if (boundedTime > previousTime) {
      weightedDispersion += loadDispersion(normalizedLoads()) *
        (boundedTime - previousTime);
      previousTime = boundedTime;
    }
  };
  const processReleasesThrough = (timeMs: number): void => {
    releases.sort((left, right) =>
      left.timeMs - right.timeMs ||
      left.modelId.localeCompare(right.modelId)
    );
    while (releases[0] && releases[0].timeMs <= timeMs) {
      const release = releases.shift()!;
      accumulateUntil(release.timeMs);
      experimentLoads[release.modelId] = Math.max(
        0,
        experimentLoads[release.modelId] - release.reservedLoad
      );
    }
  };

  for (const request of sortedRequests) {
    processReleasesThrough(request.arrivalTimeMs);
    accumulateUntil(request.arrivalTimeMs);
    backgroundLoads = request.backgroundLoadByModel;
    const candidates = buildCandidates({
      request,
      models: args.models,
      thresholds: args.thresholds,
      experimentLoads,
      config: args.config
    });
    const routeCohort = args.routeNonFixedAs === "quality-first" &&
      !request.cohort.startsWith("fixed")
      ? "quality-first"
      : request.cohort;
    const decision = routeCandidates(
      routeCohort,
      candidates,
      request.fixedModelId,
      request.authorizedFallbackModelIds
    );
    const selected = candidates.find((candidate) =>
      candidate.modelId === decision.modelId
    );
    if (!selected) {
      const row = emptyRow(request, args.method);
      row.fallbackActivated = decision.fallbackActivated;
      requestRows.push(row);
      continue;
    }
    const base = resultFromCandidate(request, args.method, selected);
    base.fallbackActivated = decision.fallbackActivated;
    base.fallbackSucceeded = request.cohort === "fixed-fallback"
      ? decision.fallbackActivated
      : null;
    base.fixedAdhered = request.cohort.startsWith("fixed")
      ? selected.modelId === request.fixedModelId
      : null;
    if (selected.postLoad >= selected.hardCapacity) {
      requestRows.push({
        ...base,
        status: "capacity-failure",
        completed: false,
        lockedPayment: null,
        queueWaitMs: null,
        endToEndTtftMs: null,
        fallbackSucceeded: request.cohort === "fixed-fallback" ? false : null
      });
      continue;
    }
    const model = modelById.get(selected.modelId);
    if (!model) throw new Error(`Unknown selected model ${selected.modelId}`);
    experimentLoads[selected.modelId] += selected.reservedLoad;
    const endToEndTtftMs = selected.naturalTtftMs + selected.queueWaitMs;
    releases.push({
      timeMs: request.arrivalTimeMs + endToEndTtftMs,
      modelId: selected.modelId,
      reservedLoad: selected.reservedLoad
    });
    requestRows.push({
      ...base,
      status: "completed",
      completed: true,
      lockedPayment:
        selected.reservedLoad * selected.quotePerMillion / 1_000_000,
      endToEndTtftMs
    });
  }

  processReleasesThrough(Number.POSITIVE_INFINITY);
  const duration = endTime - startTime;
  return {
    requests: requestRows.sort((left, right) =>
      (requestOrder.get(left.requestId) ?? Number.MAX_SAFE_INTEGER) -
      (requestOrder.get(right.requestId) ?? Number.MAX_SAFE_INTEGER)
    ),
    timeWeightedLoadGini: duration > 0
      ? weightedDispersion / duration
      : 0,
    finalExperimentLoadByModel: { ...experimentLoads }
  };
}

function resultFromCandidate(
  request: ExperimentRequest,
  method: FormalMethod | CoreMethod,
  candidate: DecisionCandidate
): RequestResult {
  return {
    scenario: request.scenario,
    seed: request.seed,
    method,
    cohort: request.cohort,
    requestId: request.requestId,
    traceHash: request.traceHash,
    status: "completed",
    completed: true,
    modelId: candidate.modelId,
    currentLoad: candidate.currentLoad,
    reservedLoad: candidate.reservedLoad,
    postLoad: candidate.postLoad,
    normalCapacity: candidate.normalCapacity,
    hardCapacity: candidate.hardCapacity,
    quality: candidate.quality,
    lockedPayment:
      candidate.reservedLoad * candidate.quotePerMillion / 1_000_000,
    naturalTtftMs: candidate.naturalTtftMs,
    queueWaitMs: candidate.queueWaitMs,
    endToEndTtftMs:
      candidate.naturalTtftMs + candidate.queueWaitMs,
    fixedModelId: request.fixedModelId ?? null,
    fixedAdhered: null,
    fallbackActivated: false,
    fallbackSucceeded: null
  };
}
