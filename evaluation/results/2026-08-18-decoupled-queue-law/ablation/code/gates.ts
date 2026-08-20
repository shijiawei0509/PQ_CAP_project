import { holmAdjust, type Summary } from "./statistics.js";
import type { IndependentCohort } from "./types.js";

export interface CohortPointEffect {
  gini: number;
  queueRelative: number;
}

export interface GateInput {
  gini: Summary;
  queueRelative: Summary;
  completionByCohort: Record<IndependentCohort, Summary>;
  cohortPointEffects: Record<IndependentCohort, CohortPointEffect>;
}

export interface GateCondition {
  id: string;
  passed: boolean;
  value: number | boolean;
  threshold: string;
}

export interface GateResult {
  passed: boolean;
  holmAdjusted: {
    gini: number;
    queueRelative: number;
  };
  conditions: GateCondition[];
}

function commonConditions(input: GateInput): GateCondition[] {
  return [
    ...(["quality-first", "price-first"] as const).map((cohort) => ({
      id: `${cohort}-completion-noninferior`,
      passed: input.completionByCohort[cohort].ciLow >= -0.005,
      value: input.completionByCohort[cohort].ciLow,
      threshold: "CI lower >= -0.005"
    })),
    ...(["quality-first", "price-first"] as const).flatMap((cohort) => [
      {
        id: `${cohort}-gini-tolerance`,
        passed: input.cohortPointEffects[cohort].gini <= 0.005,
        value: input.cohortPointEffects[cohort].gini,
        threshold: "Full - comparator <= 0.005"
      },
      {
        id: `${cohort}-queue-tolerance`,
        passed: input.cohortPointEffects[cohort].queueRelative <= 0.05,
        value: input.cohortPointEffects[cohort].queueRelative,
        threshold: "(Full - comparator) / comparator <= 0.05"
      }
    ])
  ];
}

function result(
  input: GateInput,
  conditions: GateCondition[]
): GateResult {
  const [gini, queueRelative] = holmAdjust([
    input.gini.pTwoSided,
    input.queueRelative.pTwoSided
  ]);
  return {
    passed: conditions.every((condition) => condition.passed),
    holmAdjusted: { gini, queueRelative },
    conditions
  };
}

export function evaluateNoCapGate(input: GateInput): GateResult {
  const [giniAdjusted, queueAdjusted] = holmAdjust([
    input.gini.pTwoSided,
    input.queueRelative.pTwoSided
  ]);
  const conditions: GateCondition[] = [
    {
      id: "gini-ci-favorable",
      passed: input.gini.ciHigh < 0,
      value: input.gini.ciHigh,
      threshold: "CI upper < 0"
    },
    {
      id: "gini-holm-significant",
      passed: giniAdjusted < 0.05,
      value: giniAdjusted,
      threshold: "Holm-adjusted p < 0.05"
    },
    {
      id: "queue-ci-favorable",
      passed: input.queueRelative.ciHigh < 0,
      value: input.queueRelative.ciHigh,
      threshold: "CI upper < 0"
    },
    {
      id: "queue-holm-significant",
      passed: queueAdjusted < 0.05,
      value: queueAdjusted,
      threshold: "Holm-adjusted p < 0.05"
    },
    ...commonConditions(input)
  ];
  return result(input, conditions);
}

export function evaluatePreUpdateGate(input: GateInput): GateResult {
  const [giniAdjusted, queueAdjusted] = holmAdjust([
    input.gini.pTwoSided,
    input.queueRelative.pTwoSided
  ]);
  const giniImproves = input.gini.ciHigh < 0 && giniAdjusted < 0.05;
  const queueImproves =
    input.queueRelative.ciHigh < 0 && queueAdjusted < 0.05;
  const conditions: GateCondition[] = [
    {
      id: "at-least-one-significant-improvement",
      passed: giniImproves || queueImproves,
      value: giniImproves || queueImproves,
      threshold: "Gini or queue favorable CI and Holm-adjusted p < 0.05"
    },
    ...commonConditions(input)
  ];
  return result(input, conditions);
}

export function combineSuccessGates(args: {
  noCap: GateResult;
  preUpdate: GateResult;
}): {
  supported: boolean;
  conclusion:
    | "支持有效分流主张"
    | "仅部分支持有效分流主张"
    | "未支持有效分流主张";
} {
  const passCount = Number(args.noCap.passed) + Number(args.preUpdate.passed);
  return {
    supported: passCount === 2,
    conclusion: passCount === 2
      ? "支持有效分流主张"
      : passCount === 1
        ? "仅部分支持有效分流主张"
        : "未支持有效分流主张"
  };
}
