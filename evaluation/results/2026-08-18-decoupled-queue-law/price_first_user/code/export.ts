import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { parseCsv } from "../../../../../../scripts/build-runtime-models.js";

export type CsvValue = string | number | boolean | null | undefined;
export type CsvRow = Record<string, CsvValue>;

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
  return `${[
    columns.map(escapeCsv).join(","),
    ...rows.map((row) => columns.map((column) => escapeCsv(row[column])).join(","))
  ].join("\n")}\n`;
}

export function writeGzipCsv(
  filePath: string,
  rows: readonly CsvRow[],
  columns: readonly string[]
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, gzipSync(Buffer.from(csvText(rows, columns), "utf8")));
}

export function readGzipCsv(filePath: string): Record<string, string>[] {
  return parseCsv(gunzipSync(fs.readFileSync(filePath)).toString("utf8"));
}

export function writeCsv(
  filePath: string,
  rows: readonly CsvRow[],
  columns: readonly string[]
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, csvText(rows, columns), "utf8");
}

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function assertNoFigureArtifacts(root: string): void {
  const forbidden = new Set([".png", ".pdf", ".svg", ".html", ".htm"]);
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (forbidden.has(path.extname(entry.name).toLowerCase())) {
        throw new Error(`Figure artifact is forbidden: ${fullPath}`);
      }
    }
  };
  visit(root);
}

export function publishDirectories(
  experimentRoot: string,
  stagingRoot: string,
  validate: (stagingRoot: string) => void
): void {
  const resolvedExperiment = path.resolve(experimentRoot);
  const resolvedStaging = path.resolve(stagingRoot);
  if (
    resolvedStaging === resolvedExperiment ||
    !resolvedStaging.startsWith(`${resolvedExperiment}${path.sep}`)
  ) {
    throw new Error("Staging directory must be inside the experiment root");
  }
  validate(resolvedStaging);
  const nonce = `${process.pid}-${Date.now()}`;
  const moved: Array<{ target: string; backup: string }> = [];
  const installed: string[] = [];
  try {
    for (const name of ["input", "output"] as const) {
      const source = path.join(resolvedStaging, name);
      const target = path.join(resolvedExperiment, name);
      const backup = path.join(resolvedExperiment, `.${name}.backup-${nonce}`);
      if (!fs.existsSync(source)) throw new Error(`Missing staged ${name}`);
      if (fs.existsSync(target)) {
        fs.renameSync(target, backup);
        moved.push({ target, backup });
      }
      fs.renameSync(source, target);
      installed.push(target);
    }
  } catch (error) {
    for (const target of installed.reverse()) {
      if (fs.existsSync(target)) fs.renameSync(target, `${target}.failed-${nonce}`);
    }
    for (const { target, backup } of moved.reverse()) {
      if (fs.existsSync(backup)) fs.renameSync(backup, target);
    }
    throw error;
  }
  for (const { backup } of moved) {
    fs.rmSync(backup, { recursive: true, force: true });
  }
}
