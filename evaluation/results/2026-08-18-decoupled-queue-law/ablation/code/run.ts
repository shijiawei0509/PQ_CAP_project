import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CALIBRATION_RATE_SCALES,
  buildSoftCongestionInputs,
  calibrateArrivalRate,
  observeBalancedReference,
  writeFrozenSoftScenario
} from "./calibrate-soft-congestion.js";
import {
  freezeInputs,
  type FrozenInput
} from "./hash-contract.js";
import {
  assertNoFigureArtifacts,
  buildManifest,
  writeCsv,
  writeJson,
  writePerRequest,
  type CsvRow
} from "./export.js";
import {
  combineSuccessGates,
  evaluateNoCapGate,
  evaluatePreUpdateGate,
  type GateInput
} from "./gates.js";
import { computePerSeedMetrics } from "./metrics.js";
import { loadRegularScenario } from "./scenarios.js";
import {
  cohortInteraction,
  pairedEffect,
  pairedSummary
} from "./statistics.js";
import {
  buildIndependentTrace,
  buildMixedTrace,
  type TraceFixtures
} from "./traces.js";
import {
  CORE_METHODS,
  INDEPENDENT_COHORTS,
  METHOD_CONFIGS,
  PREFERENCE_METHODS,
  SEEDS,
  TASK_TYPES,
  type CoreMethod,
  type ExperimentModel,
  type ExperimentRequest,
  type FormalMethod,
  type IndependentCohort,
  type PerSeedRow,
  type PreferenceMethod,
  type RequestResult,
  type ScenarioId,
  type TaskType
} from "./types.js";
import { simulate, type SimulationResult } from "./simulator.js";
import { validateExperiment } from "./validate.js";

export function runCoreTrace(
  models: readonly ExperimentModel[],
  thresholds: Readonly<Record<TaskType, number>>,
  trace: readonly ExperimentRequest[]
): RequestResult[] {
  return CORE_METHODS.flatMap((method) =>
    simulate({
      method,
      models,
      thresholds,
      requests: trace,
      config: METHOD_CONFIGS[method]
    }).requests
  );
}

const FORMAL_INPUTS = [
  "model-snapshot.json",
  "task-snapshot.json",
  "quality-thresholds.json",
  "load-assignments.json",
  "scenario-manifest.json"
] as const;

export function freezeFormalInputs(
  root: string,
  sourceExperimentRoot: string
): FrozenInput[] {
  const marker = resolve(root, "input", "frozen-inputs.json");
  if (existsSync(marker)) {
    throw new Error("Formal inputs are already frozen");
  }
  const contract = freezeInputs(root, FORMAL_INPUTS.map((name) => ({
    id: name.replace(/\.json$/u, ""),
    source: resolve(sourceExperimentRoot, "input", name),
    snapshot: name === "scenario-manifest.json"
      ? "input/source-manifest.json"
      : `input/${name}`
  })));
  writeJson(marker, contract);
  return contract;
}

const AGGREGATE_METRICS = [
  "averageQuality",
  "averageLockedPayment",
  "p95EndToEndTtftMs",
  "p95QueueWaitMs",
  "completionRate",
  "loadGini",
  "hardCapRejectionOrFailureShare",
  "fixedAdherenceRate",
  "fallbackActivationRate",
  "fallbackSuccessRate"
] as const;

