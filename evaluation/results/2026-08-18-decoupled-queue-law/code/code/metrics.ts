import { METHODS, type MethodId, type ScenarioId } from "./types.js";
import type { SimulationResult } from "./simulator.js";

const T_975_DF5 = 2.5705818366147395;

export interface PerSeedMetrics {
  scenario: ScenarioId;
  seed: number;
  method: MethodId;
  requestCount: number;
  completedCount: number;
  routedCount: number;
  averageQuality: number;
  p95EndToEndTtftMs: number;
  p95QueueWaitMs: number;
  loadGini: number;
  completionRate: number;
  nonCongestedRate: number;
}

export interface AggregateMetrics {
  scenario: ScenarioId;
  method: MethodId;
  seedCount: number;
  averageQualityMean: number;
  averageQualityStd: number;
  averageQualityCiLow: number;
  averageQualityCiHigh: number;
  p95EndToEndTtftMsMean: number;
  p95EndToEndTtftMsStd: number;
  p95EndToEndTtftMsCiLow: number;
  p95EndToEndTtftMsCiHigh: number;
  p95QueueWaitMsMean: number;
  p95QueueWaitMsStd: number;
  p95QueueWaitMsCiLow: number;
  p95QueueWaitMsCiHigh: number;
  loadGiniMean: number;
  loadGiniStd: number;
  loadGiniCiLow: number;
  loadGiniCiHigh: number;
  completionRateMean: number;
  completionRateStd: number;
  completionRateCiLow: number;
  completionRateCiHigh: number;
  nonCongestedRateMean: number;
  nonCongestedRateStd: number;
  nonCongestedRateCiLow: number;
  nonCongestedRateCiHigh: number;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Cannot compute P95 from an empty sample");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
}

function summary(values: readonly number[]): {
  mean: number;
  std: number;
  ciLow: number;
  ciHigh: number;
} {
  if (values.length === 0) throw new Error("Cannot summarize an empty sample");
  const average = mean(values);
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (values.length - 1)
    : 0;
  const std = Math.sqrt(variance);
  const margin = values.length === 6
    ? T_975_DF5 * std / Math.sqrt(values.length)
    : 0;
  return { mean: average, std, ciLow: average - margin, ciHigh: average + margin };
}

export function perSeedMetrics(result: SimulationResult): PerSeedMetrics {
  if (result.requests.length === 0) throw new Error("Cannot aggregate an empty run");
  const completed = result.requests.filter((row) => row.status === "completed");
  const routed = result.requests.filter((row) => row.modelId !== null);
  if (completed.length === 0) throw new Error("No completed requests for completed-only metrics");
  if (routed.length === 0) throw new Error("No routed requests for non-congestion rate");
  const first = result.requests[0];
  if (!METHODS.includes(first.method as MethodId)) {
    throw new Error(`Cannot aggregate non-formal router ${first.method}`);
  }
  return {
    scenario: first.scenario,
    seed: first.seed,
    method: first.method as MethodId,
    requestCount: result.requests.length,
    completedCount: completed.length,
    routedCount: routed.length,
    averageQuality: mean(completed.map((row) => row.quality!)),
    p95EndToEndTtftMs: percentile95(completed.map((row) => row.endToEndTtftMs!)),
    p95QueueWaitMs: percentile95(completed.map((row) => row.queueWaitMs!)),
    loadGini: result.timeWeightedLoadGini,
    completionRate: completed.length / result.requests.length,
    nonCongestedRate:
      routed.filter((row) => row.nonCongested === true).length / routed.length
  };
}

function groupKey(row: PerSeedMetrics): string {
  return `${row.scenario}\u0000${row.method}`;
}

