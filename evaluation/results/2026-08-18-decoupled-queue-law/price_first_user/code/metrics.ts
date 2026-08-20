import { METHODS, SEEDS, type MethodId, type ScenarioId } from "./types.js";
import type { SimulationResult } from "./simulator.js";

export const T_975_DF5 = 2.5705818366147395;

export interface PerSeedMetrics {
  scenario: ScenarioId;
  seed: number;
  method: MethodId;
  requestCount: number;
  completedCount: number;
  routedCount: number;
  averageQuality: number | null;
  p95EndToEndTtftMs: number | null;
  p95QueueWaitMs: number | null;
  loadGini: number;
  completionRate: number;
  nonCongestedRate: number | null;
  averageLockedUnitPrice: number | null;
  p95LockedUnitPrice: number | null;
  surchargeActivationRate: number | null;
  priceInducedRerouteRate: number | null;
  distinctSelectedModels: number;
  selectedModelIds: string[];
}

type MetricSummary = {
  mean: number | null;
  std: number | null;
  ciLow: number | null;
  ciHigh: number | null;
};

export interface AggregateMetrics {
  scenario: ScenarioId;
  method: MethodId;
  seedCount: number;
  averageQualityMean: number | null;
  averageQualityStd: number | null;
  averageQualityCiLow: number | null;
  averageQualityCiHigh: number | null;
  p95EndToEndTtftMsMean: number | null;
  p95EndToEndTtftMsStd: number | null;
  p95EndToEndTtftMsCiLow: number | null;
  p95EndToEndTtftMsCiHigh: number | null;
  p95QueueWaitMsMean: number | null;
  p95QueueWaitMsStd: number | null;
  p95QueueWaitMsCiLow: number | null;
  p95QueueWaitMsCiHigh: number | null;
  loadGiniMean: number;
  loadGiniStd: number;
  loadGiniCiLow: number;
  loadGiniCiHigh: number;
  completionRateMean: number;
  completionRateStd: number;
  completionRateCiLow: number;
  completionRateCiHigh: number;
  nonCongestedRateMean: number | null;
  nonCongestedRateStd: number | null;
  nonCongestedRateCiLow: number | null;
  nonCongestedRateCiHigh: number | null;
  averageLockedUnitPriceMean: number | null;
  averageLockedUnitPriceStd: number | null;
  averageLockedUnitPriceCiLow: number | null;
  averageLockedUnitPriceCiHigh: number | null;
  p95LockedUnitPriceMean: number | null;
  p95LockedUnitPriceStd: number | null;
  p95LockedUnitPriceCiLow: number | null;
  p95LockedUnitPriceCiHigh: number | null;
  surchargeActivationRateMean: number | null;
  surchargeActivationRateStd: number | null;
  surchargeActivationRateCiLow: number | null;
  surchargeActivationRateCiHigh: number | null;
  priceInducedRerouteRateMean: number | null;
  priceInducedRerouteRateStd: number | null;
  priceInducedRerouteRateCiLow: number | null;
  priceInducedRerouteRateCiHigh: number | null;
  distinctSelectedModelsMean: number;
  distinctSelectedModelsStd: number;
  distinctSelectedModelsCiLow: number;
  distinctSelectedModelsCiHigh: number;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function nearestRankP95(
  values: readonly number[]
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

export function sampleStandardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (values.length - 1)
  );
}

function summarize(
  values: readonly (number | null)[],
  label = "metric"
): MetricSummary {
  if (values.length !== SEEDS.length) {
    throw new Error(`${label}: expected exactly ${SEEDS.length} seed values`);
  }
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) {
    return { mean: null, std: null, ciLow: null, ciHigh: null };
  }
  if (present.length !== SEEDS.length) {
    throw new Error(`${label}: partially-null six-seed metric`);
  }
  const average = mean(present);
  const std = sampleStandardDeviation(present);
  const margin = T_975_DF5 * std / Math.sqrt(SEEDS.length);
  return {
    mean: average,
    std,
    ciLow: average - margin,
    ciHigh: average + margin
  };
}

