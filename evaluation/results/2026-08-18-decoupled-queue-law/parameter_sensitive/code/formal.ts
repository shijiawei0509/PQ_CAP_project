import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  sha256File, writeCsv, writeGzipCsv, writeJson,
  type CsvRow,
} from "../../price_first_user/code/export.js";
import {
  CAPACITY_CSV_PATH, QUALITY_CSV_PATH, TASK_SNAPSHOT_PATH,
  loadFrozenProfile,
} from "../../price_first_user/code/model-profile.js";
import {
  FORMAL_REQUEST_COUNT, REQUEST_TIMEOUT_MS, SLO_DEADLINE_MS,
  executeRun, formalSpecs, type ParameterRequestRow,
} from "./experiment.js";
import { FORMAL_SEEDS } from "./parameters.js";
import { aggregateRows, pairedEffects, perSeedMetrics } from "./metrics.js";

const ROOT = process.env.PARAMETER_SENSITIVE_ROOT
  ? path.resolve(process.env.PARAMETER_SENSITIVE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function csvRows(rows: readonly object[]): CsvRow[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(
    ([key, value]) => [key, Array.isArray(value) ? value.join("|") :
      typeof value === "object" && value !== null ? JSON.stringify(value) : value],
  )) as CsvRow);
}

const REQUEST_COLUMNS = [
  "family", "parameterId", "scenarioLabel", "deltaScale", "kappa",
  "tolerance", "scenario", "seed", "requestId", "traceHash", "taskId",
  "taskType", "difficulty", "status", "modelId", "arrivalTimeMs",
  "completionTimeMs", "candidateCount", "quality", "qualityGap",
  "reservedLoad", "loadBefore", "postLoad", "normalCapacity", "hardCapacity",
  "baseTtftMs", "queueWaitMs", "endToEndTtftMs", "completionAwareTtftMs",
  "sloSuccess", "basePricePerMillion", "lockedUnitPrice", "requestPayment",
  "priceInducedReroute", "softPosition",
] as const;

function validatePairing(rows: readonly ParameterRequestRow[]): void {
  const scenarios = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const traceKey = `${row.scenarioLabel}/${row.seed}/${row.requestId}`;
    const byTrace = scenarios.get(traceKey) ?? new Map<string, string>();
    byTrace.set(`${row.family}/${row.parameterId}`, row.traceHash);
    scenarios.set(traceKey, byTrace);
  }
  for (const [traceKey, hashes] of scenarios) {
    if (new Set(hashes.values()).size !== 1) {
      throw new Error(`${traceKey}: exogenous trace mismatch`);
    }
  }
}

function codeHashes(): Record<string, string> {
  const codeRoot = path.join(ROOT, "code");
  return Object.fromEntries(fs.readdirSync(codeRoot)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => [`code/${name}`, sha256File(path.join(codeRoot, name))]));
}

