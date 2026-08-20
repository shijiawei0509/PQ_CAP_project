export interface QueueTiming {
  queueWaitMs: number;
  endToEndTtftMs: number;
}

export function queueTiming(
  postLoad: number,
  normalCapacity: number,
  hardCapacity: number,
  baseTtftMs: number
): QueueTiming | null {
  if (!(normalCapacity > 0) || !(hardCapacity > normalCapacity)) {
    throw new Error("Invalid capacity boundaries");
  }
  if (!(baseTtftMs > 0) || !Number.isFinite(baseTtftMs)) {
    throw new Error("Base TTFT must be positive and finite");
  }
  if (!Number.isFinite(postLoad) || postLoad < 0) {
    throw new Error("Post-load must be non-negative and finite");
  }
  if (postLoad >= hardCapacity) return null;
  if (postLoad <= normalCapacity) {
    return { queueWaitMs: 0, endToEndTtftMs: baseTtftMs };
  }
  const x = (postLoad - normalCapacity) /
    (hardCapacity - normalCapacity);
  const queueWaitMs = baseTtftMs * x / (1 - x);
  return {
    queueWaitMs,
    endToEndTtftMs: baseTtftMs + queueWaitMs
  };
}
