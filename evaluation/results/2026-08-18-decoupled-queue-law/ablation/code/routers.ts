import { quoteForMethod, queueTiming } from "./queue-model.js";
import type {
  Cohort,
  DecisionCandidate,
  ExperimentModel,
  ExperimentRequest,
  MethodConfig,
  RouteDecision,
  TaskType
} from "./types.js";

export interface CandidateBuildInput {
  request: ExperimentRequest;
  models: readonly ExperimentModel[];
  thresholds: Readonly<Record<TaskType, number>>;
  experimentLoads: Readonly<Record<string, number>>;
  config: MethodConfig;
}

function supports(
  model: ExperimentModel,
  required: readonly string[] | undefined
): boolean {
  if (!required || required.length === 0) return true;
  const available = new Set(model.capabilities ?? []);
  return required.every((capability) => available.has(capability));
}

export function buildCandidates(
  input: CandidateBuildInput
): DecisionCandidate[] {
  return input.models.flatMap((model): DecisionCandidate[] => {
    if (!supports(model, input.request.requiredCapabilities)) return [];
    const quality = model.quality[input.request.taskType];
    if (
      input.config.qualityFiltering &&
      quality < input.thresholds[input.request.taskType]
    ) {
      return [];
    }
    const reservedLoad = input.request.reservedLoadByModel[model.id] ??
      input.request.promptTokens + model.eta * input.request.maxOutputTokens;
    const currentLoad =
      (input.request.backgroundLoadByModel[model.id] ?? 0) +
      (input.experimentLoads[model.id] ?? 0);
    const postLoad = currentLoad + reservedLoad;
    if (input.config.hardCapAdmission && postLoad >= model.hardCapacity) {
      return [];
    }
    const naturalTtftMs = input.request.naturalTtftByModel[model.id];
    if (!Number.isFinite(naturalTtftMs) || naturalTtftMs <= 0) {
      throw new Error(`${model.id}: missing positive paired natural TTFT`);
    }
    const timingLoad = input.config.hardCapAdmission
      ? postLoad
      : Math.min(postLoad, model.hardCapacity - 1);
    const timing = queueTiming(
      timingLoad,
      model.normalCapacity,
      model.hardCapacity,
      naturalTtftMs
    );
    if (!timing) return [];
    return [{
      modelId: model.id,
      quality,
      basePricePerMillion: model.basePricePerMillion,
      quotePerMillion: quoteForMethod(
        model,
        currentLoad,
        reservedLoad,
        input.config
      ),
      currentLoad,
      reservedLoad,
      postLoad,
      normalCapacity: model.normalCapacity,
      hardCapacity: model.hardCapacity,
      naturalTtftMs,
      queueWaitMs: timing.queueWaitMs
    }];
  }).sort((left, right) => left.modelId.localeCompare(right.modelId));
}

function compareNumber(left: number, right: number): number {
  return left - right;
}

export function selectQualityFirst(
  candidates: readonly DecisionCandidate[]
): DecisionCandidate | undefined {
  return [...candidates].sort((left, right) =>
    compareNumber(left.queueWaitMs, right.queueWaitMs) ||
    compareNumber(left.naturalTtftMs, right.naturalTtftMs) ||
    compareNumber(left.quotePerMillion, right.quotePerMillion) ||
    compareNumber(right.quality, left.quality) ||
    left.modelId.localeCompare(right.modelId)
  )[0];
}

export function selectPriceFirst(
  candidates: readonly DecisionCandidate[]
): DecisionCandidate | undefined {
  return [...candidates].sort((left, right) =>
    compareNumber(left.quotePerMillion, right.quotePerMillion) ||
    compareNumber(left.queueWaitMs, right.queueWaitMs) ||
    compareNumber(left.naturalTtftMs, right.naturalTtftMs) ||
    compareNumber(right.quality, left.quality) ||
    left.modelId.localeCompare(right.modelId)
  )[0];
}

function selectedDecision(
  candidate: DecisionCandidate | undefined,
  reason: RouteDecision["reason"],
  fallbackActivated: boolean
): RouteDecision {
  return {
    modelId: candidate?.modelId ?? null,
    reason: candidate ? reason : "no-eligible-candidate",
    fallbackActivated
  };
}

export function selectFixedStrict(
  candidates: readonly DecisionCandidate[],
  fixedModelId: string
): RouteDecision {
  const fixed = candidates.find((candidate) =>
    candidate.modelId === fixedModelId
  );
  return fixed
    ? selectedDecision(fixed, "fixed-selected", false)
    : {
        modelId: null,
        reason: "fixed-unavailable",
        fallbackActivated: false
      };
}

export function selectFixedFallback(
  candidates: readonly DecisionCandidate[],
  fixedModelId: string,
  authorizedFallbackModelIds: readonly string[]
): RouteDecision {
  const fixed = candidates.find((candidate) =>
    candidate.modelId === fixedModelId
  );
  if (fixed) return selectedDecision(fixed, "fixed-selected", false);
  const authorized = new Set(authorizedFallbackModelIds);
  const fallback = [...candidates]
    .filter((candidate) => authorized.has(candidate.modelId))
    .sort((left, right) =>
      compareNumber(left.quotePerMillion, right.quotePerMillion) ||
      compareNumber(left.queueWaitMs, right.queueWaitMs) ||
      compareNumber(left.naturalTtftMs, right.naturalTtftMs) ||
      left.modelId.localeCompare(right.modelId)
    )[0];
  return selectedDecision(fallback, "fallback-selected", true);
}

export function routeCandidates(
  cohort: Cohort,
  candidates: readonly DecisionCandidate[],
  fixedModelId?: string,
  authorizedFallbackModelIds: readonly string[] = []
): RouteDecision {
  if (cohort === "quality-first") {
    return selectedDecision(
      selectQualityFirst(candidates),
      "selected",
      false
    );
  }
  if (cohort === "price-first") {
    return selectedDecision(selectPriceFirst(candidates), "selected", false);
  }
  if (!fixedModelId) {
    return {
      modelId: null,
      reason: "fixed-unavailable",
      fallbackActivated: cohort === "fixed-fallback"
    };
  }
  return cohort === "fixed-strict"
    ? selectFixedStrict(candidates, fixedModelId)
    : selectFixedFallback(
        candidates,
        fixedModelId,
        authorizedFallbackModelIds
      );
}
