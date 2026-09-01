import { describe, expect, it } from "vitest";
import { addAiUsage, nonReducingAiUsage, providerUsage } from "./usage";

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

describe("providerUsage", () => {
  it("normalizes optional token details and OpenRouter cost", () => {
    expect(
      providerUsage({
        usage: {
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16,
        },
        providerMetadata: { openrouter: { usage: { cost: 0.000_001_2 } } },
      }),
    ).toEqual({
      input: 12,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 16,
      microUsd: 2,
    });
  });

  it("adds usage from multiple provider calls", () => {
    expect(
      addAiUsage(
        {
          input: 10,
          output: 3,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 13,
          microUsd: 4,
        },
        {
          input: 7,
          output: 5,
          cacheRead: 1,
          cacheWrite: 0,
          totalTokens: 12,
        },
      ),
    ).toEqual({
      input: 17,
      output: 8,
      cacheRead: 3,
      cacheWrite: 1,
      totalTokens: 25,
      microUsd: 4,
    });
  });
});
