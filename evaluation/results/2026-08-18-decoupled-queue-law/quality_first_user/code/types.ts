import type { Difficulty, TaskType } from "../../../../server/types.js";

export const SEEDS = [11, 23, 37, 53, 71, 89] as const;
export const REQUEST_COUNT = 2_000;
export const QUALITY_EPSILON = 0.02;
export const METHODS = [
  "ours",
  "best-single",
  "cheapest-eligible",
  "irt-router-style",
  "mixllm-style",
  "openrouter-performance-style",
  "least-loaded-eligible"
] as const;

export type ScenarioId = "S1" | "S2" | "S3";
export type LoadClass = "low" | "near" | "congested";
export type MethodId = (typeof METHODS)[number];
export type RouterId = MethodId | "balanced-reference";

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

export interface RouteCandidate {
  model: ExperimentModel;
  quality: number;
  reservedLoad: number;
  loadBefore: number;
  postLoad: number;
  baseTtftMs: number;
  queueWaitMs: number;
  endToEndTtftMs: number;
  postAdmissionGini: number;
}

export interface RouteDecision {
  modelId: string | null;
  reason: string;
}
