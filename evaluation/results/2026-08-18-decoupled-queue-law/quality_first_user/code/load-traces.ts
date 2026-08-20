import { TASK_TYPES, type TaskType } from "../../../../server/types.js";
import { eligibleModels } from "./model-profile.js";
import type { ExperimentModel, LoadClass } from "./types.js";

const LOAD_CLASSES: readonly LoadClass[] = ["low", "near", "congested"];

export type LoadAssignments = Record<number, Record<string, LoadClass>>;

export function anchorLoad(model: ExperimentModel, loadClass: LoadClass): number {
  if (loadClass === "low") return 0.4 * model.normalCapacity;
  if (loadClass === "near") return 0.9 * model.normalCapacity;
  return model.normalCapacity +
    0.4 * (model.hardCapacity - model.normalCapacity);
}

function satisfiesTaskCoverage(
  assignment: Readonly<Record<string, LoadClass>>,
  eligibleByTask: Readonly<Record<TaskType, string[]>>,
  allowPartial: boolean
): boolean {
  for (const taskType of TASK_TYPES) {
    const ids = eligibleByTask[taskType];
    const assigned = ids.flatMap((id) => assignment[id] ? [assignment[id]] : []);
    const missingClassCount = LOAD_CLASSES.filter(
      (loadClass) => !assigned.includes(loadClass)
    ).length;
    const unassignedCount = ids.length - assigned.length;
    if (missingClassCount > unassignedCount) return false;
    if (!allowPartial && missingClassCount > 0) return false;
  }
  return true;
}

function assignmentForSeed(
  models: readonly ExperimentModel[],
  eligibleByTask: Readonly<Record<TaskType, string[]>>,
  seedIndex: number
): Record<string, LoadClass> {
  const assignment: Record<string, LoadClass> = {};
  const threeModelGroups = new Map<string, string[]>();
  for (const ids of Object.values(eligibleByTask)) {
    if (ids.length === 3) threeModelGroups.set(ids.join("\u0000"), ids);
  }
  for (const ids of threeModelGroups.values()) {
    ids.forEach((id, modelIndex) => {
      const loadClass = LOAD_CLASSES[(modelIndex + seedIndex) % LOAD_CLASSES.length];
      if (assignment[id] && assignment[id] !== loadClass) {
        throw new Error(`${id}: incompatible three-model load rotations`);
      }
      assignment[id] = loadClass;
    });
  }

  const relevantIds = [...new Set(Object.values(eligibleByTask).flat())]
    .filter((id) => !assignment[id])
    .sort();
  const search = (index: number): boolean => {
    if (index === relevantIds.length) {
      return satisfiesTaskCoverage(assignment, eligibleByTask, false);
    }
    const id = relevantIds[index];
    const modelIndex = models.findIndex((model) => model.id === id);
    const preferred = LOAD_CLASSES.map(
      (_, offset) => LOAD_CLASSES[(modelIndex + seedIndex + offset) % LOAD_CLASSES.length]
    );
    for (const loadClass of preferred) {
      assignment[id] = loadClass;
      if (satisfiesTaskCoverage(assignment, eligibleByTask, true) && search(index + 1)) {
        return true;
      }
    }
    delete assignment[id];
    return false;
  };
  if (!search(0)) throw new Error(`No valid load assignment for seed index ${seedIndex}`);

  models.forEach((model, modelIndex) => {
    assignment[model.id] ??=
      LOAD_CLASSES[(modelIndex + seedIndex) % LOAD_CLASSES.length];
  });
  return assignment;
}

export function buildLoadAssignments(
  models: readonly ExperimentModel[],
  thresholds: Readonly<Record<TaskType, number>>,
  seeds: readonly number[]
): LoadAssignments {
  const eligibleByTask = Object.fromEntries(TASK_TYPES.map((taskType) => [
    taskType,
    eligibleModels(models, taskType, thresholds).map((model) => model.id)
  ])) as Record<TaskType, string[]>;
  for (const [taskType, ids] of Object.entries(eligibleByTask)) {
    if (ids.length < 3) throw new Error(`${taskType}: fewer than three eligible models`);
  }
  return Object.fromEntries(seeds.map((seed, seedIndex) => [
    seed,
    assignmentForSeed(models, eligibleByTask, seedIndex)
  ]));
}
