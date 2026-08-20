import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  verifyFrozenInputs,
  type FrozenInput
} from "./hash-contract.js";
import type {
  ExperimentModel,
  ExperimentTask,
  PreferenceMethod,
  TaskType
} from "./types.js";

export interface PreferenceConfig {
  routeNonFixedAs: "cohort" | "quality-first";
  dynamicCap: boolean;
  hardCapAdmission: boolean;
}

export const PREFERENCE_CONFIGS: Readonly<
  Record<PreferenceMethod, PreferenceConfig>
> = {
  "preference-aware-full": {
    routeNonFixedAs: "cohort",
    dynamicCap: true,
    hardCapAdmission: true
  },
  "single-policy-pq-cap": {
    routeNonFixedAs: "quality-first",
    dynamicCap: true,
    hardCapAdmission: true
  },
  "preference-aware-static-router": {
    routeNonFixedAs: "cohort",
    dynamicCap: false,
    hardCapAdmission: true
  }
};

export interface RegularScenario {
  models: ExperimentModel[];
  tasks: ExperimentTask[];
  thresholds: Record<TaskType, number>;
  loadAssignments: unknown;
  scenarioManifest: Record<string, unknown>;
  sourcePaths: string[];
}

function contractEntry(
  contract: readonly FrozenInput[],
  acceptedIds: readonly string[]
): FrozenInput {
  const entry = contract.find((candidate) =>
    acceptedIds.includes(candidate.id)
  );
  if (!entry) {
    throw new Error(`Missing frozen input: ${acceptedIds.join(" or ")}`);
  }
  return entry;
}

function readJson<T>(
  root: string,
  contract: readonly FrozenInput[],
  acceptedIds: readonly string[]
): T {
  const entry = contractEntry(contract, acceptedIds);
  return JSON.parse(
    readFileSync(resolve(root, entry.snapshotPath), "utf8")
  ) as T;
}

export function loadRegularScenario(
  root: string,
  contract: readonly FrozenInput[]
): RegularScenario {
  const errors = verifyFrozenInputs(root, contract);
  if (errors.length > 0) {
    throw new Error(`Frozen input verification failed: ${errors.join("; ")}`);
  }
  return {
    models: readJson(root, contract, ["models", "model-snapshot"]),
    tasks: readJson(root, contract, ["tasks", "task-snapshot"]),
    thresholds: readJson(root, contract, [
      "thresholds",
      "quality-thresholds"
    ]),
    loadAssignments: readJson(root, contract, [
      "assignments",
      "load-assignments"
    ]),
    scenarioManifest: readJson(root, contract, [
      "manifest",
      "scenario-manifest"
    ]),
    sourcePaths: contract.map((entry) =>
      entry.snapshotPath.replaceAll("\\", "/")
    )
  };
}
