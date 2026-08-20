import type { Difficulty } from "../../../../../../server/types.js";
import type { ParameterRequestRow, RunOutput } from "./experiment.js";

export type Stratum = Difficulty | "equal-weight";

export interface PerSeedRow {
  family: string;
  parameterId: string;
  scenario: string;
  deltaScale: number | null;
  kappa: number;
  seed: number;
  stratum: Stratum;
  requestCount: number;
  candidateCountMean: number;
  multiCandidateShare: number;
  averageQuality: number;
  averageQualityGap: number;
  completionRate: number;
  sloSuccessRate: number;
  completionAwareP95TtftMs: number;
  completedP95TtftMs: number;
  p95QueueWaitMs: number;
  averageRequestPayment: number;
  priceInducedRerouteRate: number;
  foregroundAllocationGini: number;
  timeWeightedAllModelGini: number;
}

const DIFFICULTIES = ["easy", "medium", "hard"] as const;

function mean(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN :
    values.reduce((sum, value) => sum + value, 0) / values.length;
}

function p95(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
}

function gini(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;
  const weighted = sorted.reduce((sum, value, index) =>
    sum + (2 * (index + 1) - sorted.length - 1) * value, 0);
  return weighted / (sorted.length * total);
}

function finite(values: readonly (number | null)[]): number[] {
  return values.flatMap((value) => value === null || !Number.isFinite(value)
    ? [] : [value]);
}

function metricsForRows(
  output: RunOutput,
  stratum: Difficulty,
): PerSeedRow {
  const rows = output.requests.filter((row) => row.difficulty === stratum);
  const routed = rows.filter((row) => row.modelId !== null);
  const completed = rows.filter((row) => row.status === "completed");
  const allocations = new Map<string, number>();
  for (const row of routed) {
    if (row.modelId === null || row.reservedLoad === null ||
        row.normalCapacity === null) continue;
    allocations.set(row.modelId,
      (allocations.get(row.modelId) ?? 0) + row.reservedLoad / row.normalCapacity);
  }
  return {
    family: output.spec.family,
    parameterId: output.spec.parameterId,
    scenario: output.spec.scenario,
    deltaScale: output.spec.deltaScale,
    kappa: output.spec.kappa,
    seed: output.seed,
    stratum,
    requestCount: rows.length,
    candidateCountMean: mean(rows.map((row) => row.candidateCount)),
    multiCandidateShare: rows.filter((row) => row.candidateCount >= 2).length /
      rows.length,
    averageQuality: mean(finite(rows.map((row) => row.quality))),
    averageQualityGap: mean(finite(rows.map((row) => row.qualityGap))),
    completionRate: completed.length / rows.length,
    sloSuccessRate: rows.filter((row) => row.sloSuccess).length / rows.length,
    completionAwareP95TtftMs: p95(rows.map((row) =>
      row.completionAwareTtftMs)),
    completedP95TtftMs: p95(finite(completed.map((row) =>
      row.endToEndTtftMs))),
    p95QueueWaitMs: p95(finite(completed.map((row) => row.queueWaitMs))),
    averageRequestPayment: mean(finite(rows.map((row) => row.requestPayment))),
    priceInducedRerouteRate: routed.filter((row) =>
      row.priceInducedReroute === true).length / routed.length,
    foregroundAllocationGini: gini([...allocations.values()]),
    timeWeightedAllModelGini: output.simulation.timeWeightedLoadGini,
  };
}

