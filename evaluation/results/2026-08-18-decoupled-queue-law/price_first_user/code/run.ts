import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TASK_TYPES } from "../../../../../../server/types.js";
import {
  CAPACITY_CSV_PATH,
  QUALITY_CSV_PATH,
  TASK_SNAPSHOT_PATH,
  loadFrozenProfile
} from "./model-profile.js";
import {
  loadFrozenLambda0,
  loadFrozenLoadAssignments
} from "./load-traces.js";
import { createRouters, buildBaselineCandidates } from "./routers.js";
import { buildScenarioTrace, scenarioDefinitions } from "./scenarios.js";
import {
  simulate,
  validateCandidateSufficiency,
  type CandidatePreflightObservation,
  type RequestResult,
  type SimulationResult
} from "./simulator.js";
import {
  aggregatePerSeed,
  buildPairedComparisons,
  evaluateSuccessGates,
  perSeedMetrics,
  type PerSeedMetrics
} from "./metrics.js";
import {
  assertNoFigureArtifacts,
  publishDirectories,
  sha256File,
  writeCsv,
  writeGzipCsv,
  writeJson,
  type CsvRow
} from "./export.js";
import { validateExperimentDirectory, validateRequestContracts } from "./validate.js";
import {
  METHODS,
  REQUEST_COUNT,
  SEEDS,
  type MethodId
} from "./types.js";

export const EXPERIMENT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const REQUEST_TIMEOUT_MS = 300_000;

function bestSingleModelId(
  models: ReturnType<typeof loadFrozenProfile>["models"]
): string {
  return [...models].sort((left, right) => {
    const leftAverage = TASK_TYPES.reduce(
      (sum, taskType) => sum + left.quality[taskType], 0
    ) / TASK_TYPES.length;
    const rightAverage = TASK_TYPES.reduce(
      (sum, taskType) => sum + right.quality[taskType], 0
    ) / TASK_TYPES.length;
    return rightAverage - leftAverage || left.id.localeCompare(right.id);
  })[0].id;
}

export interface BatchOptions {
  seeds?: readonly number[];
  methodIds?: readonly MethodId[];
  requestCount?: number;
}

export interface BatchResult {
  requests: RequestResult[];
  simulations: Array<{
    scenario: "S1" | "S2" | "S3";
    seed: number;
    method: MethodId;
    result: SimulationResult;
  }>;
}

export function executeSimulationBatch(
  options: BatchOptions = {}
): BatchResult {
  const seeds = options.seeds ?? SEEDS;
  const methodIds = options.methodIds ?? METHODS;
  const requestCount = options.requestCount ?? REQUEST_COUNT;
  const { models, tasks, qualityThresholds } = loadFrozenProfile();
  const assignments = loadFrozenLoadAssignments(models);
  const lambda0 = loadFrozenLambda0();
  const bestModelId = bestSingleModelId(models);
  const requests: RequestResult[] = [];
  const simulations: BatchResult["simulations"] = [];

  for (const seed of seeds) {
    const definitions = scenarioDefinitions(lambda0, seed, requestCount);
    for (const scenario of Object.values(definitions)) {
      const trace = buildScenarioTrace({ definition: scenario, tasks, models });
      for (const router of createRouters(bestModelId).filter(({ id }) =>
        methodIds.includes(id)
      )) {
        const result = simulate({
          scenario,
          requests: trace,
          models,
          thresholds: qualityThresholds,
          loadClasses: assignments[seed],
          router,
          requestTimeoutMs: REQUEST_TIMEOUT_MS
        });
        if (!result.validation.finalLoadsZero || !result.validation.capacityInvariant) {
          throw new Error(`${scenario.id}/${seed}/${router.id}: invariant failure`);
        }
        requests.push(...result.requests);
        simulations.push({
          scenario: scenario.id,
          seed,
          method: router.id,
          result
        });
      }
    }
  }
  return { requests, simulations };
}

function asCsvRows<T extends object>(rows: readonly T[]): CsvRow[] {
  return rows.map((row) => {
    const output: CsvRow = {};
    for (const [key, value] of Object.entries(row)) {
      output[key] = Array.isArray(value) ? value.join("|") :
        value as CsvRow[string];
    }
    return output;
  });
}

