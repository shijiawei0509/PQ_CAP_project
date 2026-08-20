import type { Difficulty, TaskType } from "../../../../server/types.js";
import { queueTiming } from "./queue-model.js";
import {
  METHODS,
  type ExperimentModel,
  type ExperimentRequest,
  type MethodId,
  type RouterId,
  type RouteCandidate
} from "./types.js";

export interface RouterInput {
  request: ExperimentRequest;
  models: readonly ExperimentModel[];
  thresholds: Readonly<Record<TaskType, number>>;
  totalLoads: Readonly<Record<string, number>>;
  recentTtfts: Readonly<Record<string, readonly number[]>>;
  candidates?: readonly RouteCandidate[];
}

export interface RouterSelection {
  modelId: string | null;
  reason: string;
  eligibleIds: string[];
}

export interface ExperimentRouter {
  id: RouterId;
  select(input: RouterInput): RouterSelection;
}

function gini(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort(compareNumber);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;
  const weighted = sorted.reduce(
    (sum, value, index) => sum + (2 * (index + 1) - sorted.length - 1) * value,
    0
  );
  return weighted / (sorted.length * total);
}

export function normalizedLoadGini(
  models: readonly ExperimentModel[],
  totalLoads: Readonly<Record<string, number>>,
  selectedModelId?: string,
  reservedLoad = 0
): number {
  return gini(models.map((model) => {
    const load = (totalLoads[model.id] ?? 0) +
      (model.id === selectedModelId ? reservedLoad : 0);
    return load / model.normalCapacity;
  }));
}

export function buildCandidates(input: Omit<RouterInput, "candidates">): RouteCandidate[] {
  const request = input.request;
  return input.models.flatMap((model) => {
    const quality = model.quality[request.taskType];
    if (quality < input.thresholds[request.taskType]) return [];
    const reservedLoad = request.promptTokens + model.eta * request.maxOutputTokens;
    const loadBefore = input.totalLoads[model.id] ?? 0;
    const postLoad = loadBefore + reservedLoad;
    const baseTtftMs = request.baseTtftByModel[model.id];
    if (!(baseTtftMs > 0)) throw new Error(`${model.id}: missing positive paired base TTFT`);
    const timing = queueTiming(
      postLoad,
      model.normalCapacity,
      model.hardCapacity,
      baseTtftMs
    );
    if (!timing) return [];
    return [{
      model,
      quality,
      reservedLoad,
      loadBefore,
      postLoad,
      baseTtftMs,
      queueWaitMs: timing.queueWaitMs,
      endToEndTtftMs: timing.endToEndTtftMs,
      postAdmissionGini: normalizedLoadGini(
        input.models,
        input.totalLoads,
        model.id,
        reservedLoad
      )
    }];
  }).sort((left, right) => left.model.id.localeCompare(right.model.id));
}

function compareNumber(left: number, right: number): number {
  return left - right;
}

export function selectOurs(candidates: readonly RouteCandidate[]): RouteCandidate | undefined {
  return [...candidates].sort((left, right) =>
    compareNumber(
      Number(left.postLoad > left.model.normalCapacity),
      Number(right.postLoad > right.model.normalCapacity)
    ) ||
    compareNumber(left.queueWaitMs, right.queueWaitMs) ||
    compareNumber(left.baseTtftMs, right.baseTtftMs) ||
    compareNumber(left.postAdmissionGini, right.postAdmissionGini) ||
    compareNumber(right.quality, left.quality) ||
    compareNumber(left.model.basePricePerMillion, right.model.basePricePerMillion) ||
    left.model.id.localeCompare(right.model.id)
  )[0];
}

export function selectCheapest(
  candidates: readonly RouteCandidate[]
): RouteCandidate | undefined {
  return [...candidates].sort((left, right) =>
    compareNumber(left.model.basePricePerMillion, right.model.basePricePerMillion) ||
    compareNumber(right.quality, left.quality) ||
    compareNumber(left.baseTtftMs, right.baseTtftMs) ||
    left.model.id.localeCompare(right.model.id)
  )[0];
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort(compareNumber);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
}

function normalize(value: number, values: readonly number[]): number {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return maximum === minimum ? 0 : (value - minimum) / (maximum - minimum);
}

function candidatesFrom(input: RouterInput): readonly RouteCandidate[] {
  return input.candidates ?? buildCandidates(input);
}

