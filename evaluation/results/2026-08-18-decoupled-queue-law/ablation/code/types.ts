export const SEEDS = [11, 23, 37, 53, 71, 89] as const;

export const CORE_METHODS = [
  "full",
  "no-quality-filtering",
  "no-dynamic-cap",
  "pre-update-cap-pricing",
  "no-hard-cap-admission",
  "no-capacity-awareness"
] as const;

export const PREFERENCE_METHODS = [
  "preference-aware-full",
  "single-policy-pq-cap",
  "preference-aware-static-router"
] as const;

export const INDEPENDENT_COHORTS = [
  "quality-first",
  "price-first"
] as const;

export const MIXED_COHORTS = [
  "quality-first",
  "price-first",
  "fixed-strict",
  "fixed-fallback"
] as const;

export const TASK_TYPES = [
  "coding",
  "math",
  "reasoning",
  "writing",
  "translation",
  "general-qa"
] as const;

export const INDEPENDENT_REQUEST_COUNT = 2_000;
export const MIXED_REQUEST_COUNT = 2_000;
export const MIXED_COHORT_QUOTA = 500;

export type Seed = (typeof SEEDS)[number];
export type CoreMethod = (typeof CORE_METHODS)[number];
export type PreferenceMethod = (typeof PREFERENCE_METHODS)[number];
export type FormalMethod = CoreMethod | PreferenceMethod;
export type IndependentCohort = (typeof INDEPENDENT_COHORTS)[number];
export type MixedCohort = (typeof MIXED_COHORTS)[number];
export type Cohort = MixedCohort;
export type TaskType = (typeof TASK_TYPES)[number];
export type Difficulty = "easy" | "medium" | "hard";
export type ScenarioId =
  | "regular"
  | "soft-congestion"
  | "mixed-regular";

export interface MethodConfig {
  qualityFiltering: boolean;
  dynamicCap: boolean;
  capLoad: "current" | "post" | "none";
  hardCapAdmission: boolean;
}

export const METHOD_CONFIGS: Readonly<Record<CoreMethod, MethodConfig>> = {
  full: {
    qualityFiltering: true,
    dynamicCap: true,
    capLoad: "post",
    hardCapAdmission: true
  },
  "no-quality-filtering": {
    qualityFiltering: false,
    dynamicCap: true,
    capLoad: "post",
    hardCapAdmission: true
  },
  "no-dynamic-cap": {
    qualityFiltering: true,
    dynamicCap: false,
    capLoad: "none",
    hardCapAdmission: true
  },
  "pre-update-cap-pricing": {
    qualityFiltering: true,
    dynamicCap: true,
    capLoad: "current",
    hardCapAdmission: true
  },
  "no-hard-cap-admission": {
    qualityFiltering: true,
    dynamicCap: true,
    capLoad: "post",
    hardCapAdmission: false
  },
  "no-capacity-awareness": {
    qualityFiltering: true,
    dynamicCap: false,
    capLoad: "none",
    hardCapAdmission: false
  }
};

export interface ExperimentModel {
  id: string;
  baseTtftMs: number;
  basePricePerMillion: number;
  eta: number;
  normalCapacity: number;
  hardCapacity: number;
  quality: Record<TaskType, number>;
  capabilities?: readonly string[];
}

export interface ExperimentTask {
  taskId: string;
  taskType: TaskType;
  difficulty: Difficulty;
  promptTokens: number;
  maxOutputTokens: number;
  requiredCapabilities?: readonly string[];
}

export interface ExperimentRequest extends ExperimentTask {
  requestId: string;
  scenario: ScenarioId;
  seed: number;
  cohort: Cohort;
  arrivalTimeMs: number;
  reservedLoadByModel: Readonly<Record<string, number>>;
  naturalTtftByModel: Readonly<Record<string, number>>;
  backgroundLoadByModel: Readonly<Record<string, number>>;
  fixedModelId?: string;
  authorizedFallbackModelIds?: readonly string[];
  traceHash: string;
}

export interface DecisionCandidate {
  modelId: string;
  quality: number;
  basePricePerMillion: number;
  quotePerMillion: number;
  currentLoad: number;
  reservedLoad: number;
  postLoad: number;
  normalCapacity: number;
  hardCapacity: number;
  naturalTtftMs: number;
  queueWaitMs: number;
}

export interface RouteDecision {
  modelId: string | null;
  reason:
    | "selected"
    | "fixed-selected"
    | "fixed-unavailable"
    | "fallback-selected"
    | "no-eligible-candidate";
  fallbackActivated: boolean;
}

export type RequestStatus =
  | "completed"
  | "rejected"
  | "capacity-failure";

export interface RequestResult {
  scenario: ScenarioId;
  seed: number;
  method: FormalMethod | CoreMethod;
  cohort: Cohort;
  requestId: string;
  traceHash: string;
  status: RequestStatus;
  completed: boolean;
  modelId: string | null;
  currentLoad: number | null;
  reservedLoad: number | null;
  postLoad: number | null;
  normalCapacity: number | null;
  hardCapacity: number | null;
  quality: number | null;
  lockedPayment: number | null;
  naturalTtftMs: number | null;
  queueWaitMs: number | null;
  endToEndTtftMs: number | null;
  fixedModelId: string | null;
  fixedAdhered: boolean | null;
  fallbackActivated: boolean;
  fallbackSucceeded: boolean | null;
}

export interface PerSeedRow {
  scenario: ScenarioId;
  seed: number;
  method: FormalMethod | CoreMethod;
  cohort: Cohort | "balanced";
  requestCount: number;
  completedCount: number;
  averageQuality: number | null;
  averageLockedPayment: number | null;
  p95EndToEndTtftMs: number | null;
  p95QueueWaitMs: number | null;
  completionRate: number;
  loadGini: number;
  hardCapRejectionOrFailureShare: number;
  fixedAdherenceRate: number | null;
  fallbackActivationRate: number | null;
  fallbackSuccessRate: number | null;
}
