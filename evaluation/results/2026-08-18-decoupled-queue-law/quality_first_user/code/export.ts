import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { parseCsv } from "../../../../scripts/build-runtime-models.js";

type CsvValue = string | number | boolean | null | undefined;
type CsvRow = Record<string, CsvValue>;

function escapeCsv(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

export function csvText(rows: readonly CsvRow[], columns: readonly string[]): string {
  const lines = [
    columns.map(escapeCsv).join(","),
    ...rows.map((row) => columns.map((column) => escapeCsv(row[column])).join(","))
  ];
  return `${lines.join("\n")}\n`;
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
