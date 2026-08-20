export const TASK_TYPES = [
  "coding",
  "math",
  "reasoning",
  "writing",
  "translation",
  "general-qa"
] as const;

export type TaskType = (typeof TASK_TYPES)[number];
export type Difficulty = "easy" | "medium" | "hard";
export type ContextPattern = "single" | "cross-document" | "cross-section";
export type PreferenceMode = "price" | "quality" | "fixed";
export type FixedFallback = "same-quality" | "unavailable";

export interface Requirements {
  minContextTokens: number;
  needsVision: boolean;
  needsTools: boolean;
  needsJsonOutput: boolean;
  contextPattern: ContextPattern;
}

export interface RequestProfile {
  taskType: TaskType;
  difficulty: Difficulty;
  requirements: Requirements;
  confidence: number;
  source: "auto" | "manual" | "mixed";
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: "openrouter" | "openai-compatible";
  baseUrl: string;
  baseUrlEnv?: string;
  apiKeyEnv: string;
  upstreamModel: string;
  upstreamModelEnv?: string;
  enabled: boolean;
  canRoute: boolean;
  supportsJsonMode: boolean;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  basePricePerMillion: number;
  gammaPerMillion: number;
  normalCapacity: number;
  hardCapacity: number;
  eta: number;
  maxContextTokens: number;
  capabilities: {
    vision: boolean;
    tools: boolean;
    json: boolean;
  };
  quality: Record<TaskType, number>;
  qualitySource: string;
}

export interface Preference {
  mode: PreferenceMode;
  fixedModelId?: string;
  fixedFallback?: FixedFallback;
}

export interface CandidateDecision {
  modelId: string;
  modelName: string;
  provider: ModelConfig["provider"];
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

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
  estimated: boolean;
}

export interface RequestLog {
  id: string;
  createdAt: string;
  promptPreview: string;
  profile?: RequestProfile;
  preference: Preference;
  selectedModelId?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  ttftMs?: number;
  totalLatencyMs?: number;
  usage?: Usage;
  upstreamCost?: number;
  lockedPayment?: number;
  responsePreview?: string;
  error?: string;
  decision?: RouteDecision;
}
