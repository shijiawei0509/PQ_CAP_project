import type { ExperimentModel, MethodConfig } from "./types.js";

export type QueueLaw = "odds" | "linear" | "quadratic";

/**
 * Environment queue-wait law for the ablation experiment.
 *
 * Kept in lockstep with ../../price_first_user/code/queue-model.ts and
 * ../../../code/queue-model.ts: three laws behind the QUEUE_LAW switch,
 * identical boundary semantics, decoupled from the CAP pricing rule
 * (which stays r_m(1 + (l - B_m)/(C_m - l)) in capQuote below — the
 * pricing function is the mechanism under test and is NOT changed).
 */
export interface QueueTiming {
  queueWaitMs: number;
  endToEndTtftMs: number;
}

export const QUEUE_LAW: QueueLaw = (() => {
  const value = process.env.QUEUE_LAW;
  if (value === "linear" || value === "quadratic" || value === "odds") return value;
  if (value === undefined || value === "") return "linear";
  throw new Error(`Unknown QUEUE_LAW: ${value}`);
})();

const LINEAR_ALPHA = 4;
const QUADRATIC_ALPHA = 6;

function assertCapacity(
  normalCapacity: number,
  hardCapacity: number
): void {
  if (
    !Number.isFinite(normalCapacity) ||
    !Number.isFinite(hardCapacity) ||
    normalCapacity <= 0 ||
    hardCapacity <= normalCapacity
  ) {
    throw new RangeError("Invalid capacity boundaries");
  }
}

export function queueTiming(
  postLoad: number,
  normalCapacity: number,
  hardCapacity: number,
  naturalTtftMs: number
): QueueTiming | null {
  assertCapacity(normalCapacity, hardCapacity);
  if (!Number.isFinite(postLoad) || postLoad < 0) {
    throw new RangeError("Post-load must be non-negative and finite");
  }
  if (!Number.isFinite(naturalTtftMs) || naturalTtftMs <= 0) {
    throw new RangeError("Natural TTFT must be positive and finite");
  }
  if (postLoad >= hardCapacity) return null;
  if (postLoad <= normalCapacity) {
    return {
      queueWaitMs: 0,
      endToEndTtftMs: naturalTtftMs
    };
  }
  const position = (postLoad - normalCapacity) /
    (hardCapacity - normalCapacity);
  let queueWaitMs: number;
  if (QUEUE_LAW === "odds") {
    queueWaitMs = naturalTtftMs * position / (1 - position);
  } else if (QUEUE_LAW === "linear") {
    queueWaitMs = LINEAR_ALPHA * naturalTtftMs * position;
  } else {
    queueWaitMs = QUADRATIC_ALPHA * naturalTtftMs * position * position;
  }
  return {
    queueWaitMs,
    endToEndTtftMs: naturalTtftMs + queueWaitMs
  };
}

export function capQuote(
  basePricePerMillion: number,
  load: number,
  normalCapacity: number,
  hardCapacity: number
): number {
  assertCapacity(normalCapacity, hardCapacity);
  if (!Number.isFinite(basePricePerMillion) || basePricePerMillion < 0) {
    throw new RangeError("Base price must be non-negative and finite");
  }
  if (!Number.isFinite(load) || load < 0 || load >= hardCapacity) {
    throw new RangeError("CAP load must be in [0, C)");
  }
  if (load <= normalCapacity) return basePricePerMillion;
  return basePricePerMillion * (
    1 + (load - normalCapacity) / (hardCapacity - load)
  );
}

export function quoteForMethod(
  model: ExperimentModel,
  currentLoad: number,
  reservedLoad: number,
  config: MethodConfig
): number {
  if (!config.dynamicCap || config.capLoad === "none") {
    return model.basePricePerMillion;
  }
  const requestedLoad = config.capLoad === "current"
    ? currentLoad
    : currentLoad + reservedLoad;
  const pricingLoad = config.hardCapAdmission
    ? requestedLoad
    : Math.min(requestedLoad, model.hardCapacity - 1);
  return capQuote(
    model.basePricePerMillion,
    pricingLoad,
    model.normalCapacity,
    model.hardCapacity
  );
}
