import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildManifest,
  readPerRequest,
  type ArtifactManifest
} from "./export.js";
import {
  CORE_METHODS,
  type CoreMethod,
  type RequestResult
} from "./types.js";

function compareHashMap(
  label: string,
  expected: Record<string, string>,
  actual: Record<string, string>
): void {
  const keys = [...new Set([
    ...Object.keys(expected),
    ...Object.keys(actual)
  ])].sort();
  for (const key of keys) {
    if (expected[key] !== actual[key]) {
      throw new Error(
        `${label} hash mismatch for ${key}: expected ` +
        `${expected[key] ?? "missing"}, received ${actual[key] ?? "missing"}`
      );
    }
  }
}

function isCoreMethod(method: RequestResult["method"]): method is CoreMethod {
  return CORE_METHODS.includes(method as CoreMethod);
}

export function validateExperiment(root: string): {
  requestRows: number;
  pairedGroups: number;
} {
  const absoluteRoot = resolve(root);
  const manifest = JSON.parse(readFileSync(
    resolve(absoluteRoot, "output", "manifest.json"),
    "utf8"
  )) as ArtifactManifest;
  const actual = buildManifest(absoluteRoot);
  compareHashMap("input", manifest.inputs, actual.inputs);
  compareHashMap("code", manifest.code, actual.code);
  compareHashMap("artifact", manifest.artifacts, actual.artifacts);

  const rows = readPerRequest(
    resolve(absoluteRoot, "output", "per-request.csv.gz")
  );
  const groups = new Map<string, RequestResult[]>();
  for (const row of rows.filter((candidate) =>
    isCoreMethod(candidate.method)
  )) {
    const key = [
      row.scenario,
      row.cohort,
      row.seed,
      row.requestId
    ].join("\0");
    groups.set(key, [...(groups.get(key) ?? []), row]);
    if (
      row.method === "full" &&
      row.postLoad !== null &&
      row.hardCapacity !== null &&
      row.postLoad >= row.hardCapacity
    ) {
      throw new Error(
        `Full selected at or beyond hard capacity: ${row.requestId}`
      );
    }
  }
  for (const [key, members] of groups) {
    const methods = new Set(members.map((row) => row.method));
    if (methods.size !== CORE_METHODS.length) {
      throw new Error(
        `Paired trace group ${key} has ${methods.size}/${CORE_METHODS.length} methods`
      );
    }
    const traces = new Set(members.map((row) => row.traceHash));
    if (traces.size !== 1) {
      throw new Error(`Paired trace mismatch for ${key}`);
    }
  }
  return {
    requestRows: rows.length,
    pairedGroups: groups.size
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = validateExperiment(root);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
