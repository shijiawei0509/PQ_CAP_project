import type { SimulationResult } from "./simulator.js";
import type {
  PerSeedRow,
  RequestResult
} from "./types.js";

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function nullableAverage(values: readonly number[]): number | null {
  return values.length === 0 ? null : average(values);
}

function nearestRankP95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
}

function rate(
  rows: readonly RequestResult[],
  predicate: (row: RequestResult) => boolean
): number | null {
  return rows.length === 0
    ? null
    : rows.filter(predicate).length / rows.length;
}

export function computePerSeedMetrics(
  result: SimulationResult
): PerSeedRow {
  if (result.requests.length === 0) {
    throw new Error("Cannot compute metrics from an empty simulation");
  }
  const first = result.requests[0];
  const completed = result.requests.filter((row) => row.completed);
  const fixed = result.requests.filter((row) =>
    row.cohort.startsWith("fixed")
  );
  const fallback = result.requests.filter((row) =>
    row.cohort === "fixed-fallback"
  );
  const fallbackActivated = fallback.filter((row) =>
    row.fallbackActivated
  );
  return {
    scenario: first.scenario,
    seed: first.seed,
    method: first.method,
    cohort: first.cohort,
    requestCount: result.requests.length,
    completedCount: completed.length,
    averageQuality: nullableAverage(
      completed.flatMap((row) => row.quality === null ? [] : [row.quality])
    ),
    averageLockedPayment: nullableAverage(
      completed.flatMap((row) =>
        row.lockedPayment === null ? [] : [row.lockedPayment]
      )
    ),
    p95EndToEndTtftMs: nearestRankP95(
      completed.flatMap((row) =>
        row.endToEndTtftMs === null ? [] : [row.endToEndTtftMs]
      )
    ),
    p95QueueWaitMs: nearestRankP95(
      completed.flatMap((row) =>
        row.queueWaitMs === null ? [] : [row.queueWaitMs]
      )
    ),
    completionRate: completed.length / result.requests.length,
    loadGini: result.timeWeightedLoadGini,
    hardCapRejectionOrFailureShare:
      result.requests.filter((row) =>
        row.status === "capacity-failure"
      ).length / result.requests.length,
    fixedAdherenceRate: rate(fixed, (row) => row.fixedAdhered === true),
    fallbackActivationRate: rate(
      fallback,
      (row) => row.fallbackActivated
    ),
    fallbackSuccessRate: rate(
      fallbackActivated,
      (row) => row.fallbackSucceeded === true
    )
  };
}
