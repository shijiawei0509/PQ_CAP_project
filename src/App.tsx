import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BootstrapData,
  CandidateDecision,
  Difficulty,
  PreferenceMode,
  PublicModel,
  RequestProfile,
  ResultMetrics,
  RouteDecision,
  TaskType
} from "./types";

const taskLabels: Record<TaskType, string> = {
  coding: "代码",
  math: "数学",
  reasoning: "推理",
  writing: "写作",
  translation: "翻译",
  "general-qa": "通用问答"
};

const difficultyLabels: Record<Difficulty, string> = {
  easy: "简单",
  medium: "中等",
  hard: "困难"
};

interface SavedPreference {
  mode: PreferenceMode;
  fixedModelId?: string;
  fixedFallback: "same-quality" | "unavailable";
}

const defaultPreference: SavedPreference = {
  mode: "quality",
  fixedFallback: "same-quality"
};

function loadPreference(): SavedPreference {
  try {
    const saved = localStorage.getItem("pqcap-preference");
    return saved ? { ...defaultPreference, ...JSON.parse(saved) } : defaultPreference;
  } catch {
    return defaultPreference;
  }
}

function formatMoney(value?: number): string {
  if (value === undefined) return "—";
  return value < 0.01 ? `$${value.toFixed(6)}` : `$${value.toFixed(4)}`;
}

