import type { Difficulty } from "../../../../../../server/types.js";

import { capQuote } from "./pricing";
import { queueTiming } from "./queue-model";
import {
  METHODS,
  type BaselineCandidate,
  type CandidateSnapshot,
  type ExperimentModel,
  type ExperimentRequest,
  type MethodId,
  type PriceCandidate,
  type QualityThresholds,
} from "./types";

export interface CandidateInput {
  request: ExperimentRequest;
  models: readonly ExperimentModel[];
  thresholds: QualityThresholds;
  backgroundLoads: Readonly<Record<string, number>>;
  experimentLoads: Readonly<Record<string, number>>;
}

export interface RouterInput extends CandidateInput {
  recentTtfts: Readonly<Record<string, readonly number[]>>;
}

export interface RouterSelection {
  modelId: string | null;
  reason: string;
  eligibleIds: string[];
  lockedUnitPrice: number | null;
  staticCheapestModelId?: string | null;
  dynamicCheapestModelId?: string | null;
  priceInducedReroute?: boolean;
}

export interface ExperimentRouter {
  id: MethodId;
  select(input: RouterInput): RouterSelection;
}

function compareNumber(left: number, right: number): number {
  return left - right;
}

export function buildBaselineCandidates(
  input: CandidateInput,
): BaselineCandidate[] {
  const { request } = input;
  return input.models.flatMap((model): BaselineCandidate[] => {
    const quality = model.quality[request.taskType];
    if (quality < input.thresholds[request.taskType][request.difficulty]) {
      return [];
    }

    const reservedLoad =
      request.promptTokens + model.eta * request.maxOutputTokens;
    const loadBefore =
      (input.backgroundLoads[model.id] ?? 0) +
      (input.experimentLoads[model.id] ?? 0);
    const postLoad = loadBefore + reservedLoad;
    if (postLoad >= model.hardCapacity) {
      return [];
    }

    const baseTtftMs = request.baseTtftByModel[model.id];
    if (!(baseTtftMs > 0)) {
      throw new Error(`${model.id}: missing positive paired base TTFT`);
    }
    const timing = queueTiming(
      postLoad,
      model.normalCapacity,
      model.hardCapacity,
      baseTtftMs,
    );
    if (!timing) {
      return [];
    }

    return [{
      model,
      quality,
      reservedLoad,
      loadBefore,
      postLoad,
      baseTtftMs,
      queueWaitMs: timing.queueWaitMs,
      endToEndTtftMs: timing.endToEndTtftMs,
    }];
  }).sort((left, right) => left.model.id.localeCompare(right.model.id));
}

export function buildCandidateSnapshot(input: CandidateInput): CandidateSnapshot {
  const baselineCandidates = buildBaselineCandidates(input);
  const priceCandidates: PriceCandidate[] = baselineCandidates.map(
    (candidate) => ({
      ...candidate,
      dynamicQuote: capQuote(
        candidate.model.basePricePerMillion,
        candidate.postLoad,
        candidate.model.normalCapacity,
        candidate.model.hardCapacity,
      ),
    }),
  );

  return {
    baselineCandidates,
    priceCandidates,
  };
}

export function selectOurs(
  candidates: readonly PriceCandidate[],
): PriceCandidate | undefined {
  return [...candidates].sort((left, right) =>
    compareNumber(left.dynamicQuote, right.dynamicQuote) ||
    compareNumber(
      Number(left.postLoad > left.model.normalCapacity),
      Number(right.postLoad > right.model.normalCapacity),
    ) ||
    compareNumber(left.queueWaitMs, right.queueWaitMs) ||
    compareNumber(right.quality, left.quality) ||
    left.model.id.localeCompare(right.model.id)
  )[0];
}

export function selectCheapest(
  candidates: readonly BaselineCandidate[],
): BaselineCandidate | undefined {
  return [...candidates].sort((left, right) =>
    compareNumber(
      left.model.basePricePerMillion,
      right.model.basePricePerMillion,
    ) ||
    compareNumber(
      Number(left.postLoad > left.model.normalCapacity),
      Number(right.postLoad > right.model.normalCapacity),
    ) ||
    compareNumber(left.queueWaitMs, right.queueWaitMs) ||
    compareNumber(right.quality, left.quality) ||
    left.model.id.localeCompare(right.model.id)
  )[0];
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const sorted = [...values].sort(compareNumber);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
}

function normalize(value: number, values: readonly number[]): number {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return maximum === minimum ? 0 : (value - minimum) / (maximum - minimum);
}

function difficultyTarget(difficulty: Difficulty): number {
  return { easy: 0.55, medium: 0.7, hard: 0.8 }[difficulty];
}

