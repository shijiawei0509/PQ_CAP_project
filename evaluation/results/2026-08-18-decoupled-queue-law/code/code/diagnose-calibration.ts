import { buildLoadAssignments } from "./load-traces.js";
import { freezeQualityThresholds, loadFrozenProfile } from "./model-profile.js";
import { createBalancedReferenceRouter } from "./routers.js";
import { buildScenarioTrace, scenarioDefinitions } from "./scenarios.js";
import { simulate } from "./simulator.js";
import { SEEDS } from "./types.js";

const { models, tasks } = loadFrozenProfile();
const thresholds = freezeQualityThresholds(models);
const assignments = buildLoadAssignments(models, thresholds, SEEDS);

for (const rate of [0.0001, 0.001, 0.01, 0.1, 1, 10]) {
  const observations = SEEDS.map((seed) => {
    const scenario = scenarioDefinitions(rate, seed).S1;
    const result = simulate({
      scenario,
      requests: buildScenarioTrace({ definition: scenario, tasks, models }),
      models,
      thresholds,
      loadClasses: assignments[seed],
      router: createBalancedReferenceRouter(),
      requestTimeoutMs: 300_000
    });
    return {
      seed,
      completed: result.requests.filter((row) => row.status === "completed").length,
      rejected: result.capacityRejectedCount,
      mixed: result.mixedStateShare
    };
  });
  process.stdout.write(`${JSON.stringify({ rate, observations })}\n`);
}

const diagnosticSeed = 23;
const diagnosticScenario = scenarioDefinitions(0.0001, diagnosticSeed).S1;
const diagnosticResult = simulate({
  scenario: diagnosticScenario,
  requests: buildScenarioTrace({ definition: diagnosticScenario, tasks, models }),
  models,
  thresholds,
  loadClasses: assignments[diagnosticSeed],
  router: createBalancedReferenceRouter(),
  requestTimeoutMs: 300_000
});
const grouped = new Map<string, number>();
for (const row of diagnosticResult.requests) {
  const key = `${row.status}|${row.taskType}|${row.modelId ?? "none"}`;
  grouped.set(key, (grouped.get(key) ?? 0) + 1);
}
process.stdout.write(`${JSON.stringify({
  diagnosticSeed,
  largestGroups: [...grouped.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 20)
})}\n`);

const workloadDiagnostics = [];
for (const taskType of ["coding", "math", "reasoning", "writing", "translation", "general-qa"] as const) {
  const taskRows = tasks.filter((task) => task.taskType === taskType);
  for (const model of models.filter((candidate) =>
    candidate.quality[taskType] >= thresholds[taskType]
  )) {
    const ratios = taskRows.map((task) =>
      (task.promptTokens + model.eta * task.maxOutputTokens) /
      (model.hardCapacity - model.normalCapacity)
    ).sort((left, right) => left - right);
    workloadDiagnostics.push({
      taskType,
      modelId: model.id,
      baseTtftMs: model.baseTtftMs,
      gap: model.hardCapacity - model.normalCapacity,
      minimumRatio: ratios[0],
      medianRatio: ratios[Math.floor(ratios.length / 2)],
      maximumRatio: ratios.at(-1)
    });
  }
}
process.stdout.write(`${JSON.stringify({ workloadDiagnostics })}\n`);
