import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TASK_TYPES, type TaskType } from "../../../../server/types.js";
import {
  assertNoFigureArtifacts,
  sha256File,
  writeCsv,
  writeGzipCsv,
  writeJson
} from "./export.js";
import { anchorLoad, buildLoadAssignments } from "./load-traces.js";
import {
  CAPACITY_CSV_PATH,
  PROJECT_ROOT,
  QUALITY_CSV_PATH,
  TASK_SNAPSHOT_PATH,
  freezeQualityThresholds,
  loadFrozenProfile
} from "./model-profile.js";
import {
  aggregatePerSeed,
  evaluateMechanism,
  perSeedMetrics,
  type PerSeedMetrics
} from "./metrics.js";
import {
  createBalancedReferenceRouter,
  createRouters
} from "./routers.js";
import {
  buildScenarioTrace,
  calibrateBaseRate,
  scenarioDefinitions,
  type CalibrationResult
} from "./scenarios.js";
import { QUEUE_LAW } from "./queue-model.js";
import { simulate, type RequestResult } from "./simulator.js";
import {
  METHODS,
  REQUEST_COUNT,
  SEEDS,
  type MethodId,
  type ScenarioId
} from "./types.js";

export const EXPERIMENT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const REQUEST_TIMEOUT_MS = 300_000;

const REQUEST_COLUMNS = [
  "scenario", "seed", "method", "requestId", "taskId", "taskType", "status",
  "modelId", "arrivalTimeMs", "completionTimeMs", "promptTokens", "maxOutputTokens",
  "reservedLoad", "loadBefore", "postLoad", "normalCapacity", "hardCapacity",
  "baseTtftMs", "queueWaitMs", "endToEndTtftMs", "quality", "nonCongested", "reason"
] as const;

function bestSingleModelId(
  models: ReturnType<typeof loadFrozenProfile>["models"]
): string {
  return [...models].sort((left, right) => {
    const leftAverage = TASK_TYPES.reduce(
      (sum, taskType) => sum + left.quality[taskType],
      0
    ) / TASK_TYPES.length;
    const rightAverage = TASK_TYPES.reduce(
      (sum, taskType) => sum + right.quality[taskType],
      0
    ) / TASK_TYPES.length;
    return rightAverage - leftAverage || left.id.localeCompare(right.id);
  })[0].id;
}

function calibrate(
  models: ReturnType<typeof loadFrozenProfile>["models"],
  tasks: ReturnType<typeof loadFrozenProfile>["tasks"],
  thresholds: Readonly<Record<TaskType, number>>,
  assignments: ReturnType<typeof buildLoadAssignments>
): CalibrationResult {
  return calibrateBaseRate((rate) => {
    const observations = SEEDS.map((seed) => {
      const scenario = scenarioDefinitions(rate, seed).S1;
      return simulate({
        scenario,
        requests: buildScenarioTrace({ definition: scenario, tasks, models }),
        models,
        thresholds,
        loadClasses: assignments[seed],
        router: createBalancedReferenceRouter(),
        requestTimeoutMs: REQUEST_TIMEOUT_MS
      });
    });
    return {
      completedCount: Math.min(...observations.map((result) =>
        result.requests.filter((row) => row.status === "completed").length
      )),
      capacityRejectedCount: Math.max(
        ...observations.map((result) => result.capacityRejectedCount)
      ),
      mixedStateShare: Math.min(...observations.map((result) => result.mixedStateShare))
    };
  });
}

function csvRows<T extends object>(rows: readonly T[]): Array<Record<string, string | number | boolean | null>> {
  return rows.map((row) => ({ ...(row as Record<string, string | number | boolean | null>) }));
}

function reportTable(rows: ReturnType<typeof aggregatePerSeed>, scenario: ScenarioId): string {
  const selected = rows.filter((row) => row.scenario === scenario);
  return [
    "| Method | Quality | P95 TTFT ms | P95 queue ms | Gini | Completion | Non-congested |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...selected.map((row) =>
      `| ${row.method} | ${row.averageQualityMean.toFixed(6)} | ` +
      `${row.p95EndToEndTtftMsMean.toFixed(3)} | ${row.p95QueueWaitMsMean.toFixed(3)} | ` +
      `${row.loadGiniMean.toFixed(6)} | ${row.completionRateMean.toFixed(6)} | ` +
      `${row.nonCongestedRateMean.toFixed(6)} |`
    )
  ].join("\n");
}