function formatLatency(value?: number): string {
  if (value === undefined) return "—";
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s`;
}

function parseSseBlock(block: string): { event: string; data: unknown } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  return { event, data: JSON.parse(data.join("\n")) };
}

function LoadBar({ value, normal, hard }: { value: number; normal: number; hard: number }) {
  const width = Math.min(100, (value / hard) * 100);
  const normalMark = (normal / hard) * 100;
  const congested = value > normal;
  return (
    <div className="load-track" aria-label={`负载 ${Math.round(value)} / ${hard}`}>
      <span className="normal-mark" style={{ left: `${normalMark}%` }} />
      <span className={`load-fill ${congested ? "congested" : ""}`} style={{ width: `${width}%` }} />
    </div>
  );
}

function ModelRow({
  model,
  candidate,
  liveLoad
}: {
  model: PublicModel;
  candidate?: CandidateDecision;
  liveLoad?: number;
}) {
  const load = liveLoad ?? candidate?.currentLoad ?? model.currentLoad;
  const postLoad = candidate?.postLoad ?? load;
  const state = candidate?.selected
    ? "selected"
    : candidate && !candidate.eligible
      ? "rejected"
      : "idle";

  return (
    <div className={`model-row ${state}`}>
      <div className="model-identity">
        <span className={`provider-dot ${model.configured ? "online" : ""}`} />
        <div>
          <strong>{model.name}</strong>
          <small>{model.provider === "openrouter" ? "OPENROUTER" : "DIRECT API"}</small>
        </div>
      </div>
      <div className="model-quality">
        <small>质量</small>
        <strong>{candidate ? candidate.quality.toFixed(3) : "—"}</strong>
      </div>
      <div className="model-load">
        <div className="load-caption">
          <span>{Math.round(load).toLocaleString()}</span>
          {candidate && <span>→ {Math.round(postLoad).toLocaleString()}</span>}
        </div>
        <LoadBar value={postLoad} normal={model.normalCapacity} hard={model.hardCapacity} />
      </div>
      <div className="model-price">
        <small>请求报价 / 1M</small>
        <strong>{candidate?.quotePerMillion == null ? "—" : `$${candidate.quotePerMillion.toFixed(3)}`}</strong>
      </div>
      <div className="model-verdict">
        <span>{candidate?.selected ? "已选择" : candidate ? (candidate.eligible ? "候选" : "已过滤") : "待分析"}</span>
        <small>{candidate?.reasons[0] ?? (model.configured ? "连接已配置" : "缺少 API Key")}</small>
      </div>
    </div>
  );
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [prompt, setPrompt] = useState("请比较动态拥塞定价与固定价格在多模型路由中的差异，并给出一个具体例子。");
  const [maxOutputTokens, setMaxOutputTokens] = useState(1024);
  const [temperature, setTemperature] = useState(0.7);
  const [autoRouter, setAutoRouter] = useState(true);
  const [taskOverride, setTaskOverride] = useState<TaskType | "">("");
  const [difficultyOverride, setDifficultyOverride] = useState<Difficulty | "">("");
  const [preference, setPreference] = useState<SavedPreference>(loadPreference);
  const [status, setStatus] = useState<"idle" | "classifying" | "streaming" | "completed" | "failed">("idle");
  const [profile, setProfile] = useState<RequestProfile | null>(null);
  const [decision, setDecision] = useState<RouteDecision | null>(null);
  const [answer, setAnswer] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [metrics, setMetrics] = useState<ResultMetrics | null>(null);
  const [error, setError] = useState("");
  const [liveLoads, setLiveLoads] = useState<Record<string, number>>({});
  const abortRef = useRef<AbortController | null>(null);
  const answerRef = useRef<HTMLDivElement | null>(null);

  const refresh = async () => {
    const response = await fetch("/api/bootstrap");
    if (!response.ok) throw new Error("无法读取服务状态");
    const data = (await response.json()) as BootstrapData;
    setBootstrap(data);
    setLiveLoads(Object.fromEntries(data.models.map((model) => [model.id, model.currentLoad])));
    setPreference((current) => ({
      ...current,
      fixedModelId: current.fixedModelId ?? data.models[0]?.id
    }));
  };

  useEffect(() => {
    refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "服务连接失败"));
  }, []);

  useEffect(() => {
    localStorage.setItem("pqcap-preference", JSON.stringify(preference));
  }, [preference]);

  useEffect(() => {
    answerRef.current?.scrollTo({ top: answerRef.current.scrollHeight, behavior: "smooth" });
  }, [answer, reasoning]);

  const selectedModel = useMemo(
    () => bootstrap?.models.find((model) => model.id === decision?.selectedModelId),
    [bootstrap, decision]
  );

  const runRequest = async () => {
    if (!prompt.trim() || status === "classifying" || status === "streaming") return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("classifying");
    setProfile(null);
    setDecision(null);
    setAnswer("");
    setReasoning("");
    setMetrics(null);
    setError("");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          maxOutputTokens,
          temperature,
          autoRouter,
          overrides: {
            ...(taskOverride ? { taskType: taskOverride } : {}),
            ...(difficultyOverride ? { difficulty: difficultyOverride } : {})
          },
          preference
        }),
        signal: controller.signal
      });
      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `请求失败：${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const parsed = parseSseBlock(block);
          if (!parsed) continue;
          const data = parsed.data as Record<string, unknown>;
          if (parsed.event === "profile") setProfile(data as unknown as RequestProfile);
          if (parsed.event === "decision") setDecision(data as unknown as RouteDecision);
          if (parsed.event === "loads") setLiveLoads(data as Record<string, number>);
          if (parsed.event === "delta") setAnswer((current) => current + String(data.text ?? ""));
          if (parsed.event === "reasoning") setReasoning((current) => current + String(data.text ?? ""));
          if (parsed.event === "request" && data.status === "streaming") setStatus("streaming");
          if (parsed.event === "complete") {
            setMetrics(data as unknown as ResultMetrics);
            setStatus("completed");
          }
          if (parsed.event === "error") {
            setError(String(data.message ?? "请求失败"));
            setStatus("failed");
          }
        }
        if (done) break;
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        setError("请求已取消");
      } else {
        setError(cause instanceof Error ? cause.message : "请求失败");
      }
      setStatus("failed");
    } finally {
      abortRef.current = null;
      await refresh().catch(() => undefined);
    }
  };

  const stopRequest = () => abortRef.current?.abort();
  const isRunning = status === "classifying" || status === "streaming";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">PQ</span>
          <span className="brand-divider">/</span>
          <span>CAP</span>
          <small>ROUTER LAB</small>
        </div>
        <div className="system-status">
          <span className={`status-light ${bootstrap?.routerConfigured ? "online" : ""}`} />
          <span>{bootstrap?.routerConfigured ? "Router ready" : "Router key missing"}</span>
          <span className="status-separator" />
          <span>{bootstrap?.models.filter((model) => model.configured).length ?? 0} providers online</span>
        </div>
      </header>

      <main className="workspace">
        <section className="request-panel panel">
          <div className="section-heading">
            <span>01</span>
            <div><h1>请求配置</h1><p>声明偏好，Router 自动识别任务画像。</p></div>
          </div>

          <label className="field prompt-field">
            <span>Prompt</span>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={8} />
            <small>{prompt.length.toLocaleString()} chars</small>
          </label>

          <div className="preference-block">
            <span className="field-label">持久偏好</span>
            <div className="segmented">
              {(["price", "quality", "fixed"] as PreferenceMode[]).map((mode) => (
                <button
                  key={mode}
                  className={preference.mode === mode ? "active" : ""}
                  onClick={() => setPreference((current) => ({ ...current, mode }))}
                  type="button"
                >
                  {mode === "price" ? "价格优先" : mode === "quality" ? "质量优先" : "固定模型"}
                </button>
              ))}
            </div>
          </div>

          {preference.mode === "fixed" && (
            <div className="fixed-options reveal">
              <label className="field">
                <span>锁定模型</span>
                <select
                  value={preference.fixedModelId}
                  onChange={(event) => setPreference((current) => ({ ...current, fixedModelId: event.target.value }))}
                >
                  {bootstrap?.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
              </label>
              <label className="field">
                <span>不可用时</span>
                <select
                  value={preference.fixedFallback}
                  onChange={(event) => setPreference((current) => ({ ...current, fixedFallback: event.target.value as SavedPreference["fixedFallback"] }))}
                >
                  <option value="same-quality">同质量最低报价回退</option>
                  <option value="unavailable">直接返回不可用</option>
                </select>
              </label>
            </div>
          )}

          <div className="router-toggle">
            <div><strong>自动请求识别</strong><small>使用固定低成本 Router 生成 c / d / g</small></div>
            <button
              type="button"
              className={`switch ${autoRouter ? "on" : ""}`}
              aria-pressed={autoRouter}
              onClick={() => setAutoRouter((value) => !value)}
            ><span /></button>
          </div>

          <div className="form-grid">
            <label className="field">
              <span>{autoRouter ? "任务类型覆盖" : "任务类型"}</span>
              <select value={taskOverride} onChange={(event) => setTaskOverride(event.target.value as TaskType | "")}>
                {autoRouter && <option value="">自动</option>}
                {(Object.keys(taskLabels) as TaskType[]).map((task) => <option key={task} value={task}>{taskLabels[task]}</option>)}
              </select>
            </label>
            <label className="field">
              <span>{autoRouter ? "难度覆盖" : "任务难度"}</span>
              <select value={difficultyOverride} onChange={(event) => setDifficultyOverride(event.target.value as Difficulty | "")}>
                {autoRouter && <option value="">自动</option>}
                {(Object.keys(difficultyLabels) as Difficulty[]).map((difficulty) => <option key={difficulty} value={difficulty}>{difficultyLabels[difficulty]}</option>)}
              </select>
            </label>
            <label className="field">
              <span>最大输出</span>
              <input type="number" min={16} max={32768} value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(Number(event.target.value))} />
            </label>
            <label className="field">
              <span>Temperature</span>
              <input type="number" min={0} max={2} step={0.1} value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} />
            </label>
          </div>

          <button className={`run-button ${isRunning ? "running" : ""}`} type="button" onClick={isRunning ? stopRequest : runRequest}>
            <span>{isRunning ? "停止请求" : "执行自动路由"}</span>
            <span className="run-arrow">{isRunning ? "■" : "↗"}</span>
          </button>
          {error && <div className="inline-error">{error}</div>}
        </section>

        <section className="routing-panel panel">
          <div className="section-heading">
            <span>02</span>
            <div><h2>路由决策</h2><p>过滤、报价与选择均按当前状态计算。</p></div>
          </div>

          <div className={`route-stage ${status}`}>
            <span className={profile ? "done" : status === "classifying" ? "active" : ""}>识别</span>
            <i />
            <span className={decision ? "done" : profile ? "active" : ""}>过滤</span>
            <i />
            <span className={decision ? "done" : ""}>报价</span>
            <i />
            <span className={decision ? "active done" : ""}>锁定</span>
          </div>

          <div className="profile-strip">
            <div><small>任务</small><strong>{profile ? taskLabels[profile.taskType] : "等待识别"}</strong></div>
            <div><small>难度</small><strong>{profile ? difficultyLabels[profile.difficulty] : "—"}</strong></div>
            <div><small>来源</small><strong>{profile?.source === "auto" ? "自动" : profile?.source === "mixed" ? "混合" : profile?.source === "manual" ? "手动" : "—"}</strong></div>
            <div><small>置信度</small><strong>{profile ? `${Math.round(profile.confidence * 100)}%` : "—"}</strong></div>
          </div>

          {decision && <div className="decision-note"><span>DECISION</span><p>{decision.explanation}</p></div>}

          <div className="model-list">
            <div className="model-list-head">
              <span>模型池</span><span>质量</span><span>当前 → 接纳后负载</span><span>CAP 报价</span><span>结论</span>
            </div>
            {bootstrap?.models.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                candidate={decision?.candidates.find((candidate) => candidate.modelId === model.id)}
                liveLoad={liveLoads[model.id]}
              />
            ))}
          </div>
        </section>

        <section className="response-panel panel">
          <div className="section-heading">
            <span>03</span>
            <div><h2>真实响应</h2><p>{selectedModel ? `${selectedModel.name} · ${selectedModel.upstreamModel}` : "等待模型选择"}</p></div>
          </div>

          <div className="metric-line">
            <div><small>TTFT</small><strong>{formatLatency(metrics?.ttftMs)}</strong></div>
            <div><small>总延迟</small><strong>{formatLatency(metrics?.totalLatencyMs)}</strong></div>
            <div><small>Token</small><strong>{metrics?.usage.totalTokens?.toLocaleString() ?? "—"}</strong></div>
          </div>

          <div className="answer-surface" ref={answerRef}>
            {!answer && !reasoning && (
              <div className="empty-response">
                <span>{status === "classifying" ? "ANALYZING" : status === "streaming" ? "CONNECTING" : "READY"}</span>
                <p>{status === "classifying" ? "Router 正在生成结构化任务画像…" : "回答将在路由锁价后流式显示。"}</p>
              </div>
            )}
            {reasoning && <details className="reasoning-output"><summary>模型推理过程</summary><p>{reasoning}</p></details>}
            {answer && <div className="answer-text">{answer}</div>}
            {status === "streaming" && <span className="cursor" />}
          </div>

          <div className="settlement">
            <div><small>上游实际 / 估算成本</small><strong>{formatMoney(metrics?.upstreamCost)}</strong></div>
            <div><small>PQ-CAP 锁定实验支付</small><strong>{formatMoney(metrics?.lockedPayment)}</strong></div>
            <div><small>Usage 来源</small><strong>{metrics ? (metrics.usage.estimated ? "本地估算" : "上游返回") : "—"}</strong></div>
          </div>
        </section>
      </main>

      <section className="log-section">
        <div className="log-heading"><h2>最近请求</h2><span>IN-MEMORY · LAST 100</span></div>
        <div className="log-table">
          <div className="log-row log-head"><span>时间</span><span>请求</span><span>模型</span><span>状态</span><span>延迟</span><span>上游成本</span><span>锁价支付</span></div>
          {bootstrap?.logs.length ? bootstrap.logs.slice(0, 8).map((log) => (
            <div className="log-row" key={log.id}>
              <span>{new Date(log.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}</span>
              <span title={log.promptPreview}>{log.promptPreview}</span>
              <span>{bootstrap.models.find((model) => model.id === log.selectedModelId)?.name ?? "—"}</span>
              <span className={`log-status ${log.status}`}>{log.status}</span>
              <span>{formatLatency(log.totalLatencyMs)}</span>
              <span>{formatMoney(log.upstreamCost)}</span>
              <span>{formatMoney(log.lockedPayment)}</span>
            </div>
          )) : <div className="empty-log">尚无请求记录</div>}
        </div>
      </section>
    </div>
  );
}
