import { describe, expect, it } from "vitest";
import { nonReducingAiUsage } from "./usage";

const persisted = {
  inputTokens: 120,
  outputTokens: 30,
  cacheReadTokens: 10,
  cacheWriteTokens: 4,
  totalTokens: 150,
  actualMicroUsd: 700,
};

describe("nonReducingAiUsage", () => {
  it("uses already accumulated usage when cancellation supplies no report", () => {
    expect(nonReducingAiUsage(persisted)).toEqual({
      input: 120,
      output: 30,
      cacheRead: 10,
      cacheWrite: 4,
      totalTokens: 150,
      microUsd: 700,
    });
  });

  it("never replaces a persisted counter with a smaller reported value", () => {
    expect(
      nonReducingAiUsage(persisted, {
        input: 100,
        output: 40,
        cacheRead: 0,
        cacheWrite: 5,
        totalTokens: 140,
        microUsd: 600,
      }),
    ).toMatchObject({
      input: 120,
      output: 40,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 150,
      microUsd: 700,
    });
  });
});
