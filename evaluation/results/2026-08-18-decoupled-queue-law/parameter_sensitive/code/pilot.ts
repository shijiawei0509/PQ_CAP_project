import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../../price_first_user/code/export.js";
import type { Difficulty } from "../../../../../../server/types.js";
import {
  PILOT_REQUEST_COUNT,
  executeRun,
  type ParameterRequestRow,
  type RunOutput,
  type RunSpec,
} from "./experiment.js";
import {
  DEFAULT_TOLERANCES,
  PILOT_SEEDS,
  scaledTolerances,
} from "./parameters.js";

const ROOT = process.env.PARAMETER_SENSITIVE_ROOT
  ? path.resolve(process.env.PARAMETER_SENSITIVE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIFFICULTIES = ["easy", "medium", "hard"] as const;

function spec(
  parameterId: string,
  deltaScale: number,
  kappa: number,
): RunSpec {
  return {
    family: parameterId.startsWith("kappa") ? "kappa-scan" : "delta-scan",
    parameterId,
    scenario: "soft-congestion",
    deltaScale,
    kappa,
    tolerances: deltaScale === 1
      ? DEFAULT_TOLERANCES : scaledTolerances(deltaScale),
  };
}

const PILOT_SPECS = [
  spec("delta-0.75", 0.75, 1),
  spec("delta-1.25", 1.25, 1),
  spec("kappa-0", 1, 0),
  spec("kappa-1", 1, 1),
] as const;

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
}

function rows(
  outputs: readonly RunOutput[],
  parameterId: string,
  difficulty?: Difficulty,
): ParameterRequestRow[] {
  return outputs.flatMap((output) => output.spec.parameterId === parameterId
    ? output.requests.filter((row) => !difficulty || row.difficulty === difficulty)
    : []);
}

function pairedChangeRate(
  left: readonly ParameterRequestRow[],
  right: readonly ParameterRequestRow[],
  field: "candidateCount" | "modelId",
): number {
  const rightByKey = new Map(right.map((row) => [
    `${row.seed}/${row.requestId}`, row,
  ]));
  let changed = 0;
  for (const row of left) {
    const paired = rightByKey.get(`${row.seed}/${row.requestId}`);
    if (!paired) throw new Error(`${row.requestId}: missing pilot pair`);
    if (row[field] !== paired[field]) changed += 1;
  }
  return changed / left.length;
}

export function runPilot(): Record<string, unknown> {
  const outputs = PILOT_SEEDS.flatMap((seed) =>
    PILOT_SPECS.map((runSpec) =>
      executeRun(runSpec, seed, PILOT_REQUEST_COUNT)
    )
  );
  const defaultRows = rows(outputs, "kappa-1");
  const difficultyAudit = Object.fromEntries(DIFFICULTIES.map((difficulty) => {
    const group = defaultRows.filter((row) => row.difficulty === difficulty);
    const narrower = rows(outputs, "delta-0.75", difficulty);
    const wider = rows(outputs, "delta-1.25", difficulty);
    return [difficulty, {
      requestCount: group.length,
      eligibleShare: group.filter((row) => row.candidateCount >= 1).length /
        group.length,
      atLeastTwoShare: group.filter((row) => row.candidateCount >= 2).length /
        group.length,
      meanCandidateCount: mean(group.map((row) => row.candidateCount)),
      completionRate: group.filter((row) => row.status === "completed").length /
        group.length,
      deltaCandidateChangeRate: pairedChangeRate(
        narrower, wider, "candidateCount",
      ),
    }];
  })) as Record<Difficulty, {
    requestCount: number;
    eligibleShare: number;
    atLeastTwoShare: number;
    meanCandidateCount: number;
    completionRate: number;
    deltaCandidateChangeRate: number;
  }>;
  const kappa0 = rows(outputs, "kappa-0");
  const kappa1 = rows(outputs, "kappa-1");
  const defaultOutputs = outputs.filter((output) =>
    output.spec.parameterId === "kappa-1"
  );
  const positions = defaultOutputs.flatMap((output) =>
    output.candidateObservations.flatMap((candidate) =>
      candidate.softPosition === null ? [] : [candidate.softPosition]
    )
  );
  const distinctPrices = new Set(defaultOutputs.flatMap((output) =>
    output.candidateObservations.map((candidate) =>
      candidate.basePricePerMillion
    )
  )).size;
  const ordered = difficultyAudit.easy.meanCandidateCount >=
      difficultyAudit.medium.meanCandidateCount &&
    difficultyAudit.medium.meanCandidateCount >=
      difficultyAudit.hard.meanCandidateCount;
  const changedDifficulties = DIFFICULTIES.filter((difficulty) =>
    difficultyAudit[difficulty].deltaCandidateChangeRate >= 0.10
  ).length;
  const routingFlipRate = pairedChangeRate(kappa0, kappa1, "modelId");
  const completionRate = defaultRows.filter((row) =>
    row.status === "completed"
  ).length / defaultRows.length;
  const spread = quantile(positions, 0.9) - quantile(positions, 0.1);
  const checks = [
    { id: "eligible-share", passed: DIFFICULTIES.every((difficulty) =>
      difficultyAudit[difficulty].eligibleShare >= 0.95) },
    { id: "two-candidate-share", passed: DIFFICULTIES.every((difficulty) =>
      difficultyAudit[difficulty].atLeastTwoShare >= 0.70) },
    { id: "difficulty-order", passed: ordered },
    { id: "delta-activation", passed: changedDifficulties >= 2 },
    { id: "kappa-routing-flip", passed:
      routingFlipRate >= 0.15 && routingFlipRate <= 0.60 },
    { id: "completion", passed: completionRate >= 0.95 },
    { id: "soft-position-spread", passed: spread >= 0.20 },
    { id: "price-heterogeneity", passed: distinctPrices >= 2 },
  ];
  const report = {
    status: checks.every((check) => check.passed) ? "PASS" : "FAIL",
    pilotSeeds: PILOT_SEEDS,
    requestCountPerRun: PILOT_REQUEST_COUNT,
    difficultyAudit,
    routingFlipRate,
    completionRate,
    softPosition: {
      count: positions.length,
      p10: quantile(positions, 0.1),
      p90: quantile(positions, 0.9),
      spread,
    },
    distinctSelectedBasePrices: distinctPrices,
    changedDifficulties,
    checks,
  };
  writeJson(path.join(ROOT, "pilot", "activation-audit.json"), report);
  return report;
}

if (process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runPilot();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "PASS") process.exitCode = 2;
}
