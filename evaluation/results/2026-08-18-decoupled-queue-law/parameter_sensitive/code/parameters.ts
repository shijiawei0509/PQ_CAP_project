import { TASK_TYPES, type Difficulty } from "../../../../../../server/types.js";
import type {
  ExperimentModel,
  QualityThresholds,
} from "../../price_first_user/code/types.js";

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export const DEFAULT_TOLERANCES: Readonly<Record<Difficulty, number>> = {
  easy: 0.20,
  medium: 0.10,
  hard: 0.05,
};
export const BLIND_TOLERANCES: Readonly<Record<Difficulty, number>> = {
  easy: 0.10,
  medium: 0.10,
  hard: 0.10,
};
export const DELTA_SCALES = [0.50, 0.75, 1.00, 1.25, 1.50] as const;
export const KAPPA_VALUES = [0, 0.25, 0.5, 1, 2, 4] as const;
export const INTERACTION_DELTA_SCALES = [0.75, 1, 1.25] as const;
export const INTERACTION_KAPPAS = [0.5, 1, 2] as const;
export const PILOT_SEEDS = [101, 103, 107] as const;
export const FORMAL_SEEDS = [11, 23, 37, 53, 71, 89] as const;

export function scaledTolerances(
  scale: number,
): Readonly<Record<Difficulty, number>> {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError("Difficulty-tolerance scale must be positive and finite");
  }
  return {
    easy: DEFAULT_TOLERANCES.easy * scale,
    medium: DEFAULT_TOLERANCES.medium * scale,
    hard: DEFAULT_TOLERANCES.hard * scale,
  };
}

export function freezeThresholds(
  models: readonly ExperimentModel[],
  tolerances: Readonly<Record<Difficulty, number>>,
): QualityThresholds {
  if (models.length === 0) throw new Error("Cannot freeze an empty model pool");
  for (const difficulty of DIFFICULTIES) {
    const value = tolerances[difficulty];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`${difficulty} tolerance must be within [0, 1]`);
    }
  }
  return Object.fromEntries(TASK_TYPES.map((taskType) => {
    const maximum = Math.max(...models.map((model) => model.quality[taskType]));
    return [taskType, Object.fromEntries(DIFFICULTIES.map((difficulty) => [
      difficulty,
      maximum - tolerances[difficulty],
    ]))];
  })) as QualityThresholds;
}

export function capQuoteWithKappa(
  basePrice: number,
  postLoad: number,
  normalCapacity: number,
  hardCapacity: number,
  kappa: number,
): number {
  if (!Number.isFinite(basePrice) || basePrice < 0) {
    throw new RangeError("Base price must be non-negative and finite");
  }
  if (!Number.isFinite(kappa) || kappa < 0) {
    throw new RangeError("Kappa must be non-negative and finite");
  }
  if (!(normalCapacity > 0) || !(hardCapacity > normalCapacity)) {
    throw new RangeError("Invalid capacity boundaries");
  }
  if (!Number.isFinite(postLoad) || postLoad < 0 || postLoad >= hardCapacity) {
    throw new RangeError("Post-load must be finite and within [0, C)");
  }
  if (postLoad <= normalCapacity || kappa === 0) return basePrice;
  const position = (postLoad - normalCapacity) /
    (hardCapacity - normalCapacity);
  return basePrice * (1 + kappa * position / (1 - position));
}
