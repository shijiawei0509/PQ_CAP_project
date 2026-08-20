import "dotenv/config";
import { classifyRequest } from "../server/classifier.js";
import { loadConfig } from "../server/config.js";
import { completeChat } from "../server/provider.js";

const config = loadConfig();
const results: Array<Record<string, unknown>> = [];

async function verifyRouter() {
  const model = config.models.find((item) => item.id === config.routerModelId);
  const startedAt = Date.now();
  if (!model) throw new Error(`Router model ${config.routerModelId} not found`);
  const profile = await classifyRequest({
    config,
    prompt: "请用严谨步骤证明勾股定理，并给出一个数值例子。",
    maxOutputTokens: 128,
    autoRouter: true,
    overrides: {},
    signal: new AbortController().signal
  });
  results.push({
    provider: "deepseek",
    model: model.upstreamModel,
    role: "automatic-router",
    ok: true,
    latencyMs: Date.now() - startedAt,
    profile
  });
}

async function verifyGlm() {
  const model = config.models.find((item) => item.id === "glm-direct");
  const startedAt = Date.now();
  if (!model) throw new Error("GLM model not found");
  const content = await completeChat(model, {
    messages: [{ role: "user", content: "只回复两个大写字母 OK" }],
    maxTokens: 16,
    temperature: 0.1,
    signal: new AbortController().signal,
    timeoutMs: 30000,
    thinking: false
  });
  results.push({
    provider: "glm",
    model: model.upstreamModel,
    role: "candidate-model",
    ok: true,
    latencyMs: Date.now() - startedAt,
    response: content.slice(0, 80)
  });
}

async function verifyDeepSeekPro() {
  const model = config.models.find((item) => item.id === "deepseek-pro-direct");
  const startedAt = Date.now();
  if (!model) throw new Error("DeepSeek Pro model not found");
  const content = await completeChat(model, {
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    maxTokens: 16,
    temperature: 0.1,
    signal: new AbortController().signal,
    timeoutMs: 30000,
    thinking: false
  });
  results.push({
    provider: "deepseek",
    model: model.upstreamModel,
    role: "candidate-model",
    ok: true,
    latencyMs: Date.now() - startedAt,
    response: content.slice(0, 80)
  });
}

for (const check of [verifyRouter, verifyDeepSeekPro, verifyGlm]) {
  try {
    await check();
  } catch (error) {
    results.push({
      ok: false,
      check: check.name,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

console.log(JSON.stringify(results, null, 2));
if (results.some((result) => !result.ok)) process.exitCode = 1;