function equalWeight(rows: readonly PerSeedRow[]): PerSeedRow {
  const first = rows[0];
  const numeric = <K extends keyof PerSeedRow>(key: K): number =>
    mean(rows.map((row) => row[key] as number));
  return {
    family: first.family,
    parameterId: first.parameterId,
    scenario: first.scenario,
    deltaScale: first.deltaScale,
    kappa: first.kappa,
    seed: first.seed,
    stratum: "equal-weight",
    requestCount: rows.reduce((sum, row) => sum + row.requestCount, 0),
    candidateCountMean: numeric("candidateCountMean"),
    multiCandidateShare: numeric("multiCandidateShare"),
    averageQuality: numeric("averageQuality"),
    averageQualityGap: numeric("averageQualityGap"),
    completionRate: numeric("completionRate"),
    sloSuccessRate: numeric("sloSuccessRate"),
    completionAwareP95TtftMs: numeric("completionAwareP95TtftMs"),
    completedP95TtftMs: numeric("completedP95TtftMs"),
    p95QueueWaitMs: numeric("p95QueueWaitMs"),
    averageRequestPayment: numeric("averageRequestPayment"),
    priceInducedRerouteRate: numeric("priceInducedRerouteRate"),
    foregroundAllocationGini: numeric("foregroundAllocationGini"),
    timeWeightedAllModelGini: numeric("timeWeightedAllModelGini"),
  };
}

export function perSeedMetrics(output: RunOutput): PerSeedRow[] {
  const difficultyRows = DIFFICULTIES.map((difficulty) =>
    metricsForRows(output, difficulty));
  return [...difficultyRows, equalWeight(difficultyRows)];
}

const METRICS = [
  "candidateCountMean", "multiCandidateShare", "averageQuality",
  "averageQualityGap", "completionRate", "sloSuccessRate",
  "completionAwareP95TtftMs", "completedP95TtftMs", "p95QueueWaitMs",
  "averageRequestPayment", "priceInducedRerouteRate",
  "foregroundAllocationGini", "timeWeightedAllModelGini",
] as const;

function sampleStd(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const center = mean(values);
  return Math.sqrt(values.reduce((sum, value) =>
    sum + (value - center) ** 2, 0) / (values.length - 1));
}

export function aggregateRows(rows: readonly PerSeedRow[]): Record<string, unknown>[] {
  const groups = new Map<string, PerSeedRow[]>();
  for (const row of rows) {
    const key = [row.family, row.parameterId, row.scenario, row.stratum].join("|");
    const group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    const result: Record<string, unknown> = {
      family: first.family, parameterId: first.parameterId,
      scenario: first.scenario, deltaScale: first.deltaScale,
      kappa: first.kappa, stratum: first.stratum, seedCount: group.length,
    };
    for (const metric of METRICS) {
      const values = group.map((row) => row[metric]);
      const center = mean(values);
      const std = sampleStd(values);
      const margin = group.length > 1 ? 2.5706 * std / Math.sqrt(group.length) : 0;
      result[`${metric}Mean`] = center;
      result[`${metric}Std`] = std;
      result[`${metric}CiLow`] = center - margin;
      result[`${metric}CiHigh`] = center + margin;
    }
    return result;
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function referenceId(row: PerSeedRow): string | null {
  if (row.family === "delta-scan") return "delta-1";
  if (row.family === "difficulty-control") return "aware";
  if (row.family === "kappa-scan") return "kappa-1";
  if (row.family === "interaction") return "delta-1-kappa-1";
  return null;
}

export function pairedEffects(rows: readonly PerSeedRow[]): Record<string, unknown>[] {
  const index = new Map(rows.map((row) => [[
    row.family, row.parameterId, row.scenario, row.stratum, row.seed,
  ].join("|"), row]));
  const output: Record<string, unknown>[] = [];
  for (const row of rows) {
    const reference = referenceId(row);
    if (!reference || row.parameterId === reference) continue;
    const paired = index.get([
      row.family, reference, row.scenario, row.stratum, row.seed,
    ].join("|"));
    if (!paired) throw new Error(`${row.parameterId}: missing paired reference`);
    for (const metric of METRICS) {
      output.push({
        family: row.family, parameterId: row.parameterId,
        referenceId: reference, scenario: row.scenario,
        stratum: row.stratum, seed: row.seed, metric,
        difference: row[metric] - paired[metric],
      });
    }
  }
  return output;
}
