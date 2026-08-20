import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SNAPSHOT_DATE = "2026-07-18";
const EXPECTED_MATCH_COUNT = 35;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(rootDir, `LLM_performance_data_${SNAPSHOT_DATE}`, "openrouter");

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
  const headers = (records.shift() ?? []).map((header) => header.replace(/^\uFEFF/u, ""));
  return records
    .filter((record) => record.some((value) => value !== ""))
    .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""])));
}

function readCsv(filename) {
  return parseCsv(fs.readFileSync(path.join(dataDir, filename), "utf8"));
}

function csvCell(value) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function serializeCsv(headers, rows) {
  return [headers, ...rows.map((row) => headers.map((header) => row[header]))]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n") + "\r\n";
}

function parseScore(value) {
  if (value === "" || value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) throw new Error(`Invalid score: ${value}`);
  return parsed;
}

function normalized(value) {
  return Number((value / 100).toFixed(6));
}

function groupedQuality(row, fields, aggregate) {
  const available = fields
    .map(([field, label]) => [parseScore(row[field]), label])
    .filter(([value]) => value !== undefined);
  if (!available.length) return { value: normalized(aggregate), basis: "aggregate_fallback" };
  return {
    value: normalized(available.reduce((sum, [value]) => sum + value, 0) / available.length),
    basis: available.map(([, label]) => label).join("|")
  };
}

function buildQuality(row) {
  const aggregate = parseScore(row.openevals_aggregate_score);
  if (aggregate === undefined) throw new Error(`${row.openrouter_model_id}: missing aggregate score`);
  return {
    coding: groupedQuality(row, [
      ["openevals_swePro_score", "SWE-Pro"],
      ["openevals_sweVerified_score", "SWE-bench Verified"],
      ["openevals_terminalBench_score", "Terminal-Bench"]
    ], aggregate),
    math: groupedQuality(row, [
      ["openevals_aime2026_score", "AIME 2026"],
      ["openevals_hmmt2026_score", "HMMT 2026"],
      ["openevals_gsm8k_score", "GSM8K"]
    ], aggregate),
    reasoning: groupedQuality(row, [
      ["openevals_gpqa_score", "GPQA"],
      ["openevals_hle_score", "Humanity's Last Exam"],
      ["openevals_evasionBench_score", "EvasionBench"]
    ], aggregate),
    writing: { value: normalized(aggregate), basis: "aggregate_proxy" },
    translation: { value: normalized(aggregate), basis: "aggregate_proxy" },
    generalQa: groupedQuality(row, [["openevals_mmluPro_score", "MMLU-Pro"]], aggregate)
  };
}

function uniqueJoined(values) {
  return [...new Set(values.filter(Boolean))].sort().join("|");
}

const matches = readCsv(`openevals_openrouter_matches_${SNAPSHOT_DATE}.csv`);
const catalog = readCsv(`openrouter_models_${SNAPSHOT_DATE}.csv`);
const operations = readCsv(`openrouter_operational_summary_${SNAPSHOT_DATE}.csv`);
const endpoints = readCsv(`openrouter_endpoints_${SNAPSHOT_DATE}.csv`);
const runtimeConfig = JSON.parse(fs.readFileSync(path.join(rootDir, "models.json"), "utf8"));

if (matches.length !== EXPECTED_MATCH_COUNT) {
  throw new Error(`Expected ${EXPECTED_MATCH_COUNT} exact matches, got ${matches.length}`);
}

const catalogById = new Map(catalog.map((row) => [row.openrouter_model_id, row]));
const operationsById = new Map(operations.map((row) => [row.openrouter_model_id, row]));
const endpointsById = new Map();
for (const endpoint of endpoints) {
  const group = endpointsById.get(endpoint.openrouter_model_id) ?? [];
  group.push(endpoint);
  endpointsById.set(endpoint.openrouter_model_id, group);
}
const runtimeById = new Map(
  runtimeConfig.models
    .filter((model) => model.provider === "openrouter")
    .map((model) => [model.upstreamModel, model])
);

