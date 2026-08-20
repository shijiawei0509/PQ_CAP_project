export type TaskType =
  | "coding"
  | "math"
  | "reasoning"
  | "writing"
  | "translation"
  | "general-qa";

export type Difficulty = "easy" | "medium" | "hard";
export type PreferenceMode = "price" | "quality" | "fixed";

export interface PublicModel {
  id: string;
  name: string;
  provider: "openrouter" | "openai-compatible";
  upstreamModel: string;
  enabled: boolean;
  configured: boolean;
  canRoute: boolean;
  basePricePerMillion: number;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  normalCapacity: number;
  hardCapacity: number;
  currentLoad: number;
  quality: Record<TaskType, number>;
  qualitySource: string;
}

export interface RequestProfile {
  taskType: TaskType;
  difficulty: Difficulty;
  requirements: {
    minContextTokens: number;
    needsVision: boolean;
    needsTools: boolean;
    needsJsonOutput: boolean;
    contextPattern: "single" | "cross-document" | "cross-section";
  };
  confidence: number;
  source: "auto" | "manual" | "mixed";
}

export interface CandidateDecision {
  modelId: string;
  modelName: string;
  provider: PublicModel["provider"];
  configured: boolean;
  currentLoad: number;
  reservedLoad: number;
  postLoad: number;
  normalCapacity: number;
  hardCapacity: number;
  quality: number;
  quotePerMillion: number | null;
  eligible: boolean;
  selected: boolean;
  reasons: string[];
}

export interface RouteDecision {
  selectedModelId: string;
  qualityThreshold: number | null;
  qualityRegret: number;
  inputTokensEstimated: number;
  candidates: CandidateDecision[];
  explanation: string;
}

export interface ResultMetrics {
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimated: boolean;
  };
  ttftMs?: number;
  totalLatencyMs: number;
  upstreamCost?: number;
  lockedPayment: number;
}

export interface RequestLog {
  id: string;
  createdAt: string;
  promptPreview: string;
  selectedModelId?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  totalLatencyMs?: number;
  usage?: { totalTokens: number };
  upstreamCost?: number;
  lockedPayment?: number;
  error?: string;
}

export interface BootstrapData {
  routerModelId: string;
  routerConfigured: boolean;
  models: PublicModel[];
  logs: RequestLog[];
}