function baselineSelection(
  candidates: readonly BaselineCandidate[],
  selected: BaselineCandidate | undefined,
  reason: string,
): RouterSelection {
  return {
    modelId: selected?.model.id ?? null,
    reason: selected ? reason : "no eligible model",
    eligibleIds: candidates.map(({ model }) => model.id),
    lockedUnitPrice: selected?.model.basePricePerMillion ?? null,
  };
}

function oursSelection(snapshot: CandidateSnapshot): RouterSelection {
  const selected = selectOurs(snapshot.priceCandidates);
  const staticSelected = selectCheapest(snapshot.baselineCandidates);
  return {
    modelId: selected?.model.id ?? null,
    reason: selected ? "price-first threshold queue" : "no eligible model",
    eligibleIds: snapshot.priceCandidates.map(({ model }) => model.id),
    lockedUnitPrice: selected?.dynamicQuote ?? null,
    staticCheapestModelId: staticSelected?.model.id ?? null,
    dynamicCheapestModelId: selected?.model.id ?? null,
    priceInducedReroute:
      selected !== undefined &&
      staticSelected !== undefined &&
      selected.model.id !== staticSelected.model.id,
  };
}

export function createRouters(bestSingleModelId: string): ExperimentRouter[] {
  const routers: ExperimentRouter[] = [
    {
      id: "ours-price-first",
      select(input) {
        return oursSelection(buildCandidateSnapshot(input));
      },
    },
    {
      id: "cheapest-eligible",
      select(input) {
        const candidates = buildBaselineCandidates(input);
        return baselineSelection(
          candidates,
          selectCheapest(candidates),
          "lowest static price",
        );
      },
    },
    {
      id: "best-single",
      select(input) {
        const candidates = buildBaselineCandidates(input);
        return baselineSelection(
          candidates,
          candidates.find(
            ({ model }) => model.id === bestSingleModelId,
          ),
          "fixed best single",
        );
      },
    },
    {
      id: "irt-router-style",
      select(input) {
        const candidates = buildBaselineCandidates(input);
        const target = difficultyTarget(input.request.difficulty);
        const selected = [...candidates].sort((left, right) => {
          const leftProbability =
            1 / (1 + Math.exp(-8 * (left.quality - target)));
          const rightProbability =
            1 / (1 + Math.exp(-8 * (right.quality - target)));
          return rightProbability - leftProbability ||
            left.model.id.localeCompare(right.model.id);
        })[0];
        return baselineSelection(
          candidates,
          selected,
          "IRT-style quality match",
        );
      },
    },
    {
      id: "mixllm-style",
      select(input) {
        const candidates = buildBaselineCandidates(input);
        const costs = candidates.map(
          ({ model }) => model.basePricePerMillion,
        );
        const latencies = candidates.map((candidate) => {
          const recent = input.recentTtfts[candidate.model.id] ?? [];
          return recent.length > 0
            ? percentile95(recent)
            : candidate.baseTtftMs;
        });
        const selected = candidates.map((candidate, index) => ({
          candidate,
          score:
            0.5 * candidate.quality +
            0.25 * (1 - normalize(costs[index], costs)) +
            0.25 * (1 - normalize(latencies[index], latencies)),
        })).sort((left, right) =>
          right.score - left.score ||
          left.candidate.model.id.localeCompare(right.candidate.model.id)
        )[0]?.candidate;
        return baselineSelection(
          candidates,
          selected,
          "MixLLM-style frozen score",
        );
      },
    },
    {
      id: "openrouter-performance-style",
      select(input) {
        const candidates = buildBaselineCandidates(input);
        const selected = [...candidates].sort(
          (left, right) => {
            const leftRecent = input.recentTtfts[left.model.id] ?? [];
            const rightRecent = input.recentTtfts[right.model.id] ?? [];
            const leftLatency = leftRecent.length > 0
              ? percentile95(leftRecent)
              : left.baseTtftMs;
            const rightLatency = rightRecent.length > 0
              ? percentile95(rightRecent)
              : right.baseTtftMs;
            return leftLatency - rightLatency ||
              left.model.id.localeCompare(right.model.id);
          },
        )[0];
        return baselineSelection(
          candidates,
          selected,
          "lowest rolling P95 total TTFT",
        );
      },
    },
    {
      id: "least-loaded-eligible",
      select(input) {
        const candidates = buildBaselineCandidates(input);
        const selected = [...candidates].sort(
          (left, right) =>
            left.postLoad / left.model.normalCapacity -
              right.postLoad / right.model.normalCapacity ||
            left.endToEndTtftMs - right.endToEndTtftMs ||
            right.quality - left.quality ||
            left.model.id.localeCompare(right.model.id),
        )[0];
        return baselineSelection(
          candidates,
          selected,
          "lowest normalized post-load",
        );
      },
    },
  ];

  if (routers.map(({ id }) => id).join("|") !== METHODS.join("|")) {
    throw new Error("Router order does not match frozen methods");
  }
  return routers;
}