export function runFormal(): Record<string, unknown> {
  const pilotPath = path.join(ROOT, "pilot", "activation-audit.json");
  const pilot = JSON.parse(fs.readFileSync(pilotPath, "utf8")) as { status: string };
  if (pilot.status !== "PASS") throw new Error("Pilot Go/No-Go did not pass");
  const inputRoot = path.join(ROOT, "input");
  const outputRoot = path.join(ROOT, "output");
  const profile = loadFrozenProfile();
  const specs = formalSpecs();
  writeJson(path.join(inputRoot, "model-snapshot.json"), profile.models);
  writeJson(path.join(inputRoot, "task-snapshot.json"), profile.tasks);
  writeJson(path.join(inputRoot, "preregistration.json"), {
    approvedDesign: "../DESIGN.md",
    pilotSha256: sha256File(pilotPath),
    formalSeeds: FORMAL_SEEDS,
    requestCountPerRun: FORMAL_REQUEST_COUNT,
    sloDeadlineMs: SLO_DEADLINE_MS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    specifications: specs,
  });
  writeJson(path.join(inputRoot, "source-manifest.json"), {
    qualityCsv: { path: QUALITY_CSV_PATH, sha256: sha256File(QUALITY_CSV_PATH) },
    capacityCsv: { path: CAPACITY_CSV_PATH, sha256: sha256File(CAPACITY_CSV_PATH) },
    taskSnapshot: { path: TASK_SNAPSHOT_PATH, sha256: sha256File(TASK_SNAPSHOT_PATH) },
  });

  const outputs = specs.flatMap((specification) =>
    FORMAL_SEEDS.map((seed) =>
      executeRun(specification, seed, FORMAL_REQUEST_COUNT)
    )
  );
  const requests = outputs.flatMap((output) => output.requests);
  validatePairing(requests);
  const perSeed = outputs.flatMap(perSeedMetrics);
  const aggregate = aggregateRows(perSeed);
  const effects = pairedEffects(perSeed);
  const candidateRows = requests.map((row) => ({
    family: row.family, parameterId: row.parameterId,
    scenario: row.scenarioLabel, seed: row.seed,
    taskType: row.taskType, difficulty: row.difficulty,
    requestId: row.requestId, candidateCount: row.candidateCount,
  }));
  writeGzipCsv(path.join(outputRoot, "per-request.csv.gz"),
    csvRows(requests), REQUEST_COLUMNS);
  writeCsv(path.join(outputRoot, "per-seed.csv"), csvRows(perSeed),
    Object.keys(csvRows(perSeed)[0]));
  writeCsv(path.join(outputRoot, "aggregate.csv"), csvRows(aggregate),
    Object.keys(csvRows(aggregate)[0]));
  writeCsv(path.join(outputRoot, "paired-effects.csv"), csvRows(effects),
    Object.keys(csvRows(effects)[0]));
  writeGzipCsv(path.join(outputRoot, "candidate-counts-by-difficulty.csv.gz"),
    csvRows(candidateRows), Object.keys(csvRows(candidateRows)[0]));
  const interaction = aggregate.filter((row) => row.family === "interaction");
  writeCsv(path.join(outputRoot, "interaction.csv"), csvRows(interaction),
    Object.keys(csvRows(interaction)[0]));
  const validation = {
    status: "PASS",
    runCount: outputs.length,
    requestRowCount: requests.length,
    perSeedRowCount: perSeed.length,
    aggregateRowCount: aggregate.length,
    tracePairing: "100%",
    finalLoadsZero: outputs.every((output) =>
      output.simulation.validation.finalLoadsZero),
    capacityInvariant: outputs.every((output) =>
      output.simulation.validation.capacityInvariant),
    pilotStatus: pilot.status,
  };
  writeJson(path.join(outputRoot, "validation.json"), validation);
  fs.writeFileSync(path.join(outputRoot, "REPORT.md"), `# Parameter Sensitivity Experiment\n\n` +
    `Formal simulation completed and validated.\n\n` +
    `- Runs: ${outputs.length}\n- Requests: ${requests.length}\n` +
    `- Seeds: ${FORMAL_SEEDS.join(", ")}\n- SLO: ${SLO_DEADLINE_MS} ms\n` +
    `- Trace pairing: 100%\n\n` +
    `Interpretation is generated after independent statistical review and figure QA.\n`, "utf8");
  const artifactNames = fs.readdirSync(outputRoot)
    .filter((name) => name !== "manifest.json").sort();
  writeJson(path.join(outputRoot, "manifest.json"), {
    experiment: "difficulty-and-relative-congestion-sensitivity",
    preregistrationSha256: sha256File(path.join(inputRoot, "preregistration.json")),
    designSha256: sha256File(path.join(ROOT, "DESIGN.md")),
    code: codeHashes(),
    artifacts: Object.fromEntries(artifactNames.map((name) => [
      `output/${name}`, sha256File(path.join(outputRoot, name)),
    ])),
    errors: [],
  });
  return validation;
}
