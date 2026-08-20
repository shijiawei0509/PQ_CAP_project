import crypto from "node:crypto";
import type { Difficulty } from "../../../../../../server/types.js";
import { loadFrozenProfile } from "../../price_first_user/code/model-profile.js";
import {
  loadFrozenLambda0,
  loadFrozenLoadAssignments,
} from "../../price_first_user/code/load-traces.js";
import {
  buildBaselineCandidates,
  type ExperimentRouter,
  type RouterInput,
  type RouterSelection,
} from "../../price_first_user/code/routers.js";
import { buildScenarioTrace } from "../../price_first_user/code/scenarios.js";
import {
  simulate,
  type RequestResult,
  type SimulationResult,
} from "../../price_first_user/code/simulator.js";
import type {
  ExperimentModel,
  ExperimentRequest,
  LoadClass,
  QualityThresholds,
  ScenarioDefinition,
} from "../../price_first_user/code/types.js";
import {
  BLIND_TOLERANCES,
  DEFAULT_TOLERANCES,
  DELTA_SCALES,
  FORMAL_SEEDS,
  INTERACTION_DELTA_SCALES,
  INTERACTION_KAPPAS,
  KAPPA_VALUES,
  PILOT_SEEDS,
  capQuoteWithKappa,
  freezeThresholds,
  scaledTolerances,
} from "./parameters.js";

export const REQUEST_TIMEOUT_MS = 300_000;
export const SLO_DEADLINE_MS = 120_000;
export const PILOT_REQUEST_COUNT = 600;
export const FORMAL_REQUEST_COUNT = 2_000;
export type ScenarioLabel = "regular" | "soft-congestion";
export type Family = "delta-scan" | "difficulty-control" |
  "kappa-scan" | "interaction";

export interface RunSpec {
  family: Family;
  parameterId: string;
  scenario: ScenarioLabel;
  deltaScale: number | null;
  kappa: number;
  tolerances: Readonly<Record<Difficulty, number>>;
}

export interface ParameterRequestRow extends RequestResult {
  family: Family;
  parameterId: string;
  scenarioLabel: ScenarioLabel;
  deltaScale: number | null;
  kappa: number;
  tolerance: number;
  traceHash: string;
  qualityGap: number | null;
  requestPayment: number | null;
  sloSuccess: boolean;
  completionAwareTtftMs: number;
  softPosition: number | null;
}

export interface RunOutput {
  spec: RunSpec;
  seed: number;
  requests: ParameterRequestRow[];
  simulation: SimulationResult;
  candidateObservations: CandidateObservation[];
}

export interface CandidateObservation {
  requestId: string;
  modelId: string;
  basePricePerMillion: number;
  softPosition: number | null;
}

function compareNumber(left: number, right: number): number {
  return left - right;
}

