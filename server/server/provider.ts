import type { ModelConfig, Usage } from "./types.js";

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
  }
}

interface ChatOptions {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxTokens: number;
  temperature: number;
  signal: AbortSignal;
  timeoutMs: number;
  jsonMode?: boolean;
  thinking?: boolean;
}

export interface StreamChunk {
  content?: string;
  reasoning?: string;
  usage?: Usage;
  upstreamModel?: string;
}

function completionUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

function requestHeaders(model: ModelConfig): Record<string, string> {
  const apiKey = process.env[model.apiKeyEnv];
  if (!apiKey) throw new ProviderError(`${model.name} 的 ${model.apiKeyEnv} 未配置`, 401);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
  if (model.provider === "openrouter") {
    headers["HTTP-Referer"] = "http://localhost:8787";
    headers["X-OpenRouter-Title"] = "PQ-CAP Router Lab";
  }
  return headers;
}

function combinedSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

async function errorFromResponse(response: Response): Promise<ProviderError> {
  const raw = await response.text();
  let message = raw || response.statusText;
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    message =
      (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ??
      parsed.message ??
      message;
  } catch {
    // Preserve the upstream text when it is not JSON.
  }
  return new ProviderError(`上游 ${response.status}: ${message}`, response.status);
}

function requestBody(model: ModelConfig, options: ChatOptions, stream: boolean) {
  return {
    model: model.upstreamModel,
    messages: options.messages,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    stream,
    ...(options.thinking === undefined
      ? {}
      : { thinking: { type: options.thinking ? "enabled" : "disabled" } }),
    ...(options.jsonMode && model.supportsJsonMode
      ? { response_format: { type: "json_object" } }
      : {})
  };
}

export async function completeChat(model: ModelConfig, options: ChatOptions): Promise<string> {
  const response = await fetch(completionUrl(model.baseUrl), {
    method: "POST",
    headers: requestHeaders(model),
    body: JSON.stringify(requestBody(model, options, false)),
    signal: combinedSignal(options.signal, options.timeoutMs)
  });
  if (!response.ok) throw await errorFromResponse(response);
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  if (payload.error) throw new ProviderError(payload.error.message ?? "上游返回错误");
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new ProviderError("Router 模型未返回文本内容");
  return content;
}

function normalizeUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const promptTokens = Number(usage.prompt_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? promptTokens + completionTokens);
  if (!promptTokens && !completionTokens && !totalTokens) return undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cost: typeof usage.cost === "number" ? usage.cost : undefined,
    estimated: false
  };
}

export async function* streamChat(
  model: ModelConfig,
  options: ChatOptions
): AsyncGenerator<StreamChunk> {
  const response = await fetch(completionUrl(model.baseUrl), {
    method: "POST",
    headers: requestHeaders(model),
    body: JSON.stringify(requestBody(model, options, true)),
    signal: combinedSignal(options.signal, options.timeoutMs)
  });
  if (!response.ok) throw await errorFromResponse(response);
  if (!response.body) throw new ProviderError("上游响应没有可读取的流");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (payload.error && typeof payload.error === "object") {
        const error = payload.error as { message?: string; code?: number };
        throw new ProviderError(error.message ?? "流式响应中断", error.code);
      }

      const choices = payload.choices as
        | Array<{ delta?: { content?: string; reasoning_content?: string } }>
        | undefined;
      const delta = choices?.[0]?.delta;
      const usage = normalizeUsage(payload.usage);
      const chunk: StreamChunk = {
        content: delta?.content,
        reasoning: delta?.reasoning_content,
        usage,
        upstreamModel: typeof payload.model === "string" ? payload.model : undefined
      };
      if (chunk.content || chunk.reasoning || chunk.usage) yield chunk;
    }
    if (done) break;
  }
}
