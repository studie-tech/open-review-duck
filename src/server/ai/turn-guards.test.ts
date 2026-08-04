import { describe, expect, it } from "vitest";
import {
  acceptFirstFinalSubmission,
  boundedTurnOutput,
  clampManagedInvestigationReservation,
  estimatePendingInputTokens,
  managedInvestigationReservation,
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

  it("rejects exhausted prompt cost when completion tokens are free", () => {
    expect(
      boundedTurnOutput({
        pendingInputTokens: 2_000,
        reservedTokens: 10_000,
        consumedTokens: 0,
        reservedMicroUsd: 100,
        consumedMicroUsd: 50,
        pricing: {
          promptNanoUsdPerToken: 30,
          completionNanoUsdPerToken: 0,
        },
      }).limit,
    ).toBe("cost_limit");
  });

  it.each([
    { name: "dense ASCII", value: "a".repeat(20_000) },
    { name: "dense Unicode", value: "你好".repeat(10_000) },
  ])("conservatively reserves long $name input", ({ value }) => {
    const messages = [{ role: "user", content: value }];
    const systemPrompt = value;
    const contentBytes =
      Buffer.byteLength(JSON.stringify(messages)) +
      Buffer.byteLength(systemPrompt);

    expect(estimatePendingInputTokens(messages, systemPrompt)).toBeGreaterThan(
      contentBytes / 2 + 2_000,
    );
  });

  it("reserves repeated turns rather than only the initial prompt", () => {
    expect(
      managedInvestigationReservation({
        requestBytes: 2_000,
        kind: "explain",
        monthlyTokenLimit: 100_000,
      }),
    ).toEqual({ input: 28_000, output: 8_000, minimumTokens: 13_000 });
  });

  it("scales free-tier reservations below the complete monthly allowance", () => {
    const reservation = managedInvestigationReservation({
      requestBytes: 9_000,
      kind: "review",
      monthlyTokenLimit: 100_000,
    });

    expect(reservation).toEqual({
      input: 42_000,
      output: 16_000,
      minimumTokens: 13_000,
    });
  });

  it("includes bounded prior conversation in the viable turn floor", () => {
    const reservation = managedInvestigationReservation({
      requestBytes: 67_000,
      minimumInputBytes: 64_000 + 12_000,
      kind: "explain",
      monthlyTokenLimit: 100_000,
    });

    expect(reservation.minimumTokens).toBe(77_000);
    expect(reservation.input + reservation.output).toBe(80_000);
  });

  it("keeps headroom for another job in the monthly allowance", () => {
    const reservation = managedInvestigationReservation({
      requestBytes: 1_000_000,
      kind: "review",
      monthlyTokenLimit: 100_000,
    });

    expect(reservation.input + reservation.output).toBe(80_000);
  });

  it("clamps a job to remaining quota while preserving useful input room", () => {
    expect(
      clampManagedInvestigationReservation(
        { input: 42_000, output: 16_000, minimumTokens: 13_000 },
        30_000,
      ),
    ).toEqual({ input: 29_000, output: 1_000 });
  });

  it("rejects a clamped job below its viable initial-turn floor", () => {
    expect(
      clampManagedInvestigationReservation(
        { input: 42_000, output: 16_000, minimumTokens: 13_000 },
        12_999,
      ),
    ).toBeUndefined();
  });
});