export function aggregatePerSeedRows(
  rows: readonly PerSeedRow[]
): Array<Record<string, string | number | null>> {
  const groups = new Map<string, PerSeedRow[]>();
  for (const row of rows) {
    const key = [row.scenario, row.method, row.cohort].join("\0");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((members) => {
    const first = members[0];
    const output: Record<string, string | number | null> = {
      scenario: first.scenario,
      method: first.method,
      cohort: first.cohort,
      seedCount: members.length,
      requestCountPerSeed: first.requestCount
    };
    for (const metric of AGGREGATE_METRICS) {
      const values = members.flatMap((row) => {
        const value = row[metric];
        return typeof value === "number" ? [value] : [];
      });
      output[`${metric}AvailableSeedCount`] = values.length;
      if (values.length !== members.length) {
        output[`${metric}Mean`] = null;
        output[`${metric}CiLow`] = null;
        output[`${metric}CiHigh`] = null;
      } else {
        const summary = pairedSummary(values);
        output[`${metric}Mean`] = summary.mean;
        output[`${metric}CiLow`] = summary.ciLow;
        output[`${metric}CiHigh`] = summary.ciHigh;
      }
    }
    return output;
  }).sort((left, right) =>
    String(left.scenario).localeCompare(String(right.scenario)) ||
    String(left.method).localeCompare(String(right.method)) ||
    String(left.cohort).localeCompare(String(right.cohort))
  );
}

function loadFrozenContract(root: string): FrozenInput[] {
  const filePath = resolve(root, "input", "frozen-inputs.json");
  if (!existsSync(filePath)) {
    throw new Error("Formal inputs are not frozen");
  }
  return JSON.parse(readFileSync(filePath, "utf8")) as FrozenInput[];
}

type LoadAssignments = Record<string, Record<string, "low" | "near" | "congested">>;

function regularBackgroundLoads(
  models: readonly ExperimentModel[],
  assignments: LoadAssignments,
  seed: number
): Record<string, number> {
  const byModel = assignments[String(seed)];
  if (!byModel) throw new Error(`Missing regular load assignments for seed ${seed}`);
  return Object.fromEntries(models.map((model) => {
    const loadClass = byModel[model.id];
    if (loadClass === "low") return [model.id, 0.4 * model.normalCapacity];
    if (loadClass === "near") return [model.id, 0.9 * model.normalCapacity];
    if (loadClass === "congested") {
      return [
        model.id,
        model.normalCapacity +
          0.4 * (model.hardCapacity - model.normalCapacity)
      ];
    }
    throw new Error(`${seed}/${model.id}: missing frozen load class`);
  }));
}

function splitMetrics(
  result: SimulationResult,
  includeBalanced: boolean
): PerSeedRow[] {
  const cohorts = [...new Set(result.requests.map((row) => row.cohort))];
  const rows = cohorts.map((cohort) => computePerSeedMetrics({
    ...result,
    requests: result.requests.filter((row) => row.cohort === cohort)
  }));
  if (includeBalanced) {
    rows.push({
      ...computePerSeedMetrics(result),
      cohort: "balanced"
    });
  }
  return rows;
}

function runMethod(
  method: FormalMethod,
  models: readonly ExperimentModel[],
  thresholds: Readonly<Record<TaskType, number>>,
  trace: readonly ExperimentRequest[]
): SimulationResult {
  if (CORE_METHODS.includes(method as CoreMethod)) {
    const core = method as CoreMethod;
    return simulate({
      method,
      models,
      thresholds,
      requests: trace,
      config: METHOD_CONFIGS[core]
    });
  }
  if (method === "single-policy-pq-cap") {
    return simulate({
      method,
      models,
      thresholds,
      requests: trace,
      config: METHOD_CONFIGS.full,
      routeNonFixedAs: "quality-first"
    });
  }
  if (method === "preference-aware-static-router") {
    return simulate({
      method,
      models,
      thresholds,
      requests: trace,
      config: METHOD_CONFIGS["no-dynamic-cap"]
    });
  }
  return simulate({
    method,
    models,
    thresholds,
    requests: trace,
    config: METHOD_CONFIGS.full
  });
}

interface FrozenSoftScenario {
  selectedArrivalRate: number;
  statesBySeed: Record<string, ReturnType<typeof buildSoftCongestionInputs>>;
}

function softBackgroundByTask(
  frozen: FrozenSoftScenario,
  seed: number
): Partial<Record<TaskType, Record<string, number>>> {
  const states = frozen.statesBySeed[String(seed)]?.states;
  if (!states) throw new Error(`Missing frozen soft states for seed ${seed}`);
  return Object.fromEntries(TASK_TYPES.map((taskType) => [
    taskType,
    Object.fromEntries(
      states
        .filter((state) => state.taskType === taskType)
        .map((state) => [state.modelId, state.load])
    )
  ]));
}

export function calibrateAndFreezeSoftScenario(root: string): void {
  if (existsSync(resolve(root, "input", "soft-congestion-scenario.json"))) {
    throw new Error("Soft-congestion formal scenario is already frozen");
  }
  const scenario = loadRegularScenario(root, loadFrozenContract(root));
  const manifestRate = Number(scenario.scenarioManifest.lambda0);
  if (!(manifestRate > 0)) throw new Error("Source lambda0 is missing");
  const statesBySeed = Object.fromEntries(SEEDS.map((seed) => [
    String(seed),
    buildSoftCongestionInputs(
      scenario.models,
      scenario.thresholds,
      seed,
      scenario.tasks
    )
  ]));
  const rateCandidates = CALIBRATION_RATE_SCALES.map((scale) =>
    manifestRate * scale
  );
  const observations = rateCandidates.map((arrivalRate) => {
    const perSeed = SEEDS.map((seed) => observeBalancedReference({
      models: scenario.models,
      tasks: scenario.tasks,
      thresholds: scenario.thresholds,
      seed,
      backgroundLoadByTask: softBackgroundByTask({
        selectedArrivalRate: arrivalRate,
        statesBySeed
      }, seed),
      arrivalRate,
      requestCount: 2_000
    }));
    return {
      arrivalRate,
      completionRate:
        perSeed.reduce((sum, row) => sum + row.completionRate, 0) /
          perSeed.length,
      capacityFailureRate:
        perSeed.reduce((sum, row) => sum + row.capacityFailureRate, 0) /
          perSeed.length
    };
  });
  const calibration = calibrateArrivalRate({
    interval: [rateCandidates[0], rateCandidates.at(-1)!],
    observations
  });
  writeJson(
    resolve(root, "input", "soft-congestion-calibration.json"),
    calibration
  );
  writeFrozenSoftScenario(root, {
    selectedArrivalRate: calibration.selectedArrivalRate,
    statesBySeed
  });
}

function runAllFormalSimulations(root: string): {
  requestRows: RequestResult[];
  perSeedRows: PerSeedRow[];
} {
  const scenario = loadRegularScenario(root, loadFrozenContract(root));
  const soft = JSON.parse(readFileSync(
    resolve(root, "input", "soft-congestion-scenario.json"),
    "utf8"
  )) as FrozenSoftScenario;
  const lambda0 = Number(scenario.scenarioManifest.lambda0);
  const assignments = scenario.loadAssignments as LoadAssignments;
  const requestRows: RequestResult[] = [];
  const perSeedRows: PerSeedRow[] = [];

  for (const seed of SEEDS) {
    const regularFixtures: TraceFixtures = {
      models: scenario.models,
      tasks: scenario.tasks,
      arrivalRatePerSecond: lambda0,
      backgroundLoadByModel: regularBackgroundLoads(
        scenario.models,
        assignments,
        seed
      )
    };
    const softFixtures: TraceFixtures = {
      models: scenario.models,
      tasks: scenario.tasks,
      arrivalRatePerSecond: soft.selectedArrivalRate,
      backgroundLoadByTask: softBackgroundByTask(soft, seed)
    };
    for (const cohort of INDEPENDENT_COHORTS) {
      for (const [scenarioId, fixtures] of [
        ["regular", regularFixtures],
        ["soft-congestion", softFixtures]
      ] as const) {
        const trace = buildIndependentTrace(
          scenarioId,
          cohort,
          seed,
          fixtures
        );
        for (const method of CORE_METHODS) {
          const result = runMethod(
            method,
            scenario.models,
            scenario.thresholds,
            trace
          );
          requestRows.push(...result.requests);
          perSeedRows.push(...splitMetrics(result, false));
        }
      }
    }

    const mixedTrace = buildMixedTrace("mixed-regular", seed, regularFixtures);
    for (const method of CORE_METHODS) {
      const result = runMethod(
        method,
        scenario.models,
        scenario.thresholds,
        mixedTrace
      );
      requestRows.push(...result.requests);
      perSeedRows.push(...splitMetrics(result, true));
    }
    for (const method of PREFERENCE_METHODS.filter((candidate) =>
      candidate !== "preference-aware-full"
    )) {
      const result = runMethod(
        method,
        scenario.models,
        scenario.thresholds,
        mixedTrace
      );
      requestRows.push(...result.requests);
      perSeedRows.push(...splitMetrics(result, true));
    }
    const fullMixed = perSeedRows.filter((row) =>
      row.scenario === "mixed-regular" &&
      row.seed === seed &&
      row.method === "full"
    );
    perSeedRows.push(...fullMixed.map((row) => ({
      ...row,
      method: "preference-aware-full" as PreferenceMethod
    })));
  }
  return { requestRows, perSeedRows };
}

const EFFECT_METRICS = [
  "averageQuality",
  "averageLockedPayment",
  "p95EndToEndTtftMs",
  "p95QueueWaitMs",
  "completionRate",
  "loadGini"
] as const;

export function pairedOutputs(perSeedRows: readonly PerSeedRow[]): {
  effects: CsvRow[];
  interactions: CsvRow[];
} {
  const effects: CsvRow[] = [];
  const summaries = new Map<string, ReturnType<typeof pairedEffect>>();
  for (const scenario of ["regular", "soft-congestion", "mixed-regular"] as const) {
    for (const cohort of ["quality-first", "price-first"] as const) {
      const full = perSeedRows.filter((row) =>
        row.scenario === scenario &&
        row.cohort === cohort &&
        row.method === "full"
      );
      for (const method of CORE_METHODS.filter((value) => value !== "full")) {
        const ablation = perSeedRows.filter((row) =>
          row.scenario === scenario &&
          row.cohort === cohort &&
          row.method === method
        );
        for (const metric of EFFECT_METRICS) {
          if (
            full.length !== 6 ||
            ablation.length !== 6 ||
            full.some((row) => row[metric] === null) ||
            ablation.some((row) => row[metric] === null)
          ) {
            continue;
          }
          const scale = [
            "averageLockedPayment",
            "p95EndToEndTtftMs",
            "p95QueueWaitMs"
          ].includes(metric) ? "relative" : "absolute";
          if (
            scale === "relative" &&
            ablation.some((row) => row[metric] === 0)
          ) {
            effects.push({
              scenario,
              cohort,
              method,
              metric,
              direction: "full-minus-ablation",
              scale,
              mean: null,
              sd: null,
              ciLow: null,
              ciHigh: null,
              pTwoSided: null,
              seedDifferences: null,
              undefinedReason: "relative-denominator-zero"
            });
            continue;
          }
          const summary = pairedEffect(
            full,
            ablation,
            metric,
            scale
          );
          summaries.set([scenario, cohort, method, metric].join("\0"), summary);
          effects.push({
            scenario,
            cohort,
            method,
            metric,
            direction: "full-minus-ablation",
            scale,
            mean: summary.mean,
            sd: summary.sd,
            ciLow: summary.ciLow,
            ciHigh: summary.ciHigh,
            pTwoSided: summary.pTwoSided,
            seedDifferences: JSON.stringify(summary.seedDifferences),
            undefinedReason: null
          });
        }
      }
    }
  }
  const interactions: CsvRow[] = [];
  for (const scenario of ["regular", "soft-congestion", "mixed-regular"] as const) {
    for (const method of CORE_METHODS.filter((value) => value !== "full")) {
      for (const metric of EFFECT_METRICS) {
        const price = summaries.get([
          scenario, "price-first", method, metric
        ].join("\0"));
        const quality = summaries.get([
          scenario, "quality-first", method, metric
        ].join("\0"));
        if (!price || !quality) continue;
        const interaction = cohortInteraction(price, quality);
        interactions.push({
          scenario,
          method,
          metric,
          direction: "price-effect-minus-quality-effect",
          mean: interaction.mean,
          sd: interaction.sd,
          ciLow: interaction.ciLow,
          ciHigh: interaction.ciHigh,
          pTwoSided: interaction.pTwoSided,
          seedDifferences: JSON.stringify(interaction.seedDifferences)
        });
      }
    }
  }
  return { effects, interactions };
}

function gateInput(
  rows: readonly PerSeedRow[],
  comparator: "no-dynamic-cap" | "pre-update-cap-pricing"
): GateInput {
  const metricBySeed = (
    method: "full" | typeof comparator,
    metric: "loadGini" | "p95QueueWaitMs"
  ): number[] => SEEDS.map((seed) => {
    const members = INDEPENDENT_COHORTS.map((cohort) => rows.find((row) =>
      row.scenario === "soft-congestion" &&
      row.seed === seed &&
      row.method === method &&
      row.cohort === cohort
    ));
    if (members.some((row) => !row || row[metric] === null)) {
      throw new Error(`${method}/${metric}/${seed}: missing gate row`);
    }
    return members.reduce((sum, row) => sum + Number(row![metric]), 0) / 2;
  });
  const fullGini = metricBySeed("full", "loadGini");
  const comparatorGini = metricBySeed(comparator, "loadGini");
  const fullQueue = metricBySeed("full", "p95QueueWaitMs");
  const comparatorQueue = metricBySeed(comparator, "p95QueueWaitMs");
  const gini = pairedSummary(fullGini.map((value, index) =>
    value - comparatorGini[index]
  ));
  const queueRelative = pairedSummary(fullQueue.map((value, index) => {
    if (comparatorQueue[index] === 0) {
      if (value === 0) return 0;
      throw new Error(`${comparator}: zero P95 queue denominator`);
    }
    return (value - comparatorQueue[index]) / comparatorQueue[index];
  }));
  const completionByCohort = Object.fromEntries(
    INDEPENDENT_COHORTS.map((cohort) => {
      const differences = SEEDS.map((seed) => {
        const full = rows.find((row) =>
          row.scenario === "soft-congestion" &&
          row.seed === seed &&
          row.method === "full" &&
          row.cohort === cohort
        );
        const comparison = rows.find((row) =>
          row.scenario === "soft-congestion" &&
          row.seed === seed &&
          row.method === comparator &&
          row.cohort === cohort
        );
        if (!full || !comparison) throw new Error("Missing completion gate row");
        return full.completionRate - comparison.completionRate;
      });
      return [cohort, pairedSummary(differences)];
    })
  ) as Record<IndependentCohort, ReturnType<typeof pairedSummary>>;
  const cohortPointEffects = Object.fromEntries(
    INDEPENDENT_COHORTS.map((cohort) => {
      const effect = (metric: "loadGini" | "p95QueueWaitMs", relative: boolean) => {
        const differences = SEEDS.map((seed) => {
          const full = rows.find((row) =>
            row.scenario === "soft-congestion" &&
            row.seed === seed &&
            row.method === "full" &&
            row.cohort === cohort
          )!;
          const comparison = rows.find((row) =>
            row.scenario === "soft-congestion" &&
            row.seed === seed &&
            row.method === comparator &&
            row.cohort === cohort
          )!;
          const difference = Number(full[metric]) - Number(comparison[metric]);
          return relative
            ? difference / Number(comparison[metric])
            : difference;
        });
        return pairedSummary(differences).mean;
      };
      return [cohort, {
        gini: effect("loadGini", false),
        queueRelative: effect("p95QueueWaitMs", true)
      }];
    })
  ) as GateInput["cohortPointEffects"];
  return { gini, queueRelative, completionByCohort, cohortPointEffects };
}

export function executeFormalExperiment(root: string): void {
  if (existsSync(resolve(root, "output", "manifest.json"))) {
    throw new Error("Formal output is already frozen");
  }
  const { requestRows, perSeedRows } = runAllFormalSimulations(root);
  const aggregate = aggregatePerSeedRows(perSeedRows);
  const { effects, interactions } = pairedOutputs(perSeedRows);
  const noCap = evaluateNoCapGate(gateInput(perSeedRows, "no-dynamic-cap"));
  const preUpdate = evaluatePreUpdateGate(
    gateInput(perSeedRows, "pre-update-cap-pricing")
  );
  const overall = combineSuccessGates({ noCap, preUpdate });
  const output = resolve(root, "output");
  writePerRequest(resolve(output, "per-request.csv.gz"), requestRows);
  writeCsv(
    resolve(output, "per-seed.csv"),
    perSeedRows as unknown as CsvRow[],
    Object.keys(perSeedRows[0])
  );
  writeCsv(
    resolve(output, "aggregate.csv"),
    aggregate as CsvRow[],
    Object.keys(aggregate[0])
  );
  writeCsv(
    resolve(output, "paired-effects.csv"),
    effects,
    Object.keys(effects[0])
  );
  writeCsv(
    resolve(output, "cohort-interactions.csv"),
    interactions,
    Object.keys(interactions[0])
  );
  writeJson(resolve(output, "success-gates.json"), {
    noDynamicCap: noCap,
    preUpdate,
    overall
  });
  writeJson(resolve(output, "run-metadata.json"), {
    seeds: SEEDS,
    coreMethods: CORE_METHODS,
    preferenceMethods: PREFERENCE_METHODS,
    requestRows: requestRows.length,
    statisticalUnit: "seed",
    pairedDirection: "full-minus-ablation",
    interactionDirection: "price-effect-minus-quality-effect"
  });
  const report = [
    "# PQ-CAP Core Ablation Report",
    "",
    `Gate conclusion: **${overall.conclusion}**`,
    "",
    `- Request rows retained: ${requestRows.length}`,
    `- Per-seed rows: ${perSeedRows.length}`,
    "- P95 latency and queue metrics must be interpreted with completion rate.",
    "- All inferential intervals use six paired seeds.",
    "- Gini is an outcome metric only and is not available to routers.",
    "",
    "See `success-gates.json`, `paired-effects.csv`, and " +
      "`cohort-interactions.csv` for complete results.",
    ""
  ].join("\n");
  writeFileText(resolve(output, "REPORT.md"), report);
  assertNoFigureArtifacts(root);
  const baseManifest = buildManifest(root);
  writeJson(resolve(output, "manifest.json"), {
    experiment: "pq-cap-core-ablation",
    frozen: {
      seeds: SEEDS,
      coreMethods: CORE_METHODS,
      preferenceMethods: PREFERENCE_METHODS,
      independentRequestCount: 2_000,
      mixedCohortQuota: 500,
      pairedDirection: "full-minus-ablation",
      interactionDirection: "price-effect-minus-quality-effect",
      completionNoninferiority: -0.005,
      giniWorseningTolerance: 0.005,
      queueRelativeWorseningTolerance: 0.05
    },
    ...baseManifest
  });
  validateExperiment(root);
}

function writeFileText(filePath: string, text: string): void {
  writeFileSync(filePath, text, "utf8");
}

export const EXPERIMENT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);
export const SOURCE_EXPERIMENT_ROOT = resolve(EXPERIMENT_ROOT, "..", "..");

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "--freeze-inputs") {
    freezeFormalInputs(EXPERIMENT_ROOT, SOURCE_EXPERIMENT_ROOT);
  } else if (command === "--calibrate-soft-congestion") {
    calibrateAndFreezeSoftScenario(EXPERIMENT_ROOT);
  } else if (command === "--formal") {
    executeFormalExperiment(EXPERIMENT_ROOT);
  } else {
    throw new Error(
      "Expected --freeze-inputs, --calibrate-soft-congestion, or --formal"
    );
  }
}
