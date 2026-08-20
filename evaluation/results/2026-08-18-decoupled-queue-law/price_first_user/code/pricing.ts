import type { MethodId } from "./types";

function assertNonNegativeFinite(
  value: number | undefined,
  name: string,
): asserts value is number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}

export function capQuote(
  basePrice: number,
  postLoad: number,
  B: number,
  C: number,
): number {
  assertNonNegativeFinite(basePrice, "basePrice");
  assertNonNegativeFinite(postLoad, "postLoad");

  if (!Number.isFinite(B) || B <= 0) {
    throw new RangeError("B must be a positive finite number");
  }
  if (!Number.isFinite(C) || C <= B) {
    throw new RangeError("C must be finite and greater than B");
  }
  if (postLoad >= C) {
    throw new RangeError("postLoad must be below C");
  }
  if (postLoad <= B) {
    return basePrice;
  }

  const quote =
    basePrice * (1 + (postLoad - B) / (C - postLoad));
  if (!Number.isFinite(quote)) {
    throw new RangeError("computed quote must be finite");
  }
  return quote;
}

export function lockedUnitPrice(
  method: MethodId,
  basePrice: number,
  dynamicPrice?: number,
): number {
  assertNonNegativeFinite(basePrice, "basePrice");

  if (method !== "ours-price-first") {
    return basePrice;
  }

  assertNonNegativeFinite(dynamicPrice, "dynamicPrice");
  return dynamicPrice;
}