function preflightObservations(): CandidatePreflightObservation[] {
  const { models, tasks, qualityThresholds } = loadFrozenProfile();
  const assignments = loadFrozenLoadAssignments(models);
  const lambda0 = loadFrozenLambda0();
  const observations: CandidatePreflightObservation[] = [];
  for (const seed of SEEDS) {
    for (const scenario of Object.values(
      scenarioDefinitions(lambda0, seed, REQUEST_COUNT)
    )) {
      const trace = buildScenarioTrace({ definition: scenario, tasks, models });
      const backgroundLoads = Object.fromEntries(models.map((model) => {
        const loadClass = assignments[seed][model.id];
        const ratio = loadClass === "low" ? 0.4 :
          loadClass === "near" ? 0.9 : null;
        const load = ratio === null
          ? model.normalCapacity +
            0.4 * (model.hardCapacity - model.normalCapacity)
          : ratio * model.normalCapacity;
        return [model.id, load];
      }));
      const experimentLoads = Object.fromEntries(
        models.map((model) => [model.id, 0])
      );
      for (const request of trace) {
        const candidates = buildBaselineCandidates({
          request, models, thresholds: qualityThresholds,
          backgroundLoads, experimentLoads
        });
        observations.push({
          scenario: scenario.id,
          seed,
          requestId: request.requestId,
          taskType: request.taskType,
          difficulty: request.difficulty,
          candidateCount: candidates.length
        });
      }
    }
  }
  return observations;
}

export function runPreflight(): ReturnType<typeof validateCandidateSufficiency> {
  return validateCandidateSufficiency(preflightObservations());
}

const REQUEST_COLUMNS = [
  "scenario", "seed", "method", "requestId", "taskId", "taskType",
  "difficulty", "status", "modelId", "arrivalTimeMs", "completionTimeMs",
  "promptTokens", "maxOutputTokens", "reservedLoad", "loadBefore", "postLoad",
  "normalCapacity", "hardCapacity", "baseTtftMs", "queueWaitMs",
  "endToEndTtftMs", "quality", "nonCongested", "reason",
  "basePricePerMillion", "lockedUnitPrice", "dynamicCheapestQuote",
  "surchargeApplied", "staticCheapestModelId", "dynamicCheapestModelId",
  "priceInducedReroute", "candidateCount"
] as const;

