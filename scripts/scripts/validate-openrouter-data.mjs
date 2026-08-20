import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshotDate = process.env.SNAPSHOT_DATE || "2026-07-18";
const dataDir = path.join(rootDir, `LLM_performance_data_${snapshotDate}`, "openrouter");
const requiredModels = ["deepseek/deepseek-v4-flash", "z-ai/glm-5.2"];
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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
  return records
    .filter((record) => record.some((value) => value !== ""))
    .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""])));
}

function readCsv(name) {
  return parseCsv(fs.readFileSync(path.join(dataDir, name), "utf8"));
}

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, name), "utf8"));
}

function validatePricePair(row, key, scope) {
  const raw = row[`${key}_usd_per_token`];
  const converted = row[`${key}_usd_per_million_tokens`];
  if (raw === "") {
    assert(converted === "", `${scope}: ${key} missing price must stay blank`);
    return;
  }
  const rawNumber = Number(raw);
  assert(Number.isFinite(rawNumber), `${scope}: ${key} raw price is not numeric`);
  assert(rawNumber >= 0 || rawNumber === -1, `${scope}: ${key} has unexpected negative price ${raw}`);
  if (rawNumber === -1) {
    assert(converted === "", `${scope}: dynamic -1 ${key} price must not be converted`);
    return;
  }
  const convertedNumber = Number(converted);
  assert(Number.isFinite(convertedNumber), `${scope}: ${key} converted price is not numeric`);
  assert(Math.abs(convertedNumber - rawNumber * 1_000_000) < 1e-12,
    `${scope}: ${key} per-million conversion mismatch`);
}

const manifest = readJson(`import_manifest_${snapshotDate}.json`);
assert(manifest.snapshot_date === snapshotDate, "manifest snapshot date mismatch");
assert(manifest.endpoint_failures.length === 0, "endpoint requests contain failures");

for (const item of [...manifest.sources, ...manifest.outputs]) {
  const relative = item.raw_file ?? item.file;
  const file = path.join(rootDir, relative);
  assert(fs.existsSync(file), `manifest file missing: ${relative}`);
  assert(sha256(file) === item.sha256, `SHA-256 mismatch: ${relative}`);
}

const rawModels = readJson(path.join("raw", `openrouter_models_${snapshotDate}.json`));
const rawEndpoints = readJson(path.join("raw", `openrouter_endpoints_selected_${snapshotDate}.json`));
const models = readCsv(`openrouter_models_${snapshotDate}.csv`);
const endpoints = readCsv(`openrouter_endpoints_${snapshotDate}.csv`);
const summaries = readCsv(`openrouter_operational_summary_${snapshotDate}.csv`);
const matches = readCsv(`openevals_openrouter_matches_${snapshotDate}.csv`);

assert(models.length === rawModels.data.length, "model CSV row count differs from raw catalog");
assert(models.length === manifest.outputs[0].row_count, "model CSV row count differs from manifest");
const modelIds = new Set(models.map((row) => row.openrouter_model_id));
assert(modelIds.size === models.length, "openrouter_model_id is not unique");

for (const modelId of requiredModels) {
  assert(modelIds.has(modelId), `required model missing from catalog: ${modelId}`);
  assert(manifest.selected_model_ids.includes(modelId), `required model missing from endpoint selection: ${modelId}`);
}

for (const row of models) {
  if (row.context_length !== "") assert(Number(row.context_length) >= 0, `${row.openrouter_model_id}: negative context length`);
  for (const key of priceKeys) validatePricePair(row, key, row.openrouter_model_id);
}

const endpointCounts = new Map(manifest.selected_model_ids.map((modelId) => [modelId, 0]));
const activeCounts = new Map(manifest.selected_model_ids.map((modelId) => [modelId, 0]));
for (const row of endpoints) {
  assert(endpointCounts.has(row.openrouter_model_id), `endpoint refers to unselected model: ${row.openrouter_model_id}`);
  endpointCounts.set(row.openrouter_model_id, endpointCounts.get(row.openrouter_model_id) + 1);
  if (Number(row.status) === 0) activeCounts.set(row.openrouter_model_id, activeCounts.get(row.openrouter_model_id) + 1);
  for (const key of priceKeys) validatePricePair(row, key, `${row.openrouter_model_id}/${row.provider_name}`);
}
assert(summaries.length === manifest.selected_model_ids.length, "operational summary row count mismatch");
assert(endpoints.length === manifest.outputs[1].row_count, "endpoint CSV row count differs from manifest");

