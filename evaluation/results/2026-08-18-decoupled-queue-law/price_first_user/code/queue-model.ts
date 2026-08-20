export type QueueLaw = "odds" | "linear" | "quadratic";

/**
 * Queue-wait law used by the simulator environment (price-first cohort).
 *
 * Kept in lockstep with ../../code/queue-model.ts of this experiment —
 * the same three laws, the same QUEUE_LAW switch, the same boundary
 * semantics.  See that file for the decoupling rationale: the CAP premium
 * r_m(1 + kappa (l-B_m)/(C_m-l)) must not share a function family with
 * the environment's queue-wait law.
 */
export interface QueueTiming {
  queueWaitMs: number;
  endToEndTtftMs: number;
  law: QueueLaw;
}

export const QUEUE_LAW: QueueLaw = (() => {
  const value = process.env.QUEUE_LAW;
  if (value === "linear" || value === "quadratic" || value === "odds") return value;
  if (value === undefined || value === "") return "linear";
  throw new Error(`Unknown QUEUE_LAW: ${value}`);
})();

const LINEAR_ALPHA = 4;
const QUADRATIC_ALPHA = 6;

export function queueTiming(
  postLoad: number,
  normalCapacity: number,
  hardCapacity: number,
  baseTtftMs: number
): QueueTiming | null {
  if (!(normalCapacity > 0) || !(hardCapacity > normalCapacity)) {
    throw new Error("Invalid capacity boundaries");
  }
  if (!(baseTtftMs > 0) || !Number.isFinite(baseTtftMs)) {
    throw new Error("Base TTFT must be positive and finite");
  }
  if (!Number.isFinite(postLoad) || postLoad < 0) {
    throw new Error("Post-load must be non-negative and finite");
  }
  if (postLoad >= hardCapacity) {
    return null;
  }
  if (postLoad <= normalCapacity) {
    return { queueWaitMs: 0, endToEndTtftMs: baseTtftMs, law: QUEUE_LAW };
  }

  const position =
    (postLoad - normalCapacity) / (hardCapacity - normalCapacity);
  let queueWaitMs: number;
  if (QUEUE_LAW === "odds") {
    queueWaitMs = baseTtftMs * position / (1 - position);
  } else if (QUEUE_LAW === "linear") {
    queueWaitMs = LINEAR_ALPHA * baseTtftMs * position;
  } else {
    queueWaitMs = QUADRATIC_ALPHA * baseTtftMs * position * position;
  }
  return {
    queueWaitMs,
    endToEndTtftMs: baseTtftMs + queueWaitMs,
    law: QUEUE_LAW
  };
}
