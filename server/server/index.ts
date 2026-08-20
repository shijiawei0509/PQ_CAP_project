import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Response } from "express";
import { z } from "zod";
import { classifyRequest } from "./classifier.js";
import { isModelConfigured, loadConfig, publicModel } from "./config.js";
import { estimateTokens, routeRequest } from "./pqcap.js";
import { ProviderError, streamChat } from "./provider.js";
import { RuntimeState } from "./state.js";
import { TASK_TYPES, type RequestLog, type Usage } from "./types.js";

const config = loadConfig();
const state = new RuntimeState(config.models);
const app = express();
app.use(express.json({ limit: "1mb" }));

const chatRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(200000),
  maxOutputTokens: z.number().int().min(16).max(32768).default(1024),
  temperature: z.number().min(0).max(2).default(0.7),
  autoRouter: z.boolean().default(true),
  overrides: z.object({
    taskType: z.enum(TASK_TYPES).optional(),
    difficulty: z.enum(["easy", "medium", "hard"]).optional(),
    requirements: z.object({
      minContextTokens: z.number().int().positive().optional(),
      needsVision: z.boolean().optional(),
      needsTools: z.boolean().optional(),
      needsJsonOutput: z.boolean().optional(),
      contextPattern: z.enum(["single", "cross-document", "cross-section"]).optional()
    }).optional()
  }).default({}),
  preference: z.object({
    mode: z.enum(["price", "quality", "fixed"]),
    fixedModelId: z.string().optional(),
    fixedFallback: z.enum(["same-quality", "unavailable"]).optional()
  }).refine((preference) => preference.mode !== "fixed" || Boolean(preference.fixedModelId), {
    message: "固定模型模式必须选择模型"
  })
});

function sendEvent(response: Response, event: string, data: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function currentLoadsObject(): Record<string, number> {
  return Object.fromEntries(state.snapshotLoads());
}

app.get("/api/bootstrap", (_request, response) => {
  const loads = state.snapshotLoads();
  response.json({
    routerModelId: config.routerModelId,
    routerConfigured: Boolean(
      config.models.find((model) => model.id === config.routerModelId && isModelConfigured(model))
    ),
    models: config.models.map((model) => publicModel(model, loads.get(model.id) ?? 0)),
    logs: state.listLogs()
  });
});

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, configuredModels: config.models.filter(isModelConfigured).length });
});

app.post("/api/chat", async (request, response) => {
  const parsed = chatRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.issues.map((issue) => issue.message).join("；") });
    return;
  }

  response.status(200);
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();

  const body = parsed.data;
  const id = crypto.randomUUID();
  const startedAt = Date.now();
  const controller = new AbortController();
  let connectionFinished = false;
  let reservedModelId: string | undefined;
  let reservedAmount = 0;
  let responseText = "";
  let usage: Usage | undefined;
  let ttftMs: number | undefined;

  response.on("close", () => {
    if (!connectionFinished) controller.abort();
  });

  const log: RequestLog = {
    id,
    createdAt: new Date().toISOString(),
    promptPreview: body.prompt.slice(0, 120),
    preference: body.preference,
    status: "running"
  };
  state.addLog(log);
  sendEvent(response, "request", { id, status: "classifying" });

  try {
    const profile = await classifyRequest({
      config,
      prompt: body.prompt,
      maxOutputTokens: body.maxOutputTokens,
      autoRouter: body.autoRouter,
      overrides: body.overrides,
      signal: controller.signal
    });
    state.updateLog(id, { profile });
    sendEvent(response, "profile", profile);

    const decision = routeRequest({
      models: config.models,
      loads: state.snapshotLoads(),
      profile,
      preference: body.preference,
      prompt: body.prompt,
      maxOutputTokens: body.maxOutputTokens
    });
    const selectedModel = config.models.find((model) => model.id === decision.selectedModelId);
    const selectedCandidate = decision.candidates.find((candidate) => candidate.selected);
    if (!selectedModel || !selectedCandidate || selectedCandidate.quotePerMillion === null) {
      throw new Error("选中模型或锁定报价不存在");
    }

    reservedAmount = selectedCandidate.reservedLoad;
    if (!state.reserve(selectedModel, reservedAmount)) {
      throw new Error("模型负载在预留前发生变化，请重试");
    }
    reservedModelId = selectedModel.id;
    state.updateLog(id, { selectedModelId: selectedModel.id, decision });
    sendEvent(response, "decision", decision);
    sendEvent(response, "loads", currentLoadsObject());
    sendEvent(response, "request", { id, status: "streaming", selectedModelId: selectedModel.id });

    for await (const chunk of streamChat(selectedModel, {
      messages: [{ role: "user", content: body.prompt }],
      maxTokens: body.maxOutputTokens,
      temperature: body.temperature,
      signal: controller.signal,
      timeoutMs: config.requestTimeoutMs
    })) {
      if ((chunk.content || chunk.reasoning) && ttftMs === undefined) {
        ttftMs = Date.now() - startedAt;
      }
      if (chunk.reasoning) sendEvent(response, "reasoning", { text: chunk.reasoning });
      if (chunk.content) {
        responseText += chunk.content;
        sendEvent(response, "delta", { text: chunk.content });
      }
      if (chunk.usage) usage = chunk.usage;
    }

    if (!usage) {
      const promptTokens = decision.inputTokensEstimated;
      const completionTokens = estimateTokens(responseText);
      usage = {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        estimated: true
      };
    }

    const configuredCost =
      selectedModel.inputPricePerMillion !== null && selectedModel.outputPricePerMillion !== null
        ? (usage.promptTokens * selectedModel.inputPricePerMillion +
            usage.completionTokens * selectedModel.outputPricePerMillion) /
          1_000_000
        : undefined;
    const upstreamCost = usage.cost ?? configuredCost;
    const lockedPayment =
      ((usage.promptTokens + selectedModel.eta * usage.completionTokens) *
        selectedCandidate.quotePerMillion) /
      1_000_000;
    const totalLatencyMs = Date.now() - startedAt;

    state.updateLog(id, {
      status: "completed",
      ttftMs,
      totalLatencyMs,
      usage,
      upstreamCost,
      lockedPayment,
      responsePreview: responseText.slice(0, 240)
    });
    sendEvent(response, "complete", {
      id,
      usage,
      ttftMs,
      totalLatencyMs,
      upstreamCost,
      lockedPayment
    });
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const message =
      error instanceof ProviderError || error instanceof Error ? error.message : "未知错误";
    state.updateLog(id, {
      status: cancelled ? "cancelled" : "failed",
      totalLatencyMs: Date.now() - startedAt,
      responsePreview: responseText.slice(0, 240),
      error: cancelled ? "请求已取消" : message
    });
    sendEvent(response, "error", {
      message: cancelled ? "请求已取消" : message,
      status: error instanceof ProviderError ? error.status : undefined
    });
  } finally {
    if (reservedModelId) state.release(reservedModelId, reservedAmount);
    sendEvent(response, "loads", currentLoadsObject());
    connectionFinished = true;
    response.end();
  }
});

const port = Number(process.env.PORT ?? 8787);
const rootDir = path.resolve(process.cwd());

async function start() {
  if (process.env.NODE_ENV === "production" && fs.existsSync(path.join(rootDir, "dist"))) {
    app.use(express.static(path.join(rootDir, "dist")));
    app.get("*path", (_request, response) => response.sendFile(path.join(rootDir, "dist", "index.html")));
  } else {
    const { createServer } = await import("vite");
    const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  }

  app.listen(port, () => {
    console.log(`PQ-CAP Router Lab running at http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
