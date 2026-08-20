import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRequest } from "../server/classifier.js";
import { isModelConfigured, loadConfig } from "../server/config.js";
import type { TaskType } from "../server/types.js";

const diagnostics: Array<{ id: string; expectedTaskType: TaskType; prompt: string }> = [
  {
    id: "json-diagnostic-coding",
    expectedTaskType: "coding",
    prompt: "请用 TypeScript 实现一个带 LRU 淘汰策略的泛型缓存类，并给出复杂度分析。"
  },
  {
    id: "json-diagnostic-math",
    expectedTaskType: "math",
    prompt: "求所有满足 x² - 5x + 6 = 0 的实数 x，并写出计算步骤。"
  },
  {
    id: "json-diagnostic-reasoning",
    expectedTaskType: "reasoning",
    prompt: "甲、乙、丙三人中只有一人说真话。甲说乙说谎，乙说丙说谎，丙说甲乙都说谎。判断谁说真话并解释推理。"
  },
  {
    id: "json-diagnostic-writing",
    expectedTaskType: "writing",
    prompt: "为一家社区图书馆写一封约 500 字的年度志愿者招募邮件，语气友好但正式。"
  },
  {
    id: "json-diagnostic-translation",
    expectedTaskType: "translation",
    prompt: "把下面英文翻译成简体中文，保留专业术语：The protocol provides eventual consistency under intermittent network partitions."
  },
  {
    id: "json-diagnostic-general-qa",
    expectedTaskType: "general-qa",
    prompt: "光合作用主要发生在植物细胞的哪个结构中？请用两句话说明其作用。"
  }
];

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = loadConfig();
const router = config.models.find((model) => model.id === config.routerModelId);
if (!router?.enabled || !router.canRoute) throw new Error("Configured Router is unavailable");
if (!isModelConfigured(router)) throw new Error(`${router.apiKeyEnv} is not configured`);

const startedAt = new Date();
const runId = startedAt.toISOString().replace(/[:.]/gu, "-");
const outputDir = path.join(rootDir, "benchmarks", "router_accuracy", "diagnostics", runId);
const resultsFile = path.join(outputDir, "results.jsonl");
const summaryFile = path.join(outputDir, "summary.json");
fs.mkdirSync(outputDir, { recursive: true });

const results = [];
for (let index = 0; index < diagnostics.length; index += 1) {
  const diagnostic = diagnostics[index];
  const callStartedAt = Date.now();
  let result: Record<string, unknown>;
  try {
    const profile = await classifyRequest({
      config,
      prompt: diagnostic.prompt,
      maxOutputTokens: 512,
      autoRouter: true,
      overrides: {},
      signal: new AbortController().signal
    });
    result = {
      sequence: index + 1,
      id: diagnostic.id,
      expectedTaskType: diagnostic.expectedTaskType,
      ok: true,
      profile,
      latencyMs: Date.now() - callStartedAt
    };
  } catch (error) {
    result = {
      sequence: index + 1,
      id: diagnostic.id,
      expectedTaskType: diagnostic.expectedTaskType,
      ok: false,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error)
      },
      latencyMs: Date.now() - callStartedAt
    };
  }
  fs.appendFileSync(resultsFile, `${JSON.stringify(result)}\n`, "utf8");
  results.push(result);
  const detail = result.ok
    ? `${(result.profile as { taskType: string; difficulty: string }).taskType}/${(result.profile as { difficulty: string }).difficulty}`
    : `ERROR ${(result.error as { message: string }).message}`;
  console.log(`[${index + 1}/${diagnostics.length}] ${diagnostic.id}: ${detail}`);
}

const succeeded = results.filter((result) => result.ok);
const taskTypeMatches = succeeded.filter((result) =>
  (result.profile as { taskType: string }).taskType === result.expectedTaskType
).length;
const summary = {
  runId,
  diagnosticOnly: true,
  startedAt: startedAt.toISOString(),
  completedAt: new Date().toISOString(),
  router: { id: router.id, upstreamModel: router.upstreamModel, provider: router.provider },
  total: results.length,
  schemaSucceeded: succeeded.length,
  failed: results.length - succeeded.length,
  jsonSchemaSuccessRate: succeeded.length / results.length,
  taskTypeMatches,
  taskTypeMatchRateAll: taskTypeMatches / results.length,
  constraints: { sequential: true, retriesPerTask: 0, benchmarkResult: false }
};
fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));
console.log(`Results: ${outputDir}`);
