import { isModelConfigured } from "./config.js";
import type {
  CandidateDecision,
  ModelConfig,
  Preference,
  RequestProfile,
  RouteDecision
} from "./types.js";

const DIFFICULTY_DELTA = { easy: 0.2, medium: 0.1, hard: 0.05 } as const;
export const QUALITY_EPSILON = 0.02;

export function estimateTokens(text: string): number {
  let estimate = 0;
  for (const character of text) {
    estimate += /[\u3400-\u9fff\uf900-\ufaff]/u.test(character) ? 1 : 0.25;
  }
  return Math.max(1, Math.ceil(estimate));
}

export function capPrice(model: ModelConfig, postLoad: number): number {
  if (postLoad > model.hardCapacity) return Number.POSITIVE_INFINITY;
  if (postLoad <= model.normalCapacity) return model.basePricePerMillion;
  return (
    model.basePricePerMillion +
    model.gammaPerMillion *
      ((postLoad - model.normalCapacity) / Math.max(1, model.hardCapacity - postLoad))
  );
}

function supportReasons(model: ModelConfig, profile: RequestProfile, postLoad: number): string[] {
  const reasons: string[] = [];
  if (!model.enabled) reasons.push("模型已停用");
  if (!isModelConfigured(model)) reasons.push("API Key 未配置");
  if (profile.requirements.minContextTokens > model.maxContextTokens) reasons.push("上下文容量不足");
  if (profile.requirements.needsVision && !model.capabilities.vision) reasons.push("不支持视觉输入");
  if (profile.requirements.needsTools && !model.capabilities.tools) reasons.push("不支持工具调用");
  if (profile.requirements.needsJsonOutput && !model.capabilities.json) reasons.push("不支持结构化输出");
  if (postLoad > model.hardCapacity) reasons.push("接纳后触及硬容量边界");
  return reasons;
}

export function routeRequest(args: {
  models: ModelConfig[];
  loads: ReadonlyMap<string, number>;
  profile: RequestProfile;
  preference: Preference;
  prompt: string;
  maxOutputTokens: number;
  configuredOverride?: ReadonlySet<string>;
}): RouteDecision {
  const inputTokensEstimated = estimateTokens(args.prompt);
  const candidates: CandidateDecision[] = args.models.map((model) => {
    const currentLoad = args.loads.get(model.id) ?? 0;
    const reservedLoad = inputTokensEstimated + model.eta * args.maxOutputTokens;
    const postLoad = currentLoad + reservedLoad;
    const reasons = supportReasons(model, args.profile, postLoad);

    if (args.configuredOverride?.has(model.id)) {
      const keyReasonIndex = reasons.indexOf("API Key 未配置");
      if (keyReasonIndex >= 0) reasons.splice(keyReasonIndex, 1);
    }

    const feasible = reasons.length === 0;
    return {
      modelId: model.id,
      modelName: model.name,
      provider: model.provider,
      configured: !reasons.includes("API Key 未配置"),
      currentLoad,
      reservedLoad,
      postLoad,
      normalCapacity: model.normalCapacity,
      hardCapacity: model.hardCapacity,
      quality: model.quality[args.profile.taskType],
      quotePerMillion: feasible ? capPrice(model, postLoad) : null,
      eligible: feasible,
      selected: false,
      reasons
    };
  });

  const feasible = candidates.filter((candidate) => candidate.eligible);
  if (feasible.length === 0) {
    throw new Error("没有满足能力、凭据和硬容量约束的模型");
  }

  const maxQuality = Math.max(...feasible.map((candidate) => candidate.quality));
  let qualityThreshold: number | null = null;
  let pool: CandidateDecision[] = [];
  let explanation = "";

  if (args.preference.mode === "fixed") {
    const fixed = feasible.find((candidate) => candidate.modelId === args.preference.fixedModelId);
    if (fixed) {
      pool = [fixed];
      explanation = `固定模型 ${fixed.modelName} 当前可服务，保持用户锁定选择`;
    } else if (args.preference.fixedFallback === "same-quality") {
      const configuredFixed = candidates.find((candidate) => candidate.modelId === args.preference.fixedModelId);
      if (!configuredFixed) throw new Error("固定模型不存在");
      qualityThreshold = configuredFixed.quality - QUALITY_EPSILON;
      pool = feasible.filter((candidate) => candidate.quality >= qualityThreshold!);
      if (pool.length === 0) throw new Error("固定模型不可用，且没有同质量档位的回退模型");
      explanation = "固定模型不可用，按授权回退到同质量档位最低报价模型";
    } else {
      throw new Error("固定模型当前不可用，异常策略要求直接返回");
    }
  } else if (args.preference.mode === "price") {
    qualityThreshold = maxQuality - DIFFICULTY_DELTA[args.profile.difficulty];
    pool = feasible.filter((candidate) => candidate.quality >= qualityThreshold!);
    explanation = `${args.profile.difficulty} 难度质量门槛 ${qualityThreshold.toFixed(3)}，选择合格模型中的最低报价`;
  } else {
    qualityThreshold = maxQuality - QUALITY_EPSILON;
    pool = feasible.filter((candidate) => candidate.quality >= qualityThreshold!);
    explanation = `近似最优质量门槛 ${qualityThreshold.toFixed(3)}，选择高质量集合中的最低报价`;
  }

  const selected = [...pool].sort((a, b) => {
    const priceDifference = (a.quotePerMillion ?? Infinity) - (b.quotePerMillion ?? Infinity);
    return priceDifference || b.quality - a.quality || a.modelId.localeCompare(b.modelId);
  })[0];
  if (!selected) throw new Error("路由候选集合为空");

  for (const candidate of candidates) {
    candidate.selected = candidate.modelId === selected.modelId;
    if (!candidate.eligible) continue;
    if (!pool.some((item) => item.modelId === candidate.modelId)) {
      candidate.eligible = false;
      candidate.reasons.push("低于当前偏好要求的质量门槛");
    } else if (!candidate.selected) {
      candidate.reasons.push("报价高于选中模型");
    } else {
      candidate.reasons.push("满足约束且在当前偏好下最优");
    }
  }

  return {
    selectedModelId: selected.modelId,
    qualityThreshold,
    qualityRegret: maxQuality - selected.quality,
    inputTokensEstimated,
    candidates,
    explanation
  };
}
