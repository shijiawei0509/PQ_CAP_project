import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";

export interface SourceSpec {
  id: string;
  source: string;
  snapshot: string;
}

export interface FrozenInput {
  id: string;
  sourcePath: string;
  sourceSha256: string;
  snapshotPath: string;
  snapshotSha256: string;
}

export function sha256File(filePath: string): string {
  return createHash("sha256")
    .update(readFileSync(filePath))
    .digest("hex");
}

export function freezeInputs(
  root: string,
  specs: readonly SourceSpec[]
): FrozenInput[] {
  return specs.map((spec) => {
    const source = resolve(spec.source);
    const destination = resolve(root, spec.snapshot);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    const sourceSha256 = sha256File(source);
    const snapshotSha256 = sha256File(destination);
    if (sourceSha256 !== snapshotSha256) {
      throw new Error(`${spec.id}: copy hash mismatch`);
    }
    return {
      id: spec.id,
      sourcePath: source,
      sourceSha256,
      snapshotPath: spec.snapshot.replaceAll("\\", "/"),
      snapshotSha256
    };
  });
}

export function verifyFrozenInputs(
  root: string,
  contract: readonly FrozenInput[]
): string[] {
  return contract.flatMap((entry) => {
    const snapshot = resolve(root, entry.snapshotPath);
    if (!existsSync(snapshot)) {
      return [`${entry.id}: snapshot missing`];
    }
    const actual = sha256File(snapshot);
    return actual === entry.snapshotSha256
      ? []
      : [
          `${entry.id}: expected ${entry.snapshotSha256}, received ${actual}`
        ];
  });
}
