import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { sha256File } from "./hash-contract.js";
import type {
  RequestResult
} from "./types.js";

type CsvValue = string | number | boolean | null | undefined;
export type CsvRow = Record<string, CsvValue>;

export const REQUEST_COLUMNS = [
  "scenario",
  "seed",
  "method",
  "cohort",
  "requestId",
  "traceHash",
  "status",
  "completed",
  "modelId",
  "currentLoad",
  "reservedLoad",
  "postLoad",
  "normalCapacity",
  "hardCapacity",
  "quality",
  "lockedPayment",
  "naturalTtftMs",
  "queueWaitMs",
  "endToEndTtftMs",
  "fixedModelId",
  "fixedAdhered",
  "fallbackActivated",
  "fallbackSucceeded"
] as const;

function escapeCsv(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text)
    ? `"${text.replaceAll("\"", "\"\"")}"`
    : text;
}

export function csvText(
  rows: readonly CsvRow[],
  columns: readonly string[]
): string {
  return [
    columns.map(escapeCsv).join(","),
    ...rows.map((row) =>
      columns.map((column) => escapeCsv(row[column])).join(",")
    )
  ].join("\n") + "\n";
}

export function writeCsv(
  filePath: string,
  rows: readonly CsvRow[],
  columns: readonly string[]
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, csvText(rows, columns), "utf8");
}

export function writeGzipCsv(
  filePath: string,
  rows: readonly CsvRow[],
  columns: readonly string[]
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    gzipSync(Buffer.from(csvText(rows, columns), "utf8"), { level: 9 })
  );
}

export function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === "\"" && text[index + 1] === "\"") {
        field += "\"";
        index += 1;
      } else if (character === "\"") {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === "\"") {
      quoted = true;
    } else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\n") {
      record.push(field.replace(/\r$/u, ""));
      records.push(record);
      record = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const [header, ...rows] = records;
  if (!header) return [];
  return rows
    .filter((row) => row.some((value) => value !== ""))
    .map((row) => Object.fromEntries(
      header.map((column, index) => [column, row[index] ?? ""])
    ));
}

function nullableNumber(value: string): number | null {
  return value === "" ? null : Number(value);
}

function nullableBoolean(value: string): boolean | null {
  return value === "" ? null : value === "true";
}

export function writePerRequest(
  filePath: string,
  rows: readonly RequestResult[]
): void {
  writeGzipCsv(
    filePath,
    rows as unknown as CsvRow[],
    REQUEST_COLUMNS
  );
}

export function readPerRequest(filePath: string): RequestResult[] {
  const text = gunzipSync(readFileSync(filePath)).toString("utf8");
  return parseCsv(text).map((row) => ({
    scenario: row.scenario as RequestResult["scenario"],
    seed: Number(row.seed),
    method: row.method as RequestResult["method"],
    cohort: row.cohort as RequestResult["cohort"],
    requestId: row.requestId,
    traceHash: row.traceHash,
    status: row.status as RequestResult["status"],
    completed: row.completed === "true",
    modelId: row.modelId || null,
    currentLoad: nullableNumber(row.currentLoad),
    reservedLoad: nullableNumber(row.reservedLoad),
    postLoad: nullableNumber(row.postLoad),
    normalCapacity: nullableNumber(row.normalCapacity),
    hardCapacity: nullableNumber(row.hardCapacity),
    quality: nullableNumber(row.quality),
    lockedPayment: nullableNumber(row.lockedPayment),
    naturalTtftMs: nullableNumber(row.naturalTtftMs),
    queueWaitMs: nullableNumber(row.queueWaitMs),
    endToEndTtftMs: nullableNumber(row.endToEndTtftMs),
    fixedModelId: row.fixedModelId || null,
    fixedAdhered: nullableBoolean(row.fixedAdhered),
    fallbackActivated: row.fallbackActivated === "true",
    fallbackSucceeded: nullableBoolean(row.fallbackSucceeded)
  }));
}

function walkFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

export interface ArtifactManifest {
  inputs: Record<string, string>;
  code: Record<string, string>;
  artifacts: Record<string, string>;
  errors: string[];
}

export function buildManifest(root: string): ArtifactManifest {
  const absoluteRoot = resolve(root);
  const hashes = (folder: "input" | "code" | "output") => {
    const directory = join(absoluteRoot, folder);
    return Object.fromEntries(
      walkFiles(directory)
        .filter((file) =>
          !(folder === "output" && file.endsWith("manifest.json"))
        )
        .sort()
        .map((file) => [
          relative(absoluteRoot, file).replaceAll("\\", "/"),
          sha256File(file)
        ])
    );
  };
  return {
    inputs: hashes("input"),
    code: hashes("code"),
    artifacts: hashes("output"),
    errors: []
  };
}

export function assertNoFigureArtifacts(root: string): void {
  const forbidden = new Set([".png", ".pdf", ".svg", ".html", ".htm"]);
  for (const file of walkFiles(resolve(root))) {
    if (forbidden.has(extname(file).toLowerCase())) {
      throw new Error(`Figure artifact is forbidden: ${file}`);
    }
  }
}
