export type QueueLaw = "odds" | "linear" | "quadratic";

/**
 * Queue-wait law used by the simulator environment.
 *
 * The environment law is deliberately decoupled from the CAP pricing rule
 * p_m = r_m (1 + kappa (l - B_m)/(C_m - l)).  Routers observe only
 * (normalCapacity, hardCapacity, postLoad) — never the law itself — so any
 * monotone increasing law is a valid environment.  The three laws below are
 * selected via the QUEUE_LAW environment variable:
 *
 *   odds      (legacy reproduction): T_q = T_base * x / (1 - x),  x = (L+ - B)/(C - B)
 *             — structurally identical to the CAP premium; kept only to
 *             reproduce the 2026-07-24 experiment.
 *   linear    (primary):            T_q = 4 * T_base * x
 *             — different function family (no pole, bounded, non-convex),
 *             weaker congestion penalty than any diverging law.
 *   quadratic (robustness):         T_q = 6 * T_base * x^2
 *             — polynomial family, convex acceleration, bounded.
 *
 * All laws share the same boundary semantics: zero wait at or below B_m,
 * strictly increasing in (B_m, C_m), rejection at C_m.
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
  if (postLoad >= hardCapacity) return null;
  if (postLoad <= normalCapacity) {
    return { queueWaitMs: 0, endToEndTtftMs: baseTtftMs, law: QUEUE_LAW };
  }
  const x = (postLoad - normalCapacity) / (hardCapacity - normalCapacity);
  let queueWaitMs: number;
  if (QUEUE_LAW === "odds") {
    queueWaitMs = baseTtftMs * x / (1 - x);
  } else if (QUEUE_LAW === "linear") {
    queueWaitMs = LINEAR_ALPHA * baseTtftMs * x;
  } else {
    queueWaitMs = QUADRATIC_ALPHA * baseTtftMs * x * x;
  }
  return {
    queueWaitMs,
    endToEndTtftMs: baseTtftMs + queueWaitMs,
    law: QUEUE_LAW
  };
}