const coverageFields = [
  "uptime_5m_coverage_count",
  "uptime_30m_coverage_count",
  "uptime_1d_coverage_count",
  "latency_30m_coverage_count",
  "throughput_30m_coverage_count",
  "active_prompt_price_coverage_count",
  "active_completion_price_coverage_count"
];
for (const row of summaries) {
  const endpointCount = Number(row.endpoint_count);
  const activeCount = Number(row.active_endpoint_count);
  assert(endpointCount === endpointCounts.get(row.openrouter_model_id), `${row.openrouter_model_id}: endpoint count mismatch`);
  assert(activeCount === activeCounts.get(row.openrouter_model_id), `${row.openrouter_model_id}: active endpoint count mismatch`);
  for (const field of coverageFields) {
    const limit = field.startsWith("active_") ? activeCount : endpointCount;
    assert(Number(row[field]) >= 0 && Number(row[field]) <= limit, `${row.openrouter_model_id}: invalid ${field}`);
  }
  if (Number(row.latency_30m_coverage_count) === 0) {
    assert(row.latency_30m_median_seconds === "", `${row.openrouter_model_id}: empty latency coverage must have blank median`);
  }
  if (Number(row.throughput_30m_coverage_count) === 0) {
    assert(row.throughput_30m_median_tokens_per_second === "", `${row.openrouter_model_id}: empty throughput coverage must have blank median`);
  }
}

const rawById = new Map(rawModels.data.map((model) => [model.id, model]));
const matchPairs = new Set();
const matchedOpenEvalsIds = new Set();
for (const row of matches) {
  assert(["hugging_face_id_exact", "openrouter_id_exact"].includes(row.match_method), `invalid match method: ${row.match_method}`);
  const model = rawById.get(row.openrouter_model_id);
  assert(model, `matched OpenRouter model not found: ${row.openrouter_model_id}`);
  const openEvalsId = row.openevals_model_name.toLowerCase();
  const expected = row.match_method === "hugging_face_id_exact" ? model.hugging_face_id?.toLowerCase() : model.id.toLowerCase();
  assert(openEvalsId === expected, `non-exact identity match: ${row.openrouter_model_id}`);
  const pair = `${openEvalsId}\u0000${row.openrouter_model_id}`;
  assert(!matchPairs.has(pair), `duplicate match pair: ${row.openrouter_model_id}`);
  assert(!matchedOpenEvalsIds.has(openEvalsId), `OpenEvals model matched more than once: ${row.openevals_model_name}`);
  matchPairs.add(pair);
  matchedOpenEvalsIds.add(openEvalsId);
}
assert(matches.length === manifest.openevals_exact_match_count, "exact match count differs from manifest");

const outputText = manifest.sources
  .map((item) => fs.readFileSync(path.join(rootDir, item.raw_file), "utf8"))
  .join("\n");
assert(!/authorization\s*[:=]|openrouter_api_key\s*[:=]|sk-or-v1-/iu.test(outputText), "possible API credential found in raw snapshots");

const uptimeModels = summaries.filter((row) => Number(row.uptime_5m_coverage_count) > 0).length;
const latencyModels = summaries.filter((row) => Number(row.latency_30m_coverage_count) > 0).length;
const throughputModels = summaries.filter((row) => Number(row.throughput_30m_coverage_count) > 0).length;
console.log(`Validated ${models.length} models, ${endpoints.length} endpoints, ${summaries.length} summaries, and ${matches.length} exact matches.`);
console.log(`Operational coverage (models): uptime=${uptimeModels}, latency=${latencyModels}, throughput=${throughputModels}.`);

