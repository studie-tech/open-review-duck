import { describe, expect, it } from "vitest";
import {
  acceptFirstFinalSubmission,
  boundedTurnOutput,
  estimatePendingInputTokens,
} from "./turn-guards";

describe("AI turn guards", () => {
  it("preserves the first valid final submission", () => {
    const submission: { value: { summary: string } | undefined } = {
      value: undefined,
    };

    expect(acceptFirstFinalSubmission(submission, { summary: "first" })).toBe(
      true,
    );
    expect(acceptFirstFinalSubmission(submission, { summary: "later" })).toBe(
      false,
    );
    expect(submission.value).toEqual({ summary: "first" });
  });

  it("reserves pending input before capping output tokens", () => {
    expect(
      boundedTurnOutput({
        pendingInputTokens: 4_000,
        reservedTokens: 10_000,
        consumedTokens: 2_500,
        reservedMicroUsd: 0,
        consumedMicroUsd: 0,
      }),
    ).toEqual({ maxOutputTokens: 3_500 });
  });

  it("rejects a turn whose pending input exhausts its cost reservation", () => {
    expect(
      boundedTurnOutput({
        pendingInputTokens: 2_000,
        reservedTokens: 10_000,
        consumedTokens: 0,
        reservedMicroUsd: 100,
        consumedMicroUsd: 50,
        pricing: {
          promptNanoUsdPerToken: 30,
          completionNanoUsdPerToken: 60,
        },
      }).limit,
    ).toBe("cost_limit");
  });

  it("accounts for the full serialized conversation and system prompt", () => {
    expect(
      estimatePendingInputTokens(
        [{ role: "user", content: "investigate" }],
        "system",
      ),
    ).toBeGreaterThan(1_500);
  });
});