function createParameterRouter(
  kappa: number,
  observations: CandidateObservation[],
): ExperimentRouter {
  return {
    id: "ours-price-first",
    select(input: RouterInput): RouterSelection {
      const baseline = buildBaselineCandidates(input);
      for (const candidate of baseline) {
        observations.push({
          requestId: input.request.requestId,
          modelId: candidate.model.id,
          basePricePerMillion: candidate.model.basePricePerMillion,
          softPosition: candidate.postLoad <= candidate.model.normalCapacity
            ? null
            : (candidate.postLoad - candidate.model.normalCapacity) /
              (candidate.model.hardCapacity - candidate.model.normalCapacity),
        });
      }
      const dynamic = baseline.map((candidate) => ({
        candidate,
        quote: capQuoteWithKappa(
          candidate.model.basePricePerMillion,
          candidate.postLoad,
          candidate.model.normalCapacity,
          candidate.model.hardCapacity,
          kappa,
        ),
      }));
      const selected = [...dynamic].sort((left, right) =>
        compareNumber(left.quote, right.quote) ||
        compareNumber(
          Number(left.candidate.postLoad > left.candidate.model.normalCapacity),
          Number(right.candidate.postLoad > right.candidate.model.normalCapacity),
        ) ||
        compareNumber(left.candidate.queueWaitMs, right.candidate.queueWaitMs) ||
        compareNumber(right.candidate.quality, left.candidate.quality) ||
        left.candidate.model.id.localeCompare(right.candidate.model.id)
      )[0];
      const staticSelected = [...baseline].sort((left, right) =>
        compareNumber(left.model.basePricePerMillion,
          right.model.basePricePerMillion) ||
        compareNumber(
          Number(left.postLoad > left.model.normalCapacity),
          Number(right.postLoad > right.model.normalCapacity),
        ) ||
        compareNumber(left.queueWaitMs, right.queueWaitMs) ||
        compareNumber(right.quality, left.quality) ||
        left.model.id.localeCompare(right.model.id)
      )[0];
      return {
        modelId: selected?.candidate.model.id ?? null,
        reason: selected ? "parameter-sensitive price-first" : "no eligible model",
        eligibleIds: baseline.map((candidate) => candidate.model.id),
        lockedUnitPrice: selected?.quote ?? null,
        staticCheapestModelId: staticSelected?.model.id ?? null,
        dynamicCheapestModelId: selected?.candidate.model.id ?? null,
        priceInducedReroute: Boolean(
          selected && staticSelected &&
          selected.candidate.model.id !== staticSelected.model.id,
        ),
      };
    },
  };
}

function traceHash(request: ExperimentRequest): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    requestId: request.requestId,
    taskId: request.taskId,
    taskType: request.taskType,
    difficulty: request.difficulty,
    arrivalTimeMs: request.arrivalTimeMs,
    promptTokens: request.promptTokens,
    maxOutputTokens: request.maxOutputTokens,
    baseTtftByModel: request.baseTtftByModel,
  })).digest("hex");
}

function scenarioDefinition(
  scenario: ScenarioLabel,
  seed: number,
  requestCount: number,
): ScenarioDefinition {
  const lambda0 = loadFrozenLambda0();
  return {
    id: scenario === "regular" ? "S1" : "S2",
    seed,
    requestCount,
    arrivalRatePerSecond: lambda0,
  };
}

function loadClasses(
  scenario: ScenarioLabel,
  seed: number,
  models: readonly ExperimentModel[],
): Record<string, LoadClass> {
  if (scenario === "soft-congestion") {
    const ordered = [...models].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
    const phase = Math.abs(seed) % 2;
    return Object.fromEntries(ordered.map((model, index) => [
      model.id,
      (index + phase) % 2 === 0 ? "near" : "congested",
    ]));
  }
  const assignments = loadFrozenLoadAssignments(models);
  const knownSeeds: readonly number[] = [...PILOT_SEEDS, ...FORMAL_SEEDS];
  const seedIndex = knownSeeds.indexOf(seed);
  const sourceSeed = FORMAL_SEEDS[
    seedIndex >= 0 ? seedIndex % FORMAL_SEEDS.length : 0
  ];
  return assignments[sourceSeed];
}