const rows = matches.map((match) => {
  const modelId = match.openrouter_model_id;
  if (!["hugging_face_id_exact", "openrouter_id_exact"].includes(match.match_method)) {
    throw new Error(`${modelId}: non-exact match method ${match.match_method}`);
  }
  const catalogRow = catalogById.get(modelId);
  const runtime = runtimeById.get(modelId);
  if (!catalogRow || !runtime) throw new Error(`${modelId}: missing catalog or runtime model`);
  const operation = operationsById.get(modelId);
  const modelEndpoints = endpointsById.get(modelId) ?? [];
  const quality = buildQuality(match);
  const expectedQuality = {
    coding: quality.coding.value,
    math: quality.math.value,
    reasoning: quality.reasoning.value,
    writing: quality.writing.value,
    translation: quality.translation.value,
    "general-qa": quality.generalQa.value
  };
  for (const [task, value] of Object.entries(expectedQuality)) {
    if (runtime.quality[task] !== value) {
      throw new Error(`${modelId}: runtime ${task}=${runtime.quality[task]} differs from derived ${value}`);
    }
  }

  return {
    snapshot_date: SNAPSHOT_DATE,
    match_method: match.match_method,
    openrouter_model_id: modelId,
    openrouter_name: match.openrouter_name || catalogRow.name,
    openrouter_hugging_face_id: catalogRow.hugging_face_id,
    openevals_model_id: match["openevals_﻿model_id"] || match.openevals_model_id,
    openevals_model_name: match.openevals_model_name,
    openevals_provider: match.openevals_provider,
    openevals_model_type: match.openevals_model_type,
    openevals_parameters_billions: match.openevals_parameters_billions,
    openevals_license: match.openevals_license,
    openrouter_created_at_utc: catalogRow.created_at_utc,
    openrouter_knowledge_cutoff: catalogRow.knowledge_cutoff,
    openrouter_modality: catalogRow.modality,
    openrouter_input_modalities: catalogRow.input_modalities,
    openrouter_output_modalities: catalogRow.output_modalities,
    openrouter_tokenizer: catalogRow.tokenizer,
    openrouter_instruct_type: catalogRow.instruct_type,
    context_length_tokens: catalogRow.context_length,
    max_completion_tokens: catalogRow.max_completion_tokens,
    supports_tools: catalogRow.supports_tools,
    supports_tool_choice: catalogRow.supports_tool_choice,
    supports_structured_outputs: catalogRow.supports_structured_outputs,
    supports_response_format: catalogRow.supports_response_format,
    supports_reasoning: catalogRow.supports_reasoning,
    runtime_vision: runtime.capabilities.vision,
    runtime_tools: runtime.capabilities.tools,
    runtime_json: runtime.capabilities.json,
    prompt_usd_per_million_tokens: catalogRow.prompt_usd_per_million_tokens,
    completion_usd_per_million_tokens: catalogRow.completion_usd_per_million_tokens,
    cache_read_usd_per_million_tokens: catalogRow.input_cache_read_usd_per_million_tokens,
    cache_write_usd_per_million_tokens: catalogRow.input_cache_write_usd_per_million_tokens,
    runtime_eta_output_input_price_ratio: runtime.eta,
    endpoint_data_available: Boolean(operation),
    endpoint_snapshot_scope: operation ? "selected_popular_candidate" : "not_collected_for_this_model",
    endpoint_count: operation?.endpoint_count ?? "",
    active_endpoint_count: operation?.active_endpoint_count ?? "",
    endpoint_providers: uniqueJoined(modelEndpoints.map((endpoint) => endpoint.provider_name)),
    endpoint_names: uniqueJoined(modelEndpoints.map((endpoint) => endpoint.endpoint_name)),
    endpoint_quantizations: uniqueJoined(modelEndpoints.map((endpoint) => endpoint.quantization)),
    uptime_5m_median_percent: operation?.uptime_5m_median_percent ?? "",
    uptime_30m_median_percent: operation?.uptime_30m_median_percent ?? "",
    uptime_1d_median_percent: operation?.uptime_1d_median_percent ?? "",
    latency_30m_median_seconds: operation?.latency_30m_median_seconds ?? "",
    throughput_30m_median_tokens_per_second: operation?.throughput_30m_median_tokens_per_second ?? "",
    active_prompt_price_min_usd_per_million_tokens: operation?.active_prompt_price_min_usd_per_million_tokens ?? "",
    active_prompt_price_median_usd_per_million_tokens: operation?.active_prompt_price_median_usd_per_million_tokens ?? "",
    active_completion_price_min_usd_per_million_tokens: operation?.active_completion_price_min_usd_per_million_tokens ?? "",
    active_completion_price_median_usd_per_million_tokens: operation?.active_completion_price_median_usd_per_million_tokens ?? "",
    quality_coding_0_to_1: quality.coding.value,
    quality_coding_basis: quality.coding.basis,
    quality_math_0_to_1: quality.math.value,
    quality_math_basis: quality.math.basis,
    quality_reasoning_0_to_1: quality.reasoning.value,
    quality_reasoning_basis: quality.reasoning.basis,
    quality_writing_0_to_1: quality.writing.value,
    quality_writing_basis: quality.writing.basis,
    quality_translation_0_to_1: quality.translation.value,
    quality_translation_basis: quality.translation.basis,
    quality_general_qa_0_to_1: quality.generalQa.value,
    quality_general_qa_basis: quality.generalQa.basis,
    openevals_aime2026_score_0_to_100: match.openevals_aime2026_score,
    openevals_hmmt2026_score_0_to_100: match.openevals_hmmt2026_score,
    openevals_gsm8k_score_0_to_100: match.openevals_gsm8k_score,
    openevals_gpqa_score_0_to_100: match.openevals_gpqa_score,
    openevals_hle_score_0_to_100: match.openevals_hle_score,
    openevals_evasion_bench_score_0_to_100: match.openevals_evasionBench_score,
    openevals_mmlu_pro_score_0_to_100: match.openevals_mmluPro_score,
    openevals_swe_pro_score_0_to_100: match.openevals_swePro_score,
    openevals_swe_verified_score_0_to_100: match.openevals_sweVerified_score,
    openevals_terminal_bench_score_0_to_100: match.openevals_terminalBench_score,
    openevals_olm_ocr_score_0_to_100: match.openevals_olmOcr_score,
    openevals_aggregate_score_0_to_100: match.openevals_aggregate_score,
    openevals_coverage_count: match.openevals_coverage_count,
    openevals_coverage_percent: match.openevals_coverage_percent,
    runtime_model_id: runtime.id,
    runtime_enabled: runtime.enabled,
    runtime_can_route: runtime.canRoute,
    runtime_quality_source: runtime.qualitySource,
    openrouter_details_path: catalogRow.openrouter_details_path
  };
}).sort((left, right) => left.openrouter_model_id.localeCompare(right.openrouter_model_id));

if (new Set(rows.map((row) => row.openrouter_model_id)).size !== EXPECTED_MATCH_COUNT) {
  throw new Error("Matched model IDs are not unique");
}

const headers = Object.keys(rows[0]);
const outputPath = path.join(dataDir, `openrouter_openevals_35_models_${SNAPSHOT_DATE}.csv`);
fs.writeFileSync(outputPath, serializeCsv(headers, rows), "utf8");

const endpointCovered = rows.filter((row) => row.endpoint_data_available).length;
console.log(`Wrote ${rows.length} models (${endpointCovered} with collected endpoint summaries) to ${outputPath}`);
