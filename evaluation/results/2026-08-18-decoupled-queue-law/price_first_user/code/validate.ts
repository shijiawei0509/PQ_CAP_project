import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "../../../../../../scripts/build-runtime-models.js";
import {
  aggregatePerSeed,
  evaluateSuccessGates,
  perSeedMetrics,
  type PerSeedMetrics
} from "./metrics.js";
import {
  assertNoFigureArtifacts,
  readGzipCsv,
  sha256File
} from "./export.js";
import {
  validateCandidateSufficiency,
  type RequestResult,
  type SimulationResult
} from "./simulator.js";
import type { MethodId, QualityThresholds, ScenarioId } from "./types.js";

const PRICE_TOLERANCE = 1e-9;

export function validateRequestContracts(
  rows: readonly RequestResult[]
): void {
  for (const row of rows) {
    const routed = row.modelId !== null;
    if (!routed) continue;
    if (
      row.postLoad === null ||
      row.hardCapacity === null ||
      !(row.postLoad < row.hardCapacity)
    ) {
      throw new Error(`${row.requestId}: accepted row violates hard capacity`);
    }
    if (
      row.basePricePerMillion === null ||
      row.lockedUnitPrice === null ||
      !Number.isFinite(row.basePricePerMillion) ||
      !Number.isFinite(row.lockedUnitPrice) ||
      row.basePricePerMillion < 0 ||
      row.lockedUnitPrice < 0
    ) {
      throw new Error(`${row.requestId}: invalid locked unit price`);
    }
    if (row.method !== "ours-price-first") {
      if (
        Math.abs(row.lockedUnitPrice - row.basePricePerMillion) >
        PRICE_TOLERANCE
      ) {
        throw new Error(`${row.requestId}: baseline locked price is not list price`);
      }
      if (
        row.dynamicCheapestQuote !== null ||
        row.surchargeApplied !== null ||
        row.staticCheapestModelId !== null ||
        row.dynamicCheapestModelId !== null ||
        row.priceInducedReroute !== null
      ) {
        throw new Error(`${row.requestId}: baseline contains CAP diagnostics`);
      }
    } else {
      if (
        row.dynamicCheapestQuote === null ||
        Math.abs(row.lockedUnitPrice - row.dynamicCheapestQuote) >
        PRICE_TOLERANCE
      ) {
        throw new Error(`${row.requestId}: Ours did not lock its dynamic quote`);
      }
    }
  }
}

