import { describe, expect, it } from "vitest";
import {
  EXCLUDED_ROUTER_TASK_TYPES,
  ROUTER_TASK_TYPES,
  runTasksSequentially,
  summarizeRecords,
  type RouterBenchmarkTask
} from "../benchmarks/router_accuracy/real-runner.js";
import type { RequestProfile } from "../server/types.js";

function task(id: string, taskType: "coding" | "math" | "reasoning"): RouterBenchmarkTask {
  return {
    id,
    prompt: id,
    maxOutputTokens: 128,
    expectedProfile: {
      taskType,
      difficulty: "easy",
      requirements: {
        needsVision: false,
        needsTools: false,
        needsJsonOutput: false,
        minContextTokensLowerBound: 129
      }
    }
  };
}

const profile: RequestProfile = {
  taskType: "coding",
  difficulty: "easy",
  requirements: {
    minContextTokens: 129,
    needsVision: false,
    needsTools: false,
    needsJsonOutput: false,
    contextPattern: "single"
  },
  confidence: 0.9,
  source: "auto"
};

describe("real Router benchmark runner", () => {
  it("uses six semantic task types and excludes the historical long-context category", () => {
    expect(ROUTER_TASK_TYPES).toHaveLength(6);
    expect(ROUTER_TASK_TYPES).not.toContain("long-context");
    expect(EXCLUDED_ROUTER_TASK_TYPES).toEqual(["long-context"]);
  });

  it("runs strictly sequentially, records a failure, and continues exactly once", async () => {
    const tasks = [task("one", "coding"), task("two", "math"), task("three", "reasoning")];
    const calls: string[] = [];
    const saved: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const records = await runTasksSequentially(tasks, async (current) => {
      calls.push(current.id);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      if (current.id === "two") throw new Error("upstream failed");
      return { ...profile, taskType: current.expectedProfile.taskType };
    }, (record) => saved.push(record.taskId));

    expect(calls).toEqual(["one", "two", "three"]);
    expect(saved).toEqual(calls);
    expect(maxInFlight).toBe(1);
    expect(records.map((record) => record.ok)).toEqual([true, false, true]);
    expect(records[1].error?.message).toBe("upstream failed");
  });

  it("scores failures as misses without dropping them from the denominator", async () => {
    const tasks = [task("one", "coding"), task("two", "math")];
    const records = await runTasksSequentially(tasks, async (current) => {
      if (current.id === "two") throw new Error("failed");
      return profile;
    }, () => undefined);
    const summary = summarizeRecords(records);

    expect(summary).toMatchObject({ total: 2, succeeded: 1, failed: 1, failureRate: 0.5 });
    expect(summary.taskType.accuracy).toBe(0.5);
    expect(summary.difficulty.accuracy).toBe(0.5);
  });
});
