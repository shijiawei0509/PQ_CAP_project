import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshotDate = process.env.SNAPSHOT_DATE || "2026-07-18";
const outputDir = path.join(rootDir, `LLM_performance_data_${snapshotDate}`, "openrouter");
const rawDir = path.join(outputDir, "raw");
const parserVersion = "1.0.0";
const apiRoot = "https://openrouter.ai";
const allModelsUrl = `${apiRoot}/api/v1/models?output_modalities=all`;
const popularModelsUrl = `${apiRoot}/api/v1/models?sort=most-popular&output_modalities=all`;
const requiredEndpointModels = ["deepseek/deepseek-v4-flash", "z-ai/glm-5.2"];
const priceKeys = [
  "prompt",
  "completion",
  "input_cache_read",
  "input_cache_write",
  "input_cache_write_1h",
  "input_audio_cache",
  "internal_reasoning",
  "request",
  "image",
  "image_token",
  "image_output",
  "audio",
  "audio_output",
  "web_search"
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "pq-cap-router-data-import/1.0" },
        signal: AbortSignal.timeout(90000)
      });
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.statusText}`);
        error.status = response.status;
        error.retryAfter = Number(response.headers.get("retry-after"));
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      const retryAfterMs = Number.isFinite(error.retryAfter) && error.retryAfter > 0
        ? error.retryAfter * 1000
        : 1000 * (2 ** attempt);
      await sleep(retryAfterMs);
    }
  }
  throw lastError;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function csvEscape(value) {
  if (value == null) return "";
  const text = typeof value === "string" ? value : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(file, columns, rows) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvEscape(row[column])).join(","));
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

function parseCsv(text) {
  const records = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/u, ""));
      records.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field || row.length) {
    row.push(field);
    records.push(row);
  }
  const headers = records.shift() ?? [];
  return records.filter((record) => record.some((value) => value !== "")).map((record) =>
    Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""]))
  );
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalPrice(value) {
  const number = numberOrNull(value);
  return number != null && number >= 0 ? number : null;
}

function perMillion(value) {
  const number = normalPrice(value);
  return number == null ? null : number * 1_000_000;
}

function median(values) {
  const sorted = values.filter((value) => value != null && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function isEndpointCandidate(model) {
  const outputs = model.architecture?.output_modalities ?? [];
  const prompt = numberOrNull(model.pricing?.prompt);
  const completion = numberOrNull(model.pricing?.completion);
  return outputs.includes("text")
    && prompt != null && prompt >= 0
    && completion != null && completion >= 0
    && !model.id.startsWith("~")
    && !model.id.startsWith("openrouter/")
    && model.architecture?.tokenizer !== "Router";
}

function normalizeModel(model, openEvalsMatch) {
  const supported = new Set(model.supported_parameters ?? []);
  const row = {
    openrouter_model_id: model.id,
    canonical_slug: model.canonical_slug ?? "",
    hugging_face_id: model.hugging_face_id ?? "",
    name: model.name ?? "",
    description: model.description ?? "",
    created_unix: model.created ?? "",
    created_at_utc: model.created ? new Date(model.created * 1000).toISOString() : "",
    knowledge_cutoff: model.knowledge_cutoff ?? "",
    expiration_date: model.expiration_date ?? "",
    context_length: model.context_length ?? "",
    top_provider_context_length: model.top_provider?.context_length ?? "",
    max_completion_tokens: model.top_provider?.max_completion_tokens ?? "",
    is_moderated: model.top_provider?.is_moderated ?? "",
    modality: model.architecture?.modality ?? "",
    input_modalities: (model.architecture?.input_modalities ?? []).join("|"),
    output_modalities: (model.architecture?.output_modalities ?? []).join("|"),
    tokenizer: model.architecture?.tokenizer ?? "",
    instruct_type: model.architecture?.instruct_type ?? "",
    supports_tools: supported.has("tools"),
    supports_tool_choice: supported.has("tool_choice"),
    supports_structured_outputs: supported.has("structured_outputs"),
    supports_response_format: supported.has("response_format"),
    supports_reasoning: supported.has("reasoning") || supported.has("reasoning_effort"),
    supported_parameters_json: JSON.stringify(model.supported_parameters ?? []),
    pricing_json: JSON.stringify(model.pricing ?? {}),
    pricing_overrides_json: JSON.stringify(model.pricing?.overrides ?? null),
    per_request_limits_json: JSON.stringify(model.per_request_limits ?? null),
    default_parameters_json: JSON.stringify(model.default_parameters ?? null),
    openrouter_details_path: model.links?.details ?? "",
    source_scope: "openrouter_aggregate",
    snapshot_date: snapshotDate,
    openevals_exact_match: Boolean(openEvalsMatch),
    openevals_model_name: openEvalsMatch?.model_name ?? "",
    openevals_match_method: openEvalsMatch?.match_method ?? "",
    quality_data_missing: !openEvalsMatch
  };
  for (const key of priceKeys) {
    row[`${key}_usd_per_token`] = model.pricing?.[key] ?? "";
    row[`${key}_usd_per_million_tokens`] = perMillion(model.pricing?.[key]) ?? "";
  }
  return row;
}

function normalizeEndpoint(model, endpoint) {
  const row = {
    openrouter_model_id: model.id,
    model_name: model.name ?? endpoint.model_name ?? "",
    provider_name: endpoint.provider_name ?? "",
    endpoint_name: endpoint.name ?? "",
    tag: endpoint.tag ?? "",
    quantization: endpoint.quantization ?? "",
    status: endpoint.status ?? "",
    context_length: endpoint.context_length ?? "",
    max_prompt_tokens: endpoint.max_prompt_tokens ?? "",
    max_completion_tokens: endpoint.max_completion_tokens ?? "",
    uptime_last_5m_percent: endpoint.uptime_last_5m ?? "",
    uptime_last_30m_percent: endpoint.uptime_last_30m ?? "",
    uptime_last_1d_percent: endpoint.uptime_last_1d ?? "",
    latency_last_30m_seconds: endpoint.latency_last_30m ?? "",
    throughput_last_30m_tokens_per_second: endpoint.throughput_last_30m ?? "",
    supports_implicit_caching: endpoint.supports_implicit_caching ?? "",
    supported_parameters_json: JSON.stringify(endpoint.supported_parameters ?? []),
    pricing_json: JSON.stringify(endpoint.pricing ?? {}),
    source_scope: "openrouter_provider_endpoint",
    snapshot_date: snapshotDate
  };
  for (const key of priceKeys) {
    row[`${key}_usd_per_token`] = endpoint.pricing?.[key] ?? "";
    row[`${key}_usd_per_million_tokens`] = perMillion(endpoint.pricing?.[key]) ?? "";
  }
  return row;
}

function makeOpenEvalsMatches(openEvalsRows, models) {
  const hfMap = new Map();
  const idMap = new Map();
  for (const model of models) {
    if (model.hugging_face_id) {
      const key = model.hugging_face_id.toLowerCase();
      if (!hfMap.has(key)) hfMap.set(key, []);
      hfMap.get(key).push(model);
    }
    const idKey = model.id.toLowerCase();
    if (!idMap.has(idKey)) idMap.set(idKey, []);
    idMap.get(idKey).push(model);
  }

  const matches = [];
  const skippedAmbiguous = [];
  for (const openEvals of openEvalsRows) {
    const key = openEvals.model_name.toLowerCase();
    let candidates = hfMap.get(key) ?? [];
    let method = "hugging_face_id_exact";
    if (!candidates.length) {
      candidates = idMap.get(key) ?? [];
      method = "openrouter_id_exact";
    }
    candidates = candidates.filter((model) => !model.id.startsWith("~") && !model.id.includes(":"));
    if (candidates.length !== 1) {
      if (candidates.length > 1) skippedAmbiguous.push({ model_name: openEvals.model_name, candidate_ids: candidates.map((model) => model.id) });
      continue;
    }
    const model = candidates[0];
    matches.push({ openEvals, model, method });
  }
  return { matches, skippedAmbiguous };
}

function buildOperationalSummary(selectedModels, endpointRows) {
  const grouped = new Map(selectedModels.map((model) => [model.id, []]));
  for (const endpoint of endpointRows) {
    if (!grouped.has(endpoint.openrouter_model_id)) grouped.set(endpoint.openrouter_model_id, []);
    grouped.get(endpoint.openrouter_model_id).push(endpoint);
  }
  return selectedModels.map((model) => {
    const rows = grouped.get(model.id) ?? [];
    const active = rows.filter((row) => Number(row.status) === 0);
    const summarize = (field, sourceRows = rows) => {
      const values = sourceRows.map((row) => numberOrNull(row[field])).filter((value) => value != null);
      return { count: values.length, median: median(values) };
    };
    const uptime5m = summarize("uptime_last_5m_percent");
    const uptime30m = summarize("uptime_last_30m_percent");
    const uptime1d = summarize("uptime_last_1d_percent");
    const latency = summarize("latency_last_30m_seconds");
    const throughput = summarize("throughput_last_30m_tokens_per_second");
    const promptPrice = summarize("prompt_usd_per_million_tokens", active);
    const completionPrice = summarize("completion_usd_per_million_tokens", active);
    const activePrompt = active.map((row) => numberOrNull(row.prompt_usd_per_million_tokens)).filter((value) => value != null);
    const activeCompletion = active.map((row) => numberOrNull(row.completion_usd_per_million_tokens)).filter((value) => value != null);
    return {
      openrouter_model_id: model.id,
      model_name: model.name ?? "",
      endpoint_count: rows.length,
      active_endpoint_count: active.length,
      uptime_5m_coverage_count: uptime5m.count,
      uptime_5m_median_percent: uptime5m.median ?? "",
      uptime_30m_coverage_count: uptime30m.count,
      uptime_30m_median_percent: uptime30m.median ?? "",
      uptime_1d_coverage_count: uptime1d.count,
      uptime_1d_median_percent: uptime1d.median ?? "",
      latency_30m_coverage_count: latency.count,
      latency_30m_median_seconds: latency.median ?? "",
      throughput_30m_coverage_count: throughput.count,
      throughput_30m_median_tokens_per_second: throughput.median ?? "",
      active_prompt_price_coverage_count: promptPrice.count,
      active_prompt_price_min_usd_per_million_tokens: activePrompt.length ? Math.min(...activePrompt) : "",
      active_prompt_price_median_usd_per_million_tokens: promptPrice.median ?? "",
      active_completion_price_coverage_count: completionPrice.count,
      active_completion_price_min_usd_per_million_tokens: activeCompletion.length ? Math.min(...activeCompletion) : "",
      active_completion_price_median_usd_per_million_tokens: completionPrice.median ?? "",
      source_scope: "openrouter_provider_endpoint_aggregate",
      snapshot_date: snapshotDate
    };
  });
}

fs.mkdirSync(rawDir, { recursive: true });
const fetchedAt = new Date().toISOString();
console.log("Fetching OpenRouter model catalogs...");
const [allModelsPayload, popularModelsPayload] = await Promise.all([
  fetchJson(allModelsUrl),
  fetchJson(popularModelsUrl)
]);
const allModels = allModelsPayload.data ?? [];
const popularModels = popularModelsPayload.data ?? [];
if (!allModels.length || !popularModels.length) throw new Error("OpenRouter model API returned no data");

const allById = new Map(allModels.map((model) => [model.id, model]));
const selectedModels = popularModels.filter(isEndpointCandidate).slice(0, 50);
for (const modelId of requiredEndpointModels) {
  const model = allById.get(modelId);
  if (!model) throw new Error(`Required model not found in OpenRouter catalog: ${modelId}`);
  if (!selectedModels.some((item) => item.id === modelId)) selectedModels.push(model);
}
console.log(`Catalog models: ${allModels.length}; endpoint candidates: ${selectedModels.length}`);

const endpointResults = new Array(selectedModels.length);
let cursor = 0;
async function endpointWorker() {
  while (true) {
    const index = cursor;
    cursor += 1;
    if (index >= selectedModels.length) return;
    const model = selectedModels[index];
    const detailsPath = model.links?.details || `/api/v1/models/${model.id}/endpoints`;
    const url = detailsPath.startsWith("http") ? detailsPath : `${apiRoot}${detailsPath}`;
    try {
      const payload = await fetchJson(url);
      endpointResults[index] = { model_id: model.id, url, ok: true, payload };
      console.log(`[${index + 1}/${selectedModels.length}] ${model.id}: ${payload.data?.endpoints?.length ?? 0} endpoints`);
    } catch (error) {
      endpointResults[index] = { model_id: model.id, url, ok: false, error: error instanceof Error ? error.message : String(error) };
      console.warn(`[${index + 1}/${selectedModels.length}] ${model.id}: failed`);
    }
  }
}
await Promise.all(Array.from({ length: 4 }, () => endpointWorker()));

const rawModelsFile = path.join(rawDir, `openrouter_models_${snapshotDate}.json`);
const rawPopularFile = path.join(rawDir, `openrouter_models_most_popular_${snapshotDate}.json`);
const rawEndpointsFile = path.join(rawDir, `openrouter_endpoints_selected_${snapshotDate}.json`);
fs.writeFileSync(rawModelsFile, `${JSON.stringify(allModelsPayload, null, 2)}\n`, "utf8");
fs.writeFileSync(rawPopularFile, `${JSON.stringify(popularModelsPayload, null, 2)}\n`, "utf8");
fs.writeFileSync(rawEndpointsFile, `${JSON.stringify({ snapshot_date: snapshotDate, fetched_at: fetchedAt, selected_model_ids: selectedModels.map((model) => model.id), results: endpointResults }, null, 2)}\n`, "utf8");

const openEvalsFile = path.join(rootDir, `LLM_performance_data_${snapshotDate}`, "OpenEvals-leaderboard-data.csv");
const openEvalsRows = parseCsv(fs.readFileSync(openEvalsFile, "utf8"));
const { matches, skippedAmbiguous } = makeOpenEvalsMatches(openEvalsRows, allModels);
const matchesByModelId = new Map(matches.map((match) => [match.model.id, { ...match.openEvals, match_method: match.method }]));
const modelRows = allModels.map((model) => normalizeModel(model, matchesByModelId.get(model.id)));

const endpointRows = [];
for (const result of endpointResults) {
  if (!result.ok) continue;
  const model = allById.get(result.model_id);
  for (const endpoint of result.payload.data?.endpoints ?? []) endpointRows.push(normalizeEndpoint(model, endpoint));
}
const operationalRows = buildOperationalSummary(selectedModels, endpointRows);

const modelColumns = Object.keys(modelRows[0]);
const endpointColumns = endpointRows.length ? Object.keys(endpointRows[0]) : [];
const operationalColumns = Object.keys(operationalRows[0]);
const originalOpenEvalsColumns = Object.keys(openEvalsRows[0]);
const matchRows = matches.map(({ openEvals, model, method }) => ({
  match_method: method,
  openrouter_model_id: model.id,
  openrouter_name: model.name,
  openrouter_hugging_face_id: model.hugging_face_id ?? "",
  context_length: model.context_length ?? "",
  prompt_usd_per_million_tokens: perMillion(model.pricing?.prompt) ?? "",
  completion_usd_per_million_tokens: perMillion(model.pricing?.completion) ?? "",
  supports_tools: (model.supported_parameters ?? []).includes("tools"),
  supports_structured_outputs: (model.supported_parameters ?? []).includes("structured_outputs"),
  ...Object.fromEntries(originalOpenEvalsColumns.map((column) => [`openevals_${column}`, openEvals[column]]))
}));
const matchColumns = matchRows.length ? Object.keys(matchRows[0]) : [];

const modelCsv = path.join(outputDir, `openrouter_models_${snapshotDate}.csv`);
const endpointCsv = path.join(outputDir, `openrouter_endpoints_${snapshotDate}.csv`);
const operationalCsv = path.join(outputDir, `openrouter_operational_summary_${snapshotDate}.csv`);
const matchesCsv = path.join(outputDir, `openevals_openrouter_matches_${snapshotDate}.csv`);
writeCsv(modelCsv, modelColumns, modelRows);
writeCsv(endpointCsv, endpointColumns, endpointRows);
writeCsv(operationalCsv, operationalColumns, operationalRows);
writeCsv(matchesCsv, matchColumns, matchRows);

const manifestFile = path.join(outputDir, `import_manifest_${snapshotDate}.json`);
const manifest = {
  snapshot_date: snapshotDate,
  fetched_at: fetchedAt,
  parser_version: parserVersion,
  sources: [
    { url: allModelsUrl, raw_file: path.relative(rootDir, rawModelsFile).replaceAll("\\", "/"), sha256: sha256File(rawModelsFile), row_count: allModels.length },
    { url: popularModelsUrl, raw_file: path.relative(rootDir, rawPopularFile).replaceAll("\\", "/"), sha256: sha256File(rawPopularFile), row_count: popularModels.length },
    { url_template: `${apiRoot}/api/v1/models/{author}/{slug}/endpoints`, raw_file: path.relative(rootDir, rawEndpointsFile).replaceAll("\\", "/"), sha256: sha256File(rawEndpointsFile), selected_model_count: selectedModels.length, successful_model_count: endpointResults.filter((result) => result.ok).length }
  ],
  outputs: [
    { file: path.relative(rootDir, modelCsv).replaceAll("\\", "/"), sha256: sha256File(modelCsv), row_count: modelRows.length },
    { file: path.relative(rootDir, endpointCsv).replaceAll("\\", "/"), sha256: sha256File(endpointCsv), row_count: endpointRows.length },
    { file: path.relative(rootDir, operationalCsv).replaceAll("\\", "/"), sha256: sha256File(operationalCsv), row_count: operationalRows.length },
    { file: path.relative(rootDir, matchesCsv).replaceAll("\\", "/"), sha256: sha256File(matchesCsv), row_count: matchRows.length }
  ],
  selected_model_ids: selectedModels.map((model) => model.id),
  endpoint_failures: endpointResults.filter((result) => !result.ok).map(({ model_id, url, error }) => ({ model_id, url, error })),
  openevals_input_rows: openEvalsRows.length,
  openevals_exact_match_count: matches.length,
  openevals_ambiguous_matches_skipped: skippedAmbiguous
};
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Wrote ${modelRows.length} models, ${endpointRows.length} endpoints, ${operationalRows.length} summaries, ${matchRows.length} exact matches.`);
