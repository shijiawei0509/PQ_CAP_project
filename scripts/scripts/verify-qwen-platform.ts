import "dotenv/config";
import { loadConfig } from "../server/config.js";
import { completeChat, streamChat } from "../server/provider.js";

const MODEL_IDS = [
  "qwen-platform:kimi-k2.7-code",
  "qwen-platform:qwen3.7-plus"
] as const;

const config = loadConfig();
const results: Array<Record<string, unknown>> = [];

for (const modelId of MODEL_IDS) {
  const model = config.models.find((candidate) => candidate.id === modelId);
  if (!model) {
    results.push({ modelId, ok: false, error: "model not found in runtime configuration" });
    continue;
  }

  const nonStreamStartedAt = Date.now();
  try {
    const content = await completeChat(model, {
      messages: [{ role: "user", content: "Reply with exactly OK" }],
      maxTokens: 16,
      temperature: 0,
      signal: new AbortController().signal,
      timeoutMs: 30_000
    });
    results.push({
      modelId,
      upstreamModel: model.upstreamModel,
      mode: "non-stream",
      ok: true,
      latencyMs: Date.now() - nonStreamStartedAt,
      response: content.slice(0, 80)
    });
  } catch (error) {
    results.push({
      modelId,
      upstreamModel: model.upstreamModel,
      mode: "non-stream",
      ok: false,
      latencyMs: Date.now() - nonStreamStartedAt,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  const streamStartedAt = Date.now();
  try {
    let content = "";
    let reasoning = "";
    for await (const chunk of streamChat(model, {
      messages: [{ role: "user", content: "Reply with exactly OK" }],
      maxTokens: 16,
      temperature: 0,
      signal: new AbortController().signal,
      timeoutMs: 30_000
    })) {
      content += chunk.content ?? "";
      reasoning += chunk.reasoning ?? "";
    }
    results.push({
      modelId,
      upstreamModel: model.upstreamModel,
      mode: "stream",
      ok: Boolean(content || reasoning),
      latencyMs: Date.now() - streamStartedAt,
      response: content.slice(0, 80),
      reasoningPreview: reasoning.slice(0, 80)
    });
  } catch (error) {
    results.push({
      modelId,
      upstreamModel: model.upstreamModel,
      mode: "stream",
      ok: false,
      latencyMs: Date.now() - streamStartedAt,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

console.log(JSON.stringify(results, null, 2));
if (results.some((result) => !result.ok)) process.exitCode = 1;

