import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  EXCLUDED_ROUTER_TASK_TYPES,
  ROUTER_TASK_TYPES,
  runTasksSequentially,
  summarizeRecords,
  type RouterBenchmarkTask
} from "../benchmarks/router_accuracy/real-runner.js";
import { classifyRequest } from "../server/classifier.js";
import { isModelConfigured, loadConfig } from "../server/config.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const benchmarkDir = path.join(rootDir, "benchmarks", "router_accuracy");
const validator = path.join(benchmarkDir, "validate.mjs");

const validation = spawnSync(process.execPath, [validator], { cwd: rootDir, stdio: "inherit" });
if (validation.status !== 0) throw new Error("Router benchmark dataset validation failed");

const taskTypeFlagIndex = process.argv.indexOf("--task-type");
const taskTypeFilter = taskTypeFlagIndex >= 0 ? process.argv[taskTypeFlagIndex + 1] : undefined;
if (taskTypeFlagIndex >= 0 && !ROUTER_TASK_TYPES.includes(taskTypeFilter as (typeof ROUTER_TASK_TYPES)[number])) {
  throw new Error(`Invalid --task-type: ${taskTypeFilter ?? "missing value"}`);
}

const allTasks = ROUTER_TASK_TYPES.flatMap((taskType) => {
  const file = path.join(benchmarkDir, "tasks", `${taskType}.jsonl`);
  return fs.readFileSync(file, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line) as RouterBenchmarkTask);
});
if (allTasks.length !== 54 || new Set(allTasks.map((task) => task.id)).size !== 54) {
  throw new Error(`Expected 54 unique active Router tasks, got ${allTasks.length}`);
}
const tasks = taskTypeFilter
  ? allTasks.filter((task) => task.expectedProfile.taskType === taskTypeFilter)
  : allTasks;
if (taskTypeFilter && tasks.length !== 9) {
  throw new Error(`Expected 9 ${taskTypeFilter} tasks, got ${tasks.length}`);
}

const config = loadConfig();
const routerModel = config.models.find((model) => model.id === config.routerModelId);
if (!routerModel?.enabled || !routerModel.canRoute) {
  throw new Error("Configured Router model is missing, disabled, or cannot route");
}
if (!isModelConfigured(routerModel)) {
  throw new Error(`${routerModel.apiKeyEnv} is not configured`);
}

const runStartedAt = new Date();
const runId = runStartedAt.toISOString().replace(/[:.]/gu, "-");
const runDir = path.join(benchmarkDir, "results", runId);
const predictionsFile = path.join(runDir, "predictions.jsonl");
const runFile = path.join(runDir, "run.json");
const summaryFile = path.join(runDir, "summary.json");
fs.mkdirSync(runDir, { recursive: true });

const runMetadata = {
  runId,
  dataset: "router-eval-v1",
  status: "running",
  startedAt: runStartedAt.toISOString(),
  taskCount: tasks.length,
  taskTypeFilter: taskTypeFilter ?? null,
  excludedTaskTypes: EXCLUDED_ROUTER_TASK_TYPES,
  excludedTaskCount: 9,
  router: {
    id: routerModel.id,
    name: routerModel.name,
    provider: routerModel.provider,
    baseUrl: routerModel.baseUrl,
    upstreamModel: routerModel.upstreamModel
  },
  constraints: {
    productionClassifier: "server/classifier.ts:classifyRequest",
    sequential: true,
    retriesPerTask: 0,
    sendsOnlyFixedSystemAndTaskPrompt: true,
    invokesPqCapSelection: false,
    executesTasks: false
  }
};
fs.writeFileSync(runFile, `${JSON.stringify(runMetadata, null, 2)}\n`, "utf8");

console.log(`Running ${tasks.length} Router classifications sequentially with ${routerModel.upstreamModel}.`);
const records = await runTasksSequentially(
  tasks,
  (task) => classifyRequest({
    config,
    prompt: task.prompt,
    maxOutputTokens: task.maxOutputTokens,
    autoRouter: true,
    overrides: {},
    signal: new AbortController().signal
  }),
  (record) => {
    fs.appendFileSync(predictionsFile, `${JSON.stringify(record)}\n`, "utf8");
    const outcome = record.ok
      ? `${record.profile!.taskType}/${record.profile!.difficulty}`
      : `ERROR ${record.error!.message}`;
    console.log(`[${record.sequence}/${tasks.length}] ${record.taskId}: ${outcome} (${record.latencyMs} ms)`);
  }
);

const completedAt = new Date().toISOString();
const metrics = summarizeRecords(records);
const summary = {
  runId,
  completedAt,
  taskTypeFilter: taskTypeFilter ?? null,
  excludedTaskTypes: EXCLUDED_ROUTER_TASK_TYPES,
  excludedTaskCount: 9,
  ...metrics
};
fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
fs.writeFileSync(runFile, `${JSON.stringify({ ...runMetadata, status: "completed", completedAt }, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));
console.log(`Results: ${runDir}`);