export interface ExecuteOptions {
  outputRoot?: string;
  requestCount?: number;
  seeds?: readonly number[];
  methodIds?: readonly MethodId[];
  lambda0Override?: number;
}

export function executeExperiment(options: ExecuteOptions = {}): {
  perSeed: PerSeedMetrics[];
  supported: boolean;
  requestRowCount: number;
} {
  const outputRoot = options.outputRoot ?? EXPERIMENT_ROOT;
  const requestCount = options.requestCount ?? REQUEST_COUNT;
  const seeds = options.seeds ?? SEEDS;
  const methodIds = options.methodIds ?? METHODS;
  const { models, tasks } = loadFrozenProfile();
  const thresholds = freezeQualityThresholds(models);
  const assignments = buildLoadAssignments(models, thresholds, seeds);
  const calibration = options.lambda0Override === undefined
    ? calibrate(models, tasks, thresholds, buildLoadAssignments(models, thresholds, SEEDS))
    : {
        rate: options.lambda0Override,
        lower: options.lambda0Override,
        upper: options.lambda0Override,
        iterations: 0,
        observation: {
          completedCount: requestCount,
          capacityRejectedCount: 0,
          mixedStateShare: 1
        }
      };
  const bestModelId = bestSingleModelId(models);
  const allRequests: RequestResult[] = [];
  const allGiniEvents: Array<Record<string, string | number>> = [];
  const perSeed: PerSeedMetrics[] = [];

  for (const seed of seeds) {
    const definitions = scenarioDefinitions(calibration.rate, seed, requestCount);
    for (const scenario of Object.values(definitions)) {
      const trace = buildScenarioTrace({ definition: scenario, tasks, models });
      for (const router of createRouters(bestModelId).filter(
        (candidate) => methodIds.includes(candidate.id as MethodId)
      )) {
        const result = simulate({
          scenario,
          requests: trace,
          models,
          thresholds,
          loadClasses: assignments[seed],
          router,
          requestTimeoutMs: REQUEST_TIMEOUT_MS
        });
        if (!result.validation.finalLoadsZero || !result.validation.capacityInvariant) {
          throw new Error(`${scenario.id}/${seed}/${router.id}: simulation invariant failed`);
        }
        allRequests.push(...result.requests);
        result.giniEvents.forEach((event) => allGiniEvents.push({
          scenario: scenario.id,
          seed,
          method: router.id,
          ...event
        }));
        perSeed.push(perSeedMetrics(result));
      }
    }
  }

  const aggregate = aggregatePerSeed(perSeed);
  const mechanism = evaluateMechanism(perSeed);
  const inputRoot = path.join(outputRoot, "input");
  const resultRoot = path.join(outputRoot, "output");
  writeJson(path.join(inputRoot, "model-snapshot.json"), models);
  writeJson(path.join(inputRoot, "task-snapshot.json"), tasks);
  writeJson(path.join(inputRoot, "quality-thresholds.json"), thresholds);
  writeJson(path.join(inputRoot, "load-assignments.json"), assignments);
  writeJson(path.join(inputRoot, "scenario-manifest.json"), {
    seeds,
    requestCount,
    methods: methodIds,
    lambda0: calibration.rate,
    s2Multiplier: 1.5,
    s3Burst: {
      startFraction: 0.4,
      endFraction: 0.6,
      taskTypes: ["coding", "math"],
      multiplier: 3
    },
    requestTimeoutMs: REQUEST_TIMEOUT_MS
  });
  writeJson(path.join(resultRoot, "calibration.json"), calibration);
  writeGzipCsv(
    path.join(resultRoot, "per-request.csv.gz"),
    csvRows(allRequests),
    REQUEST_COLUMNS
  );
  writeGzipCsv(
    path.join(resultRoot, "load-events.csv.gz"),
    allGiniEvents,
    ["scenario", "seed", "method", "startTimeMs", "endTimeMs", "gini"]
  );
  writeCsv(
    path.join(resultRoot, "per-seed.csv"),
    csvRows(perSeed),
    Object.keys(perSeed[0])
  );
  writeCsv(
    path.join(resultRoot, "aggregate.csv"),
    csvRows(aggregate),
    Object.keys(aggregate[0])
  );
  writeCsv(
    path.join(resultRoot, "paired-comparisons.csv"),
    csvRows(mechanism.checks),
    Object.keys(mechanism.checks[0] ?? {
      scenario: "", metric: "", passed: "", comparator: "",
      pairedMean: "", pairedCiLow: "", pairedCiHigh: ""
    })
  );

  const report = `# Quality-First Threshold-Queue Experiment Report

## Mechanism result

**${mechanism.supported ? "SUPPORTED" : "NOT SUPPORTED"}**

The success gate uses non-congestion rate and P95 queue wait only. Gini is reported but is not a required-success criterion.

## S1

${reportTable(aggregate, "S1")}

## S2

${reportTable(aggregate, "S2")}

## S3

${reportTable(aggregate, "S3")}

## Pre-registered checks

${mechanism.checks.map((check) =>
  `- ${check.scenario} ${check.metric} vs ${check.comparator}: ` +
  `${check.passed ? "PASS" : "FAIL"} (paired mean ${check.pairedMean})`
).join("\n")}

No figures were generated.
`;
  fs.mkdirSync(resultRoot, { recursive: true });
  fs.writeFileSync(path.join(resultRoot, "REPORT.md"), report, "utf8");

  const artifactPaths = [
    ...fs.readdirSync(inputRoot).map((name) => path.join(inputRoot, name)),
    ...fs.readdirSync(resultRoot)
      .filter((name) => name !== "manifest.json")
      .map((name) => path.join(resultRoot, name))
  ];
  const codeRoot = path.join(outputRoot, "code");
  const codeFiles = fs.existsSync(codeRoot)
    ? fs.readdirSync(codeRoot).filter((name) => name.endsWith(".ts"))
      .map((name) => path.join(codeRoot, name))
    : [];
  writeJson(path.join(resultRoot, "manifest.json"), {
    experiment: "quality-first-threshold-queue",
    designPath: path.join(outputRoot, "DESIGN.md"),
    sourceInputs: {
      qualityCsv: { path: QUALITY_CSV_PATH, sha256: sha256File(QUALITY_CSV_PATH) },
      capacityCsv: { path: CAPACITY_CSV_PATH, sha256: sha256File(CAPACITY_CSV_PATH) },
      taskSnapshot: { path: TASK_SNAPSHOT_PATH, sha256: sha256File(TASK_SNAPSHOT_PATH) }
    },
    frozen: {
      seeds,
      requestCount,
      methods: methodIds,
      qualityEpsilon: 0.02,
      queueLaw: QUEUE_LAW,
      queueFormula: QUEUE_LAW === "odds"
        ? "baseTtftMs*x/(1-x)"
        : QUEUE_LAW === "linear"
          ? "4*baseTtftMs*x"
          : "6*baseTtftMs*x^2",
      routerOrder: ["non-congestion", "queue", "base-ttft", "post-gini"]
    },
    mechanism,
    artifacts: Object.fromEntries(artifactPaths.map((file) => [
      path.relative(outputRoot, file).replaceAll("\\", "/"),
      sha256File(file)
    ])),
    code: Object.fromEntries(codeFiles.map((file) => [
      path.relative(outputRoot, file).replaceAll("\\", "/"),
      sha256File(file)
    ]))
  });
  assertNoFigureArtifacts(outputRoot);
  return {
    perSeed,
    supported: mechanism.supported,
    requestRowCount: allRequests.length
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = executeExperiment();
  process.stdout.write(
    `Experiment complete: ${result.requestRowCount} requests; ` +
    `mechanism ${result.supported ? "SUPPORTED" : "NOT SUPPORTED"}\n`
  );
}