export function perSeedMetrics(result: SimulationResult): PerSeedMetrics {
  if (result.requests.length === 0) {
    throw new Error("Cannot aggregate an empty run");
  }
  const first = result.requests[0];
  if (!METHODS.includes(first.method as MethodId)) {
    throw new Error(`Cannot aggregate non-formal router ${first.method}`);
  }
  if (result.requests.some((row) =>
    row.scenario !== first.scenario ||
    row.seed !== first.seed ||
    row.method !== first.method
  )) {
    throw new Error("A per-seed run must contain one scenario, seed, and method");
  }

  const completed = result.requests.filter((row) => row.status === "completed");
  const routed = result.requests.filter((row) => row.modelId !== null);
  const completedValues = <K extends keyof typeof completed[number]>(
    key: K
  ): number[] => completed.map((row) => row[key]).filter(
    (value): value is Extract<typeof value, number> => typeof value === "number"
  );
  const averageOrNull = (values: readonly number[]): number | null =>
    values.length === 0 ? null : mean(values);
  const mechanismRate = (
    key: "surchargeApplied" | "priceInducedReroute"
  ): number | null => {
    if (first.method !== "ours-price-first" || routed.length === 0) return null;
    return routed.filter((row) => row[key] === true).length / routed.length;
  };
  const selectedModelIds = [...new Set(
    routed.map((row) => row.modelId).filter((id): id is string => id !== null)
  )].sort();

  return {
    scenario: first.scenario,
    seed: first.seed,
    method: first.method as MethodId,
    requestCount: result.requests.length,
    completedCount: completed.length,
    routedCount: routed.length,
    averageQuality: averageOrNull(completedValues("quality")),
    p95EndToEndTtftMs: nearestRankP95(completedValues("endToEndTtftMs")),
    p95QueueWaitMs: nearestRankP95(completedValues("queueWaitMs")),
    loadGini: result.timeWeightedLoadGini,
    completionRate: completed.length / result.requests.length,
    nonCongestedRate: routed.length === 0
      ? null
      : routed.filter((row) => row.nonCongested === true).length / routed.length,
    averageLockedUnitPrice:
      averageOrNull(completedValues("lockedUnitPrice")),
    p95LockedUnitPrice: nearestRankP95(completedValues("lockedUnitPrice")),
    surchargeActivationRate: mechanismRate("surchargeApplied"),
    priceInducedRerouteRate: mechanismRate("priceInducedReroute"),
    distinctSelectedModels: selectedModelIds.length,
    selectedModelIds
  };
}

const AGGREGATED_METRICS = [
  "averageQuality",
  "p95EndToEndTtftMs",
  "p95QueueWaitMs",
  "loadGini",
  "completionRate",
  "nonCongestedRate",
  "averageLockedUnitPrice",
  "p95LockedUnitPrice",
  "surchargeActivationRate",
  "priceInducedRerouteRate",
  "distinctSelectedModels"
] as const satisfies readonly (keyof PerSeedMetrics)[];