export function aggregatePerSeed(rows: readonly PerSeedMetrics[]): AggregateMetrics[] {
  const groups = new Map<string, PerSeedMetrics[]>();
  for (const row of rows) {
    const key = groupKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((members) => {
    const metric = (key: keyof Pick<PerSeedMetrics,
      "averageQuality" |
      "p95EndToEndTtftMs" |
      "p95QueueWaitMs" |
      "loadGini" |
      "completionRate" |
      "nonCongestedRate"
    >) => summary(members.map((row) => row[key]));
    const quality = metric("averageQuality");
    const total = metric("p95EndToEndTtftMs");
    const queue = metric("p95QueueWaitMs");
    const load = metric("loadGini");
    const completion = metric("completionRate");
    const nonCongested = metric("nonCongestedRate");
    return {
      scenario: members[0].scenario,
      method: members[0].method,
      seedCount: members.length,
      averageQualityMean: quality.mean,
      averageQualityStd: quality.std,
      averageQualityCiLow: quality.ciLow,
      averageQualityCiHigh: quality.ciHigh,
      p95EndToEndTtftMsMean: total.mean,
      p95EndToEndTtftMsStd: total.std,
      p95EndToEndTtftMsCiLow: total.ciLow,
      p95EndToEndTtftMsCiHigh: total.ciHigh,
      p95QueueWaitMsMean: queue.mean,
      p95QueueWaitMsStd: queue.std,
      p95QueueWaitMsCiLow: queue.ciLow,
      p95QueueWaitMsCiHigh: queue.ciHigh,
      loadGiniMean: load.mean,
      loadGiniStd: load.std,
      loadGiniCiLow: load.ciLow,
      loadGiniCiHigh: load.ciHigh,
      completionRateMean: completion.mean,
      completionRateStd: completion.std,
      completionRateCiLow: completion.ciLow,
      completionRateCiHigh: completion.ciHigh,
      nonCongestedRateMean: nonCongested.mean,
      nonCongestedRateStd: nonCongested.std,
      nonCongestedRateCiLow: nonCongested.ciLow,
      nonCongestedRateCiHigh: nonCongested.ciHigh
    };
  }).sort((left, right) =>
    left.scenario.localeCompare(right.scenario) ||
    left.method.localeCompare(right.method)
  );
}

function pairedInterval(
  ours: readonly PerSeedMetrics[],
  baseline: readonly PerSeedMetrics[],
  key: "nonCongestedRate" | "p95QueueWaitMs" | "completionRate"
): { mean: number; low: number; high: number } {
  const baselineBySeed = new Map(baseline.map((row) => [row.seed, row]));
  const deltas = ours.map((row) => {
    const match = baselineBySeed.get(row.seed);
    if (!match) throw new Error(`Missing paired seed ${row.seed}`);
    return row[key] - match[key];
  });
  const stats = summary(deltas);
  return { mean: stats.mean, low: stats.ciLow, high: stats.ciHigh };
}

export interface MechanismEvaluation {
  supported: boolean;
  checks: Array<{
    scenario: ScenarioId;
    metric: "nonCongestedRate" | "p95QueueWaitMs" | "completionRate";
    passed: boolean;
    comparator: MethodId;
    pairedMean: number;
    pairedCiLow: number;
    pairedCiHigh: number;
  }>;
}

export function evaluateMechanism(rows: readonly PerSeedMetrics[]): MechanismEvaluation {
  const checks: MechanismEvaluation["checks"] = [];
  const scenarios = [...new Set(rows.map((row) => row.scenario))];
  for (const scenario of scenarios) {
    const scenarioRows = rows.filter((row) => row.scenario === scenario);
    const ours = scenarioRows.filter((row) => row.method === "ours");
    if (ours.length === 0) throw new Error(`${scenario}: missing Ours rows`);
    const baselines = [...new Set(
      scenarioRows.filter((row) => row.method !== "ours").map((row) => row.method)
    )];
    for (const metric of ["nonCongestedRate", "p95QueueWaitMs"] as const) {
      const direction = metric === "nonCongestedRate" ? 1 : -1;
      const comparator = baselines.map((method) => ({
        method,
        rows: scenarioRows.filter((row) => row.method === method),
        average: mean(
          scenarioRows.filter((row) => row.method === method).map((row) => row[metric])
        )
      })).sort((left, right) =>
        direction * (right.average - left.average)
      )[0];
      if (!comparator) continue;
      const paired = pairedInterval(ours, comparator.rows, metric);
      const tolerance = metric === "nonCongestedRate" ? 1e-9 : 1e-6;
      const numericalPass = direction * paired.mean >= -tolerance;
      const s1StatisticalPass = scenario === "S1" &&
        (paired.low <= 0 && paired.high >= 0);
      checks.push({
        scenario,
        metric,
        passed: numericalPass || s1StatisticalPass,
        comparator: comparator.method,
        pairedMean: paired.mean,
        pairedCiLow: paired.low,
        pairedCiHigh: paired.high
      });
    }

    const comparator = baselines.map((method) => ({
      method,
      rows: scenarioRows.filter((row) => row.method === method),
      average: mean(
        scenarioRows.filter((row) => row.method === method).map((row) => row.completionRate)
      )
    })).sort((left, right) => right.average - left.average)[0];
    if (comparator) {
      const paired = pairedInterval(ours, comparator.rows, "completionRate");
      checks.push({
        scenario,
        metric: "completionRate",
        passed: paired.high >= 0,
        comparator: comparator.method,
        pairedMean: paired.mean,
        pairedCiLow: paired.low,
        pairedCiHigh: paired.high
      });
    }
  }
  return { supported: checks.every((check) => check.passed), checks };
}
