import type { PerSeedRow } from "./types.js";

const T_975_DF5 = 2.5705818366147395;

export interface Summary {
  n: number;
  mean: number;
  sd: number;
  ciLow: number;
  ciHigh: number;
  pTwoSided: number;
  seedDifferences: number[];
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStandardDeviation(values: readonly number[]): number {
  const mean = average(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      (values.length - 1)
  );
}

function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7
  ];
  if (value < 0.5) {
    return Math.log(Math.PI) -
      Math.log(Math.sin(Math.PI * value)) -
      logGamma(1 - value);
  }
  let x = 0.9999999999998099;
  const shifted = value - 1;
  coefficients.forEach((coefficient, index) => {
    x += coefficient / (shifted + index + 1);
  });
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) +
    (shifted + 0.5) * Math.log(t) -
    t +
    Math.log(x);
}

function betaContinuedFraction(
  a: number,
  b: number,
  x: number
): number {
  const maxIterations = 200;
  const epsilon = 3e-14;
  const floor = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < floor) d = floor;
  d = 1 / d;
  let h = d;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const even = 2 * iteration;
    let coefficient = iteration * (b - iteration) * x /
      ((qam + even) * (a + even));
    d = 1 + coefficient * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + coefficient / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    h *= d * c;
    coefficient = -(a + iteration) * (qab + iteration) * x /
      ((a + even) * (qap + even));
    d = 1 + coefficient * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + coefficient / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return h;
}

function regularizedIncompleteBeta(
  x: number,
  a: number,
  b: number
): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const factor = Math.exp(
    logGamma(a + b) -
    logGamma(a) -
    logGamma(b) +
    a * Math.log(x) +
    b * Math.log(1 - x)
  );
  return x < (a + 1) / (a + b + 2)
    ? factor * betaContinuedFraction(a, b, x) / a
    : 1 - factor * betaContinuedFraction(b, a, 1 - x) / b;
}

export function twoSidedStudentTPValue(
  absoluteT: number,
  degreesOfFreedom: number
): number {
  if (!Number.isFinite(absoluteT)) return 0;
  if (absoluteT <= 0) return 1;
  const x = degreesOfFreedom /
    (degreesOfFreedom + absoluteT ** 2);
  return regularizedIncompleteBeta(
    x,
    degreesOfFreedom / 2,
    0.5
  );
}

export function pairedSummary(values: readonly number[]): Summary {
  if (values.length !== 6) {
    throw new Error(`Expected six seeds, received ${values.length}`);
  }
  const normalized = values.map((value) =>
    Math.abs(value) < 1e-15 ? 0 : Number(value.toFixed(12))
  );
  const mean = average(normalized);
  const sd = sampleStandardDeviation(normalized);
  const standardError = sd / Math.sqrt(normalized.length);
  const margin = T_975_DF5 * standardError;
  const statistic = standardError === 0
    ? (mean === 0 ? 0 : Number.POSITIVE_INFINITY)
    : Math.abs(mean / standardError);
  return {
    n: normalized.length,
    mean,
    sd,
    ciLow: mean - margin,
    ciHigh: mean + margin,
    pTwoSided: twoSidedStudentTPValue(statistic, 5),
    seedDifferences: normalized
  };
}

type NumericMetric = {
  [Key in keyof PerSeedRow]: PerSeedRow[Key] extends number | null
    ? Key
    : never;
}[keyof PerSeedRow];

export function pairedEffect(
  full: readonly PerSeedRow[],
  ablation: readonly PerSeedRow[],
  metric: NumericMetric,
  scale: "absolute" | "relative"
): Summary {
  const ablationBySeed = new Map(ablation.map((row) => [row.seed, row]));
  const differences = full.map((row) => {
    const match = ablationBySeed.get(row.seed);
    if (!match) throw new Error(`Missing paired seed ${row.seed}`);
    const fullValue = row[metric];
    const ablationValue = match[metric];
    if (typeof fullValue !== "number" || typeof ablationValue !== "number") {
      throw new Error(`${String(metric)}: paired value is null`);
    }
    const difference = fullValue - ablationValue;
    if (scale === "absolute") return difference;
    if (ablationValue === 0) {
      throw new Error(`${String(metric)}: relative denominator is zero`);
    }
    return difference / ablationValue;
  });
  return pairedSummary(differences);
}

export function cohortInteraction(
  price: Summary,
  quality: Summary
): Summary {
  if (price.seedDifferences.length !== quality.seedDifferences.length) {
    throw new Error("Interaction requires paired cohort seeds");
  }
  return pairedSummary(price.seedDifferences.map((value, index) =>
    value - quality.seedDifferences[index]
  ));
}

export function holmAdjust(pValues: readonly number[]): number[] {
  const ranked = pValues
    .map((p, index) => ({ p, index }))
    .sort((left, right) => left.p - right.p);
  let previous = 0;
  const adjusted = Array<number>(pValues.length);
  ranked.forEach((item, rank) => {
    previous = Math.max(
      previous,
      Math.min(1, (pValues.length - rank) * item.p)
    );
    adjusted[item.index] = previous;
  });
  return adjusted;
}