export function aggregatePerSeed(
  rows: readonly PerSeedMetrics[]
): AggregateMetrics[] {
  const groups = new Map<string, PerSeedMetrics[]>();
  for (const row of rows) {
    const key = `${row.scenario}\u0000${row.method}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((members) => {
    const memberSeeds = members.map((row) => row.seed);
    if (
      memberSeeds.length !== SEEDS.length ||
      new Set(memberSeeds).size !== SEEDS.length ||
      SEEDS.some((seed) => !memberSeeds.includes(seed))
    ) {
      throw new Error(
        `${members[0].scenario}/${members[0].method}: expected the six frozen seeds`
      );
    }
    const output: Record<string, number | null | string> = {
      scenario: members[0].scenario,
      method: members[0].method,
      seedCount: members.length
    };
    for (const metric of AGGREGATED_METRICS) {
      const stats = summarize(
        members.map((row) => row[metric] as number | null),
        metric
      );
      output[`${metric}Mean`] = stats.mean;
      output[`${metric}Std`] = stats.std;
      output[`${metric}CiLow`] = stats.ciLow;
      output[`${metric}CiHigh`] = stats.ciHigh;
    }
    return output as unknown as AggregateMetrics;
  }).sort((left, right) =>
    left.scenario.localeCompare(right.scenario) ||
    left.method.localeCompare(right.method)
  );
}

export interface PairedInterval {
  mean: number;
  ciLow: number;
  ciHigh: number;
}

export type ComparisonMetric =
  | "averageLockedUnitPrice"
  | "p95QueueWaitMs"
  | "congestionRate"
  | "completionRate";

export interface PairedComparison {
  scenario: ScenarioId;
  baseline: Exclude<MethodId, "ours-price-first">;
  seedCount: number;
  metrics: Record<ComparisonMetric, PairedInterval>;
}

function requiredValue(
  row: PerSeedMetrics,
  key: "averageLockedUnitPrice" | "p95QueueWaitMs" | "nonCongestedRate"
): number {
  const value = row[key];
  if (value === null) {
    throw new Error(
      `${row.scenario}/${row.method}/${row.seed}: ${key} is null`
    );
  }
  return value;
}

function pairedInterval(values: readonly number[]): PairedInterval {
  const stats = summarize(values);
  return {
    mean: stats.mean!,
    ciLow: stats.ciLow!,
    ciHigh: stats.ciHigh!
  };
}

export function buildPairedComparisons(
  rows: readonly PerSeedMetrics[]
): PairedComparison[] {
  const output: PairedComparison[] = [];
  const scenarios = [...new Set(rows.map((row) => row.scenario))].sort();
  for (const scenario of scenarios) {
    const scenarioRows = rows.filter((row) => row.scenario === scenario);
    const ours = scenarioRows.filter((row) =>
      row.method === "ours-price-first"
    );
    if (ours.length === 0) throw new Error(`${scenario}: missing Ours rows`);
    const oursBySeed = new Map(ours.map((row) => [row.seed, row]));
    if (oursBySeed.size !== ours.length) {
      throw new Error(`${scenario}: duplicate Ours seed`);
    }
    const baselines = [...new Set(scenarioRows
      .filter((row) => row.method !== "ours-price-first")
      .map((row) => row.method as Exclude<MethodId, "ours-price-first">))]
      .sort();
    for (const baseline of baselines) {
      const baselineRows = scenarioRows.filter((row) =>
        row.method === baseline
      );
      const baselineBySeed = new Map(
        baselineRows.map((row) => [row.seed, row])
      );
      if (
        baselineBySeed.size !== baselineRows.length ||
        baselineBySeed.size !== oursBySeed.size ||
        SEEDS.some((seed) =>
          !oursBySeed.has(seed) || !baselineBySeed.has(seed)
        ) ||
        oursBySeed.size !== SEEDS.length
      ) {
        throw new Error(
          `${scenario}/${baseline}: requires exactly the six frozen paired seeds`
        );
      }
      const pairs = [...oursBySeed].sort(([left], [right]) => left - right)
        .map(([seed, oursRow]) => {
          const baselineRow = baselineBySeed.get(seed);
          if (!baselineRow) {
            throw new Error(`${scenario}/${baseline}: missing paired seed ${seed}`);
          }
          return { ours: oursRow, baseline: baselineRow };
        });
      output.push({
        scenario,
        baseline,
        seedCount: pairs.length,
        metrics: {
          averageLockedUnitPrice: pairedInterval(pairs.map(({ ours, baseline }) =>
            requiredValue(ours, "averageLockedUnitPrice") -
            requiredValue(baseline, "averageLockedUnitPrice")
          )),
          p95QueueWaitMs: pairedInterval(pairs.map(({ ours, baseline }) =>
            requiredValue(ours, "p95QueueWaitMs") -
            requiredValue(baseline, "p95QueueWaitMs")
          )),
          congestionRate: pairedInterval(pairs.map(({ ours, baseline }) =>
            (1 - requiredValue(ours, "nonCongestedRate")) -
            (1 - requiredValue(baseline, "nonCongestedRate"))
          )),
          completionRate: pairedInterval(pairs.map(({ ours, baseline }) =>
            ours.completionRate - baseline.completionRate
          ))
        }
      });
    }
  }
  return output;
}

export interface GateCheck {
  id: string;
  scenario: ScenarioId;
  baseline?: Exclude<MethodId, "ours-price-first">;
  metric:
    | ComparisonMetric
    | "surchargeActivationRate"
    | "priceInducedRerouteRate"
    | "distinctSelectedModels"
    | "pareto";
  passed: boolean;
  pairedMean?: number;
  pairedCiLow?: number;
  pairedCiHigh?: number;
  detail: string;
}

export interface SuccessGateEvaluation {
  supported: boolean;
  comparisons: PairedComparison[];
  checks: GateCheck[];
}

const containsZero = (interval: PairedInterval): boolean =>
  interval.ciLow <= 0 && interval.ciHigh >= 0;

const lowerOrTied = (interval: PairedInterval, tolerance: number): boolean =>
  interval.mean <= tolerance || containsZero(interval);

const higherOrTied = (interval: PairedInterval, tolerance: number): boolean =>
  interval.mean >= -tolerance || containsZero(interval);

function comparisonCheck(
  id: string,
  comparison: PairedComparison,
  metric: ComparisonMetric,
  passed: boolean,
  detail: string
): GateCheck {
  const paired = comparison.metrics[metric];
  return {
    id,
    scenario: comparison.scenario,
    baseline: comparison.baseline,
    metric,
    passed,
    pairedMean: paired.mean,
    pairedCiLow: paired.ciLow,
    pairedCiHigh: paired.ciHigh,
    detail
  };
}

export function evaluateSuccessGates(
  rows: readonly PerSeedMetrics[]
): SuccessGateEvaluation {
  const comparisons = buildPairedComparisons(rows);
  const checks: GateCheck[] = [];
  for (const comparison of comparisons) {
    const { scenario, baseline, metrics } = comparison;
    const queueTolerance = 1e-6;
    const rateTolerance = 1e-9;
    const queuePass = scenario === "S1"
      ? metrics.p95QueueWaitMs.ciLow <= queueTolerance
      : lowerOrTied(metrics.p95QueueWaitMs, queueTolerance);
    const congestionPass = scenario === "S1"
      ? metrics.congestionRate.ciLow <= rateTolerance
      : lowerOrTied(metrics.congestionRate, rateTolerance);
    const completionPass =
      metrics.completionRate.ciHigh >= -rateTolerance;
    checks.push(
      comparisonCheck(
        `protection:${scenario}:${baseline}:p95QueueWaitMs`,
        comparison,
        "p95QueueWaitMs",
        queuePass,
        scenario === "S1"
          ? "Ours is not significantly worse"
          : "Ours is lower or statistically tied"
      ),
      comparisonCheck(
        `protection:${scenario}:${baseline}:congestionRate`,
        comparison,
        "congestionRate",
        congestionPass,
        scenario === "S1"
          ? "Ours is not significantly worse"
          : "Ours is lower or statistically tied"
      ),
      comparisonCheck(
        `protection:${scenario}:${baseline}:completionRate`,
        comparison,
        "completionRate",
        completionPass,
        "Ours is not significantly lower"
      )
    );

    if (baseline === "cheapest-eligible") {
      checks.push(
        comparisonCheck(
          `cheapest-eligible:p95QueueWaitMs:${scenario}`,
          comparison,
          "p95QueueWaitMs",
          lowerOrTied(metrics.p95QueueWaitMs, queueTolerance),
          "Ours queue is lower or tied"
        ),
        comparisonCheck(
          `cheapest-eligible:congestionRate:${scenario}`,
          comparison,
          "congestionRate",
          lowerOrTied(metrics.congestionRate, rateTolerance),
          "Ours congestion is lower or tied"
        ),
        comparisonCheck(
          `cheapest-eligible:completionRate:${scenario}`,
          comparison,
          "completionRate",
          higherOrTied(metrics.completionRate, rateTolerance),
          "Ours completion is no lower or tied"
        )
      );
    }
    if (baseline === "least-loaded-eligible") {
      checks.push(
        comparisonCheck(
          `least-loaded-eligible:p95QueueWaitMs:${scenario}`,
          comparison,
          "p95QueueWaitMs",
          lowerOrTied(metrics.p95QueueWaitMs, queueTolerance),
          "Ours queue is no worse or tied"
        ),
        comparisonCheck(
          `least-loaded-eligible:congestionRate:${scenario}`,
          comparison,
          "congestionRate",
          lowerOrTied(metrics.congestionRate, rateTolerance),
          "Ours congestion is no worse or tied"
        ),
        comparisonCheck(
          `least-loaded-eligible:averageLockedUnitPrice:${scenario}`,
          comparison,
          "averageLockedUnitPrice",
          lowerOrTied(metrics.averageLockedUnitPrice, 1e-9),
          "Ours average locked unit price is lower or tied"
        )
      );
    }

    const baselineNoWorse =
      metrics.averageLockedUnitPrice.mean >= -1e-9 &&
      metrics.p95QueueWaitMs.mean >= -queueTolerance &&
      metrics.congestionRate.mean >= -rateTolerance &&
      metrics.completionRate.mean <= rateTolerance;
    const baselineStrictlyBetter =
      metrics.averageLockedUnitPrice.mean > 1e-9 ||
      metrics.p95QueueWaitMs.mean > queueTolerance ||
      metrics.congestionRate.mean > rateTolerance ||
      metrics.completionRate.mean < -rateTolerance;
    checks.push({
      id: `pareto:${scenario}:${baseline}`,
      scenario,
      baseline,
      metric: "pareto",
      passed: !(baselineNoWorse && baselineStrictlyBetter),
      detail: "No baseline dominates Ours on price, queue, congestion, completion"
    });
  }

  for (const scenario of ["S2", "S3"] as const) {
    const ours = rows.filter((row) =>
      row.scenario === scenario && row.method === "ours-price-first"
    );
    if (ours.length === 0) continue;
    const routedCount = ours.reduce((sum, row) => sum + row.routedCount, 0);
    const activationCount = ours.reduce(
      (sum, row) =>
        sum + (row.surchargeActivationRate ?? 0) * row.routedCount,
      0
    );
    const rerouteCount = ours.reduce(
      (sum, row) =>
        sum + (row.priceInducedRerouteRate ?? 0) * row.routedCount,
      0
    );
    const activation = routedCount > 0 && activationCount > 0;
    const reroute = routedCount > 0 && rerouteCount > 0;
    const diversity = new Set(
      ours.flatMap((row) => row.selectedModelIds)
    ).size >= 2;
    checks.push(
      {
        id: `mechanism:${scenario}:surchargeActivationRate`,
        scenario,
        metric: "surchargeActivationRate",
        passed: activation,
        detail: "The scenario has positive routed-weighted surcharge activation"
      },
      {
        id: `mechanism:${scenario}:priceInducedRerouteRate`,
        scenario,
        metric: "priceInducedRerouteRate",
        passed: reroute,
        detail: "The scenario has positive routed-weighted price-induced rerouting"
      },
      {
        id: `mechanism:${scenario}:distinctSelectedModels`,
        scenario,
        metric: "distinctSelectedModels",
        passed: diversity,
        detail: "The scenario selects at least two distinct models"
      }
    );
  }

  return {
    supported: checks.every((check) => check.passed),
    comparisons,
    checks
  };
}
