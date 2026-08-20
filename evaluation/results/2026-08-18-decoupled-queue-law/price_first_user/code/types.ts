import type { Difficulty, TaskType } from "../../../../../../server/types.js";

export const SEEDS = [11, 23, 37, 53, 71, 89] as const;
export const REQUEST_COUNT = 2_000;
export const METHODS = [
  "ours-price-first",
  "cheapest-eligible",
  "best-single",
  "irt-router-style",
  "mixllm-style",
  "openrouter-performance-style",
  "least-loaded-eligible"
] as const;

export const QUALITY_TOLERANCES: Readonly<Record<Difficulty, number>> = {
  easy: 0.2,
  medium: 0.1,
  hard: 0.05
};

export type MethodId = (typeof METHODS)[number];
export type QualityThresholds = Record<TaskType, Record<Difficulty, number>>;
export type ScenarioId = "S1" | "S2" | "S3";
export type LoadClass = "low" | "near" | "congested";

export interface ScenarioDefinition {
  id: ScenarioId;
  seed: number;
  requestCount: number;
  arrivalRatePerSecond: number;
  burst?: {
    startFraction: number;
    endFraction: number;
    taskTypes: TaskType[];
    multiplier: number;
  };
}

export interface ExperimentModel {
  id: string;
  baseTtftMs: number;
  basePricePerMillion: number;
  eta: number;
  normalCapacity: number;
  hardCapacity: number;
  quality: Record<TaskType, number>;
}

export interface ExperimentTask {
  taskId: string;
  taskType: TaskType;
  difficulty: Difficulty;
  promptTokens: number;
  maxOutputTokens: number;
}

export interface ExperimentRequest extends ExperimentTask {
  requestId: string;
  arrivalTimeMs: number;
  baseTtftByModel: Record<string, number>;
}

export interface BaselineCandidate {
  model: ExperimentModel;
  quality: number;
  reservedLoad: number;
  loadBefore: number;
  postLoad: number;
  baseTtftMs: number;
  queueWaitMs: number;
  endToEndTtftMs: number;
}

export interface PriceCandidate extends BaselineCandidate {
  dynamicQuote: number;
}

export interface CandidateSnapshot {
  baselineCandidates: readonly BaselineCandidate[];
  priceCandidates: readonly PriceCandidate[];
}
