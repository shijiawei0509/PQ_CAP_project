import { describe, expect, it } from "vitest";
import { capPrice, QUALITY_EPSILON, routeRequest } from "../server/pqcap.js";
import { RuntimeState } from "../server/state.js";
import type { RequestProfile } from "../server/types.js";
import { makeModel } from "./fixtures.js";

const profile: RequestProfile = {
  taskType: "reasoning",
  difficulty: "medium",
  requirements: {
    minContextTokens: 256,
    needsVision: false,
    needsTools: false,
    needsJsonOutput: false,
    contextPattern: "single"
  },
  confidence: 1,
  source: "manual"
};

describe("CAP price", () => {
  it("keeps the base price below normal capacity and rises in congestion", () => {
    const model = makeModel();
    expect(capPrice(model, 900)).toBe(1);
    expect(capPrice(model, 1_500)).toBe(1.5);
    expect(capPrice(model, 1_900)).toBeGreaterThan(5);
    expect(Number.isFinite(capPrice(model, model.hardCapacity))).toBe(true);
    expect(capPrice(model, model.hardCapacity + 1)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("PQ-CAP routing", () => {
  const modelA = makeModel({ id: "a", name: "High quality", basePricePerMillion: 1 });
  const modelB = makeModel({
    id: "b",
    name: "Efficient",
    basePricePerMillion: 0.2,
    quality: {
      coding: 0.82,
      math: 0.82,
      reasoning: 0.82,
      writing: 0.82,
      translation: 0.82,
      "general-qa": 0.82
    }
  });
  const configured = new Set(["a", "b"]);

  it("uses a fixed 0.02 quality-priority tolerance", () => {
    expect(QUALITY_EPSILON).toBe(0.02);
  });

  it("selects the cheapest model above the difficulty quality floor", () => {
    const decision = routeRequest({
      models: [modelA, modelB],
      loads: new Map(),
      profile,
      preference: { mode: "price" },
      prompt: "compare two systems",
      maxOutputTokens: 100,
      configuredOverride: configured
    });
    expect(decision.qualityThreshold).toBeCloseTo(0.8);
    expect(decision.selectedModelId).toBe("b");
  });

  it("keeps selection inside the near-optimal quality tier", () => {
    const decision = routeRequest({
      models: [modelA, modelB],
      loads: new Map(),
      profile,
      preference: { mode: "quality" },
      prompt: "compare two systems",
      maxOutputTokens: 100,
      configuredOverride: configured
    });
    expect(decision.selectedModelId).toBe("a");
    expect(decision.candidates.find((candidate) => candidate.modelId === "b")?.eligible).toBe(false);
  });

  it("respects an available fixed model", () => {
    const decision = routeRequest({
      models: [modelA, modelB],
      loads: new Map(),
      profile,
      preference: { mode: "fixed", fixedModelId: "b", fixedFallback: "unavailable" },
      prompt: "compare two systems",
      maxOutputTokens: 100,
      configuredOverride: configured
    });
    expect(decision.selectedModelId).toBe("b");
  });

  it("admits at hard capacity and filters only above it", () => {
    const atBoundary = routeRequest({
      models: [modelA, modelB],
      loads: new Map([["b", 1_895]]),
      profile,
      preference: { mode: "price" },
      prompt: "compare two systems",
      maxOutputTokens: 100,
      configuredOverride: configured
    });
    expect(atBoundary.candidates.find((candidate) => candidate.modelId === "b")?.eligible).toBe(true);

    const aboveBoundary = routeRequest({
      models: [modelA, modelB],
      loads: new Map([["b", 1_896]]),
      profile,
      preference: { mode: "price" },
      prompt: "compare two systems",
      maxOutputTokens: 100,
      configuredOverride: configured
    });
    expect(aboveBoundary.candidates.find((candidate) => candidate.modelId === "b")?.reasons).toContain(
      "接纳后触及硬容量边界"
    );
  });

  it("filters a model whose context window is below the deterministic requirement", () => {
    const shortContext = makeModel({ id: "short", maxContextTokens: 128 });
    const decision = routeRequest({
      models: [shortContext, modelA],
      loads: new Map(),
      profile,
      preference: { mode: "price" },
      prompt: "compare two systems",
      maxOutputTokens: 100,
      configuredOverride: new Set(["short", "a"])
    });

    expect(decision.selectedModelId).toBe("a");
    expect(decision.candidates.find((candidate) => candidate.modelId === "short")?.eligible).toBe(false);
  });
});

describe("runtime reservations", () => {
  it("never reserves at the hard boundary and always releases to zero", () => {
    const model = makeModel();
    const state = new RuntimeState([model]);
    expect(state.reserve(model, 1_999)).toBe(true);
    expect(state.reserve(model, 1)).toBe(false);
    state.release(model.id, 1_999);
    expect(state.snapshotLoads().get(model.id)).toBe(0);
  });
});