function selection(
  candidates: readonly RouteCandidate[],
  selected: RouteCandidate | undefined,
  reason: string
): RouterSelection {
  return {
    modelId: selected?.model.id ?? null,
    reason: selected ? reason : "no eligible model",
    eligibleIds: candidates.map((candidate) => candidate.model.id)
  };
}

function difficultyTarget(difficulty: Difficulty): number {
  return { easy: 0.55, medium: 0.7, hard: 0.8 }[difficulty];
}

export function createRouters(bestSingleModelId: string): ExperimentRouter[] {
  const routers: ExperimentRouter[] = [
    {
      id: "ours",
      select(input) {
        const candidates = candidatesFrom(input);
        return selection(candidates, selectOurs(candidates), "quality-first threshold queue");
      }
    },
    {
      id: "best-single",
      select(input) {
        const candidates = candidatesFrom(input);
        return selection(
          candidates,
          candidates.find((candidate) => candidate.model.id === bestSingleModelId),
          "fixed best single"
        );
      }
    },
    {
      id: "cheapest-eligible",
      select(input) {
        const candidates = candidatesFrom(input);
        return selection(candidates, selectCheapest(candidates), "lowest static price");
      }
    },
    {
      id: "irt-router-style",
      select(input) {
        const candidates = candidatesFrom(input);
        const target = difficultyTarget(input.request.difficulty);
        const selected = [...candidates].sort((left, right) => {
          const leftProbability = 1 / (1 + Math.exp(-8 * (left.quality - target)));
          const rightProbability = 1 / (1 + Math.exp(-8 * (right.quality - target)));
          return rightProbability - leftProbability ||
            left.model.id.localeCompare(right.model.id);
        })[0];
        return selection(candidates, selected, "IRT-style quality match");
      }
    },
    {
      id: "mixllm-style",
      select(input) {
        const candidates = candidatesFrom(input);
        const costs = candidates.map((candidate) => candidate.model.basePricePerMillion);
        const latencies = candidates.map((candidate) => {
          const recent = input.recentTtfts[candidate.model.id] ?? [];
          return recent.length > 0 ? percentile95(recent) : candidate.baseTtftMs;
        });
        const selected = candidates.map((candidate, index) => ({
          candidate,
          score:
            0.5 * candidate.quality +
            0.25 * (1 - normalize(costs[index], costs)) +
            0.25 * (1 - normalize(latencies[index], latencies))
        })).sort((left, right) =>
          right.score - left.score ||
          left.candidate.model.id.localeCompare(right.candidate.model.id)
        )[0]?.candidate;
        return selection(candidates, selected, "MixLLM-style frozen score");
      }
    },
    {
      id: "openrouter-performance-style",
      select(input) {
        const candidates = candidatesFrom(input);
        const selected = [...candidates].sort((left, right) => {
          const leftRecent = input.recentTtfts[left.model.id] ?? [];
          const rightRecent = input.recentTtfts[right.model.id] ?? [];
          const leftLatency = leftRecent.length ? percentile95(leftRecent) : left.baseTtftMs;
          const rightLatency = rightRecent.length ? percentile95(rightRecent) : right.baseTtftMs;
          return leftLatency - rightLatency ||
            left.model.id.localeCompare(right.model.id);
        })[0];
        return selection(candidates, selected, "lowest rolling P95 total TTFT");
      }
    },
    {
      id: "least-loaded-eligible",
      select(input) {
        const candidates = candidatesFrom(input);
        const selected = [...candidates].sort((left, right) =>
          left.postLoad / left.model.normalCapacity -
            right.postLoad / right.model.normalCapacity ||
          left.endToEndTtftMs - right.endToEndTtftMs ||
          right.quality - left.quality ||
          left.model.id.localeCompare(right.model.id)
        )[0];
        return selection(candidates, selected, "lowest normalized post-load");
      }
    }
  ];
  if (routers.map((router) => router.id).join("|") !== METHODS.join("|")) {
    throw new Error("Router order does not match frozen methods");
  }
  return routers;
}

export function createBalancedReferenceRouter(): ExperimentRouter {
  let nextIndex = 0;
  return {
    id: "balanced-reference",
    select(input) {
      const candidates = candidatesFrom(input);
      const selected = candidates.length > 0
        ? candidates[nextIndex++ % candidates.length]
        : undefined;
      return selection(candidates, selected, "balanced reference cycle");
    }
  };
}