function finite(row: Record<string, string>, field: string): number {
  const value = Number(row[field]);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${field}: ${row[field]}`);
  return value;
}

function nullableNumber(row: Record<string, string>, field: string): number | null {
  return row[field] === "" ? null : finite(row, field);
}

function nullableBoolean(
  row: Record<string, string>,
  field: string
): boolean | null {
  if (row[field] === "") return null;
  if (row[field] === "true") return true;
  if (row[field] === "false") return false;
  throw new Error(`Invalid ${field}: ${row[field]}`);
}

function requestFromCsv(row: Record<string, string>): RequestResult {
  return {
    scenario: row.scenario as ScenarioId,
    seed: finite(row, "seed"),
    method: row.method as MethodId,
    requestId: row.requestId,
    taskId: row.taskId,
    taskType: row.taskType as RequestResult["taskType"],
    difficulty: row.difficulty as RequestResult["difficulty"],
    status: row.status as RequestResult["status"],
    modelId: row.modelId || null,
    arrivalTimeMs: finite(row, "arrivalTimeMs"),
    completionTimeMs: finite(row, "completionTimeMs"),
    promptTokens: finite(row, "promptTokens"),
    maxOutputTokens: finite(row, "maxOutputTokens"),
    reservedLoad: nullableNumber(row, "reservedLoad"),
    loadBefore: nullableNumber(row, "loadBefore"),
    postLoad: nullableNumber(row, "postLoad"),
    normalCapacity: nullableNumber(row, "normalCapacity"),
    hardCapacity: nullableNumber(row, "hardCapacity"),
    baseTtftMs: nullableNumber(row, "baseTtftMs"),
    queueWaitMs: nullableNumber(row, "queueWaitMs"),
    endToEndTtftMs: nullableNumber(row, "endToEndTtftMs"),
    quality: nullableNumber(row, "quality"),
    nonCongested: nullableBoolean(row, "nonCongested"),
    reason: row.reason,
    basePricePerMillion: nullableNumber(row, "basePricePerMillion"),
    lockedUnitPrice: nullableNumber(row, "lockedUnitPrice"),
    dynamicCheapestQuote: nullableNumber(row, "dynamicCheapestQuote"),
    surchargeApplied: nullableBoolean(row, "surchargeApplied"),
    staticCheapestModelId: row.staticCheapestModelId || null,
    dynamicCheapestModelId: row.dynamicCheapestModelId || null,
    priceInducedReroute: nullableBoolean(row, "priceInducedReroute"),
    candidateCount: finite(row, "candidateCount")
  };
}

function groupKey(row: Pick<RequestResult, "scenario" | "seed" | "method">): string {
  return `${row.scenario}\u0000${row.seed}\u0000${row.method}`;
}

function close(
  actual: number | null,
  expected: number | null,
  tolerance: number,
  label: string
): void {
  if (actual === null || expected === null) {
    if (actual !== expected) throw new Error(`${label}: null mismatch`);
    return;
  }
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

export function validateExperimentDirectory(root: string): {
  requestRowCount: number;
  groupCount: number;
  supported: boolean;
} {
  assertNoFigureArtifacts(root);
  const outputRoot = path.join(root, "output");
  const inputRoot = path.join(root, "input");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(outputRoot, "manifest.json"), "utf8")
  ) as {
    frozen: { seeds: number[]; requestCount: number; methods: MethodId[] };
    mechanism: ReturnType<typeof evaluateSuccessGates>;
    artifacts: Record<string, string>;
    code: Record<string, string>;
  };
  for (const [relative, hash] of Object.entries(manifest.artifacts)) {
    const file = path.join(root, relative);
    if (sha256File(file) !== hash) throw new Error(`Hash mismatch: ${relative}`);
  }
  const experimentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const [relative, hash] of Object.entries(manifest.code)) {
    const file = path.join(experimentRoot, relative);
    if (sha256File(file) !== hash) throw new Error(`Code hash mismatch: ${relative}`);
  }

  const requests = readGzipCsv(path.join(outputRoot, "per-request.csv.gz"))
    .map(requestFromCsv);
  const expectedRows = 3 * manifest.frozen.seeds.length *
    manifest.frozen.methods.length * manifest.frozen.requestCount;
  if (requests.length !== expectedRows) {
    throw new Error(`Expected ${expectedRows} rows, received ${requests.length}`);
  }
  validateRequestContracts(requests);
  const thresholds = JSON.parse(
    fs.readFileSync(path.join(inputRoot, "quality-thresholds.json"), "utf8")
  ) as QualityThresholds;
  for (const row of requests.filter((candidate) => candidate.status === "completed")) {
    if (
      row.quality === null ||
      row.quality + 1e-12 < thresholds[row.taskType][row.difficulty]
    ) {
      throw new Error(`${row.requestId}: completed below frozen quality threshold`);
    }
  }
  validateCandidateSufficiency(requests.map((row) => ({
    scenario: row.scenario,
    seed: row.seed,
    requestId: `${row.method}/${row.requestId}`,
    taskType: row.taskType,
    difficulty: row.difficulty,
    candidateCount: row.candidateCount
  })));

  const groups = new Map<string, RequestResult[]>();
  const unique = new Set<string>();
  for (const row of requests) {
    const uniqueKey = `${groupKey(row)}\u0000${row.requestId}`;
    if (unique.has(uniqueKey)) throw new Error(`Duplicate row ${uniqueKey}`);
    unique.add(uniqueKey);
    const key = groupKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const expectedGroups = 3 * manifest.frozen.seeds.length *
    manifest.frozen.methods.length;
  if (groups.size !== expectedGroups) {
    throw new Error(`Expected ${expectedGroups} groups, received ${groups.size}`);
  }
  for (const [key, rows] of groups) {
    if (rows.length !== manifest.frozen.requestCount) {
      throw new Error(`${key}: incomplete request group`);
    }
  }

  const loadEvents = readGzipCsv(path.join(outputRoot, "load-events.csv.gz"));
  const giniByGroup = new Map<string, { integral: number; duration: number }>();
  for (const event of loadEvents) {
    const key = `${event.scenario}\u0000${event.seed}\u0000${event.method}`;
    const duration = finite(event, "endTimeMs") - finite(event, "startTimeMs");
    const current = giniByGroup.get(key) ?? { integral: 0, duration: 0 };
    current.integral += finite(event, "gini") * duration;
    current.duration += duration;
    giniByGroup.set(key, current);
  }
  const replayed: PerSeedMetrics[] = [...groups.entries()].map(([key, rows]) => {
    const gini = giniByGroup.get(key);
    if (!gini || gini.duration <= 0) throw new Error(`${key}: missing Gini events`);
    const simulation: SimulationResult = {
      requests: rows,
      giniEvents: [],
      timeWeightedLoadGini: gini.integral / gini.duration,
      mixedStateShare: 0,
      capacityRejectedCount:
        rows.filter((row) => row.status === "rejected-capacity").length,
      finalExperimentLoads: {},
      validation: { finalLoadsZero: true, capacityInvariant: true }
    };
    return perSeedMetrics(simulation);
  });
  const writtenRows = parseCsv(
    fs.readFileSync(path.join(outputRoot, "per-seed.csv"), "utf8")
  );
  const writtenByKey = new Map(writtenRows.map((row) => [
    `${row.scenario}\u0000${row.seed}\u0000${row.method}`, row
  ]));
  for (const replay of replayed) {
    const key = groupKey(replay);
    const written = writtenByKey.get(key);
    if (!written) throw new Error(`${key}: missing per-seed metric row`);
    for (const field of [
      "averageQuality", "loadGini", "completionRate", "nonCongestedRate",
      "averageLockedUnitPrice", "p95LockedUnitPrice",
      "surchargeActivationRate", "priceInducedRerouteRate"
    ] as const) {
      close(
        replay[field],
        written[field] === "" ? null : finite(written, field),
        1e-9,
        `${key}/${field}`
      );
    }
    for (const field of ["p95EndToEndTtftMs", "p95QueueWaitMs"] as const) {
      close(
        replay[field],
        written[field] === "" ? null : finite(written, field),
        1e-6,
        `${key}/${field}`
      );
    }
    if (replay.distinctSelectedModels !== finite(written, "distinctSelectedModels")) {
      throw new Error(`${key}: distinct model count mismatch`);
    }
  }
  aggregatePerSeed(replayed);
  const replayGates = evaluateSuccessGates(replayed);
  if (
    replayGates.supported !== manifest.mechanism.supported ||
    replayGates.checks.length !== manifest.mechanism.checks.length ||
    replayGates.checks.some((check, index) =>
      check.id !== manifest.mechanism.checks[index]?.id ||
      check.passed !== manifest.mechanism.checks[index]?.passed
    )
  ) {
    throw new Error("Success gate replay mismatch");
  }
  return {
    requestRowCount: requests.length,
    groupCount: groups.size,
    supported: replayGates.supported
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = validateExperimentDirectory(defaultRoot);
  process.stdout.write(
    `VALIDATION PASSED: ${result.requestRowCount} rows across ` +
    `${result.groupCount} groups; mechanism ` +
    `${result.supported ? "SUPPORTED" : "UNSUPPORTED"}\n`
  );
  if (!result.supported) process.exitCode = 2;
}
