import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "../../../../scripts/build-runtime-models.js";
import {
  assertNoFigureArtifacts,
  readGzipCsv,
  sha256File
} from "./export.js";
import {
  aggregatePerSeed,
  type AggregateMetrics,
  type PerSeedMetrics
} from "./metrics.js";
import type { MethodId, ScenarioId } from "./types.js";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function number(row: Record<string, string>, field: string): number {
  const value = Number(row[field]);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${field}: ${row[field]}`);
  return value;
}

function percentile95(values: number[]): number {
  if (values.length === 0) throw new Error("Cannot replay P95 from empty values");
  values.sort((left, right) => left - right);
  return values[Math.max(0, Math.ceil(values.length * 0.95) - 1)];
}

function key(row: Record<string, string>): string {
  return `${row.scenario}\u0000${row.seed}\u0000${row.method}`;
}

function close(actual: number, expected: number, tolerance: number, label: string): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

export function validateExperiment(root = DEFAULT_ROOT): {
  requestRowCount: number;
  groupCount: number;
} {
  assertNoFigureArtifacts(root);
  const outputRoot = path.join(root, "output");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(outputRoot, "manifest.json"), "utf8")
  ) as {
    frozen: {
      seeds: number[];
      requestCount: number;
      methods: MethodId[];
    };
    artifacts: Record<string, string>;
    code: Record<string, string>;
  };
  for (const [relativePath, hash] of Object.entries({
    ...manifest.artifacts,
    ...manifest.code
  })) {
    const file = path.join(root, relativePath);
    if (sha256File(file) !== hash) throw new Error(`Hash mismatch: ${relativePath}`);
  }

  const requests = readGzipCsv(path.join(outputRoot, "per-request.csv.gz"));
  const expectedRows =
    3 * manifest.frozen.seeds.length *
    manifest.frozen.methods.length *
    manifest.frozen.requestCount;
  if (requests.length !== expectedRows) {
    throw new Error(`Expected ${expectedRows} request rows, received ${requests.length}`);
  }
  const groups = new Map<string, Record<string, string>[]>();
  const unique = new Set<string>();
  for (const row of requests) {
    const rowKey = `${key(row)}\u0000${row.requestId}`;
    if (unique.has(rowKey)) throw new Error(`Duplicate request row ${rowKey}`);
    unique.add(rowKey);
    const groupKey = key(row);
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), row]);
  }
  for (const [groupKey, rows] of groups) {
    if (rows.length !== manifest.frozen.requestCount) {
      throw new Error(`${groupKey}: expected ${manifest.frozen.requestCount} rows`);
    }
  }

  const loadEvents = readGzipCsv(path.join(outputRoot, "load-events.csv.gz"));
  const giniByGroup = new Map<string, { integral: number; duration: number }>();
  for (const event of loadEvents) {
    const groupKey = key(event);
    const duration = number(event, "endTimeMs") - number(event, "startTimeMs");
    const current = giniByGroup.get(groupKey) ?? { integral: 0, duration: 0 };
    current.integral += number(event, "gini") * duration;
    current.duration += duration;
    giniByGroup.set(groupKey, current);
  }

  const replayed: PerSeedMetrics[] = [...groups.entries()].map(([groupKey, rows]) => {
    const completed = rows.filter((row) => row.status === "completed");
    const routed = rows.filter((row) => row.modelId !== "");
    if (completed.length === 0 || routed.length === 0) {
      throw new Error(`${groupKey}: empty metric denominator`);
    }
    const gini = giniByGroup.get(groupKey);
    if (!gini || gini.duration <= 0) throw new Error(`${groupKey}: missing Gini events`);
    return {
      scenario: rows[0].scenario as ScenarioId,
      seed: number(rows[0], "seed"),
      method: rows[0].method as MethodId,
      requestCount: rows.length,
      completedCount: completed.length,
      routedCount: routed.length,
      averageQuality:
        completed.reduce((sum, row) => sum + number(row, "quality"), 0) / completed.length,
      p95EndToEndTtftMs: percentile95(
        completed.map((row) => number(row, "endToEndTtftMs"))
      ),
      p95QueueWaitMs: percentile95(completed.map((row) => number(row, "queueWaitMs"))),
      loadGini: gini.integral / gini.duration,
      completionRate: completed.length / rows.length,
      nonCongestedRate:
        routed.filter((row) => row.nonCongested === "true").length / routed.length
    };
  });

  const writtenPerSeed = parseCsv(
    fs.readFileSync(path.join(outputRoot, "per-seed.csv"), "utf8")
  );
  const writtenByKey = new Map(writtenPerSeed.map((row) => [key(row), row]));
  for (const replay of replayed) {
    const groupKey = `${replay.scenario}\u0000${replay.seed}\u0000${replay.method}`;
    const written = writtenByKey.get(groupKey);
    if (!written) throw new Error(`${groupKey}: missing written per-seed row`);
    for (const field of [
      "averageQuality",
      "loadGini",
      "completionRate",
      "nonCongestedRate"
    ] as const) {
      close(replay[field], number(written, field), 1e-9, `${groupKey}/${field}`);
    }
    for (const field of ["p95EndToEndTtftMs", "p95QueueWaitMs"] as const) {
      close(replay[field], number(written, field), 1e-6, `${groupKey}/${field}`);
    }
  }

  const replayAggregate = aggregatePerSeed(replayed);
  const writtenAggregate = parseCsv(
    fs.readFileSync(path.join(outputRoot, "aggregate.csv"), "utf8")
  );
  const aggregateKey = (
    row: Pick<AggregateMetrics, "scenario" | "method"> | Record<string, string>
  ): string => `${row.scenario}\u0000${row.method}`;
  const writtenAggregateByKey = new Map(
    writtenAggregate.map((row) => [aggregateKey(row), row])
  );
  for (const replay of replayAggregate) {
    const written = writtenAggregateByKey.get(aggregateKey(replay));
    if (!written) throw new Error(`${aggregateKey(replay)}: missing aggregate row`);
    for (const [field, value] of Object.entries(replay)) {
      if (field === "scenario" || field === "method") continue;
      close(
        value as number,
        number(written, field),
        field.toLowerCase().includes("ttft") ? 1e-6 : 1e-9,
        `${aggregateKey(replay)}/${field}`
      );
    }
  }
  return { requestRowCount: requests.length, groupCount: groups.size };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = validateExperiment();
  process.stdout.write(
    `VALIDATION PASSED: ${result.requestRowCount} rows across ${result.groupCount} groups\n`
  );
}
