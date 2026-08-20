import "dotenv/config";
import { loadConfig } from "../server/config.js";
import { completeChat } from "../server/provider.js";

const modelIds = [
  "glm-direct",
  "glm-5.1-direct",
  "glm-5-direct",
  "glm-5-turbo-direct",
  "glm-4.7-direct",
  "glm-4.6-direct"
] as const;

const config = loadConfig();
const results: Array<Record<string, unknown>> = [];

for (const modelId of modelIds) {
  const model = config.models.find((candidate) => candidate.id === modelId);
  const startedAt = Date.now();
  if (!model) {
    results.push({ modelId, ok: false, error: "Model configuration not found" });
    continue;
  }

  try {
    const content = await completeChat(model, {
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      maxTokens: 256,
      temperature: 0.1,
      signal: new AbortController().signal,
      timeoutMs: 60_000,
      thinking: modelId === "glm-4.7-direct" ? undefined : false
    });
    results.push({
      modelId,
      upstreamModel: model.upstreamModel,
      ok: true,
      latencyMs: Date.now() - startedAt,
      response: content.slice(0, 80)
    });
  } catch (error) {
    results.push({
      modelId,
      upstreamModel: model.upstreamModel,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

console.log(JSON.stringify(results, null, 2));
if (results.some((result) => !result.ok)) process.exitCode = 1;