function enrichRequests(
  result: SimulationResult,
  trace: readonly ExperimentRequest[],
  models: readonly ExperimentModel[],
  spec: RunSpec,
): ParameterRequestRow[] {
  const byId = new Map(trace.map((request) => [request.requestId, request]));
  const maxima = Object.fromEntries([
    "coding", "math", "reasoning", "writing", "translation", "general-qa",
  ].map((taskType) => [
    taskType,
    Math.max(...models.map((model) =>
      model.quality[taskType as keyof ExperimentModel["quality"]])),
  ])) as Record<string, number>;
  return result.requests.map((row) => {
    const request = byId.get(row.requestId);
    if (!request) throw new Error(`${row.requestId}: missing paired trace`);
    const completedTtft = row.endToEndTtftMs;
    const completionAwareTtftMs = completedTtft ?? REQUEST_TIMEOUT_MS;
    const requestPayment = row.lockedUnitPrice === null || row.reservedLoad === null
      ? null
      : row.lockedUnitPrice * row.reservedLoad / 1_000_000;
    const softPosition = row.postLoad === null || row.normalCapacity === null ||
        row.hardCapacity === null || row.postLoad <= row.normalCapacity
      ? null
      : (row.postLoad - row.normalCapacity) /
        (row.hardCapacity - row.normalCapacity);
    return {
      ...row,
      family: spec.family,
      parameterId: spec.parameterId,
      scenarioLabel: spec.scenario,
      deltaScale: spec.deltaScale,
      kappa: spec.kappa,
      tolerance: spec.tolerances[row.difficulty],
      traceHash: traceHash(request),
      qualityGap: row.quality === null
        ? null : maxima[row.taskType] - row.quality,
      requestPayment,
      sloSuccess: row.status === "completed" &&
        completionAwareTtftMs <= SLO_DEADLINE_MS,
      completionAwareTtftMs,
      softPosition,
    };
  });
}

export function executeRun(
  spec: RunSpec,
  seed: number,
  requestCount: number,
): RunOutput {
  const { models, tasks } = loadFrozenProfile();
  const thresholds: QualityThresholds = freezeThresholds(models, spec.tolerances);
  const definition = scenarioDefinition(spec.scenario, seed, requestCount);
  const trace = buildScenarioTrace({ definition, tasks, models });
  const candidateObservations: CandidateObservation[] = [];
  const simulation = simulate({
    scenario: definition,
    requests: trace,
    models,
    thresholds,
    loadClasses: loadClasses(spec.scenario, seed, models),
    router: createParameterRouter(spec.kappa, candidateObservations),
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!simulation.validation.finalLoadsZero ||
      !simulation.validation.capacityInvariant) {
    throw new Error(`${spec.parameterId}/${seed}: simulation invariant failure`);
  }
  return {
    spec,
    seed,
    requests: enrichRequests(simulation, trace, models, spec),
    simulation,
    candidateObservations,
  };
}

export function deltaSpecs(): RunSpec[] {
  return DELTA_SCALES.flatMap((scale) =>
    (["regular", "soft-congestion"] as const).map((scenario) => ({
      family: "delta-scan" as const,
      parameterId: `delta-${scale}`,
      scenario,
      deltaScale: scale,
      kappa: 1,
      tolerances: scaledTolerances(scale),
    }))
  );
}

export function controlSpecs(): RunSpec[] {
  return (["regular", "soft-congestion"] as const).flatMap((scenario) => [
    { family: "difficulty-control" as const, parameterId: "aware",
      scenario, deltaScale: 1, kappa: 1, tolerances: DEFAULT_TOLERANCES },
    { family: "difficulty-control" as const, parameterId: "blind-0.10",
      scenario, deltaScale: null, kappa: 1, tolerances: BLIND_TOLERANCES },
  ]);
}

export function kappaSpecs(): RunSpec[] {
  return KAPPA_VALUES.map((kappa) => ({
    family: "kappa-scan" as const,
    parameterId: `kappa-${kappa}`,
    scenario: "soft-congestion" as const,
    deltaScale: 1,
    kappa,
    tolerances: DEFAULT_TOLERANCES,
  }));
}

export function interactionSpecs(): RunSpec[] {
  return INTERACTION_DELTA_SCALES.flatMap((scale) =>
    INTERACTION_KAPPAS.map((kappa) => ({
      family: "interaction" as const,
      parameterId: `delta-${scale}-kappa-${kappa}`,
      scenario: "soft-congestion" as const,
      deltaScale: scale,
      kappa,
      tolerances: scaledTolerances(scale),
    }))
  );
}

export function formalSpecs(): RunSpec[] {
  return [...deltaSpecs(), ...controlSpecs(), ...kappaSpecs(), ...interactionSpecs()];
}