export function executeFormalExperiment(): {
  supported: boolean;
  requestRowCount: number;
  stagingRoot: string;
} {
  const preflight = runPreflight();
  const batch = executeSimulationBatch();
  validateRequestContracts(batch.requests);
  const perSeed: PerSeedMetrics[] = batch.simulations.map(({ result }) =>
    perSeedMetrics(result)
  );
  const aggregate = aggregatePerSeed(perSeed);
  const comparisons = buildPairedComparisons(perSeed);
  const gates = evaluateSuccessGates(perSeed);
  const stagingRoot = path.join(
    EXPERIMENT_ROOT,
    `staging-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`
  );
  const inputRoot = path.join(stagingRoot, "input");
  const outputRoot = path.join(stagingRoot, "output");
  const { models, tasks, qualityThresholds } = loadFrozenProfile();
  const assignments = loadFrozenLoadAssignments(models);
  const lambda0 = loadFrozenLambda0();
  writeJson(path.join(inputRoot, "model-snapshot.json"), models);
  writeJson(path.join(inputRoot, "task-snapshot.json"), tasks);
  writeJson(path.join(inputRoot, "quality-thresholds.json"), qualityThresholds);
  writeJson(path.join(inputRoot, "load-assignments.json"), assignments);
  writeJson(path.join(inputRoot, "scenario-manifest.json"), {
    seeds: SEEDS, requestCount: REQUEST_COUNT, methods: METHODS, lambda0,
    s2Multiplier: 1.5,
    s3Burst: { startFraction: 0.4, endFraction: 0.6,
      taskTypes: ["coding", "math"], multiplier: 3 },
    requestTimeoutMs: REQUEST_TIMEOUT_MS
  });
  writeJson(path.join(inputRoot, "source-manifest.json"), {
    qualityCsv: { path: QUALITY_CSV_PATH, sha256: sha256File(QUALITY_CSV_PATH) },
    capacityCsv: { path: CAPACITY_CSV_PATH, sha256: sha256File(CAPACITY_CSV_PATH) },
    taskSnapshot: { path: TASK_SNAPSHOT_PATH, sha256: sha256File(TASK_SNAPSHOT_PATH) }
  });
  writeJson(path.join(outputRoot, "preflight.json"), preflight);
  writeGzipCsv(
    path.join(outputRoot, "per-request.csv.gz"),
    asCsvRows(batch.requests), REQUEST_COLUMNS
  );
  const loadEvents = batch.simulations.flatMap(({ scenario, seed, method, result }) =>
    result.giniEvents.map((event) => ({ scenario, seed, method, ...event }))
  );
  writeGzipCsv(
    path.join(outputRoot, "load-events.csv.gz"),
    asCsvRows(loadEvents),
    ["scenario", "seed", "method", "startTimeMs", "endTimeMs", "gini"]
  );
  writeCsv(path.join(outputRoot, "per-seed.csv"), asCsvRows(perSeed),
    Object.keys(asCsvRows(perSeed)[0]));
  writeCsv(path.join(outputRoot, "aggregate.csv"), asCsvRows(aggregate),
    Object.keys(asCsvRows(aggregate)[0]));
  const comparisonRows = comparisons.map((comparison) => ({
    scenario: comparison.scenario,
    baseline: comparison.baseline,
    ...Object.fromEntries(Object.entries(comparison.metrics).flatMap(
      ([metric, interval]) => Object.entries(interval).map(
        ([field, value]) => [`${metric}_${field}`, value]
      )
    ))
  }));
  writeCsv(path.join(outputRoot, "paired-comparisons.csv"),
    asCsvRows(comparisonRows), Object.keys(asCsvRows(comparisonRows)[0]));
  const diagnosticRows = perSeed.filter(
    (row) => row.method === "ours-price-first"
  ).map((row) => ({
    scenario: row.scenario, seed: row.seed, routedCount: row.routedCount,
    surchargeActivationRate: row.surchargeActivationRate,
    priceInducedRerouteRate: row.priceInducedRerouteRate,
    distinctSelectedModels: row.distinctSelectedModels,
    selectedModelIds: row.selectedModelIds.join("|")
  }));
  writeCsv(path.join(outputRoot, "price-mechanism-diagnostics.csv"),
    asCsvRows(diagnosticRows), Object.keys(asCsvRows(diagnosticRows)[0]));
  writeJson(path.join(outputRoot, "gates.json"), gates);

  const report = `# Price-First User Experiment Report

## Result

**${gates.supported ? "SUPPORTED" : "UNSUPPORTED"}**

- Requests: ${batch.requests.length}
- Groups: ${batch.simulations.length}
- Candidate preflight observations: ${preflight.requestCount}
- All success checks passed: ${gates.supported}

${gates.checks.map((check) =>
    `- ${check.passed ? "PASS" : "FAIL"} ${check.id}: ${check.detail}`
  ).join("\n")}

No figures were generated.
`;
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, "REPORT.md"), report, "utf8");

  const artifactFiles = [
    ...fs.readdirSync(inputRoot).map((name) => path.join(inputRoot, name)),
    ...fs.readdirSync(outputRoot)
      .filter((name) => name !== "manifest.json")
      .map((name) => path.join(outputRoot, name))
  ];
  const codeRoot = path.join(EXPERIMENT_ROOT, "code");
  const codeFiles = fs.readdirSync(codeRoot)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => path.join(codeRoot, name));
  writeJson(path.join(outputRoot, "manifest.json"), {
    experiment: "price-first-user-pq-cap",
    frozen: { seeds: SEEDS, requestCount: REQUEST_COUNT, methods: METHODS },
    mechanism: gates,
    artifacts: Object.fromEntries(artifactFiles.map((file) => [
      path.relative(stagingRoot, file).replaceAll("\\", "/"),
      sha256File(file)
    ])),
    code: Object.fromEntries(codeFiles.map((file) => [
      path.relative(EXPERIMENT_ROOT, file).replaceAll("\\", "/"),
      sha256File(file)
    ]))
  });
  assertNoFigureArtifacts(stagingRoot);
  validateExperimentDirectory(stagingRoot);
  if (gates.supported) {
    publishDirectories(EXPERIMENT_ROOT, stagingRoot, validateExperimentDirectory);
  }
  return {
    supported: gates.supported,
    requestRowCount: batch.requests.length,
    stagingRoot
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--preflight")) {
    const result = runPreflight();
    process.stdout.write(
      `PREFLIGHT PASSED: ${result.requestCount} observations, ` +
      `${result.strata.length} strata\n`
    );
  } else {
    const result = executeFormalExperiment();
    process.stdout.write(
      `Experiment ${result.supported ? "SUPPORTED" : "UNSUPPORTED"}: ` +
      `${result.requestRowCount} rows; staging ${result.stagingRoot}\n`
    );
    if (!result.supported) process.exitCode = 2;
  }
}
