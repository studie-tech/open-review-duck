import { describe, expect, it, vi } from "vitest";
import { DEEP_REVIEW_UNENTITLED_MESSAGE } from "~/server/ai/service";
import { mapAiStartError, SAFE_AI_START_MESSAGES } from "./start-errors";

const fallback = "Could not start the AI assistant. Try again.";

describe("mapAiStartError", () => {
  it("forwards the imported entitlement message, not a retyped copy", () => {
    expect(SAFE_AI_START_MESSAGES.has(DEEP_REVIEW_UNENTITLED_MESSAGE)).toBe(
      true,
    );
    expect(
      mapAiStartError(new Error(DEEP_REVIEW_UNENTITLED_MESSAGE), fallback),
    ).toBe(DEEP_REVIEW_UNENTITLED_MESSAGE);
  });

  it("forwards shared policy failures from either start path", () => {
    expect(
      mapAiStartError(
        new Error("The managed SaaS model is not configured"),
        fallback,
      ),
    ).toBe("The managed SaaS model is not configured");
    expect(mapAiStartError(new Error("Pull request not found"), fallback)).toBe(
      "Pull request not found",
    );
    expect(
      mapAiStartError(new Error("No review snapshot found"), fallback),
    ).toBe("No review snapshot found");
  });

  it("accepts caller extras as additions to the shared set", () => {
    const budget = "Workspace monthly AI budget is exhausted";
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(SAFE_AI_START_MESSAGES.has(budget)).toBe(false);
    expect(mapAiStartError(new Error(budget), fallback, [budget])).toBe(budget);
    expect(mapAiStartError(new Error(budget), fallback)).toBe(fallback);
    error.mockRestore();
  });

  it("does not launder unknown failures into a policy message", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(
      mapAiStartError(new Error("relation ai_jobs does not exist"), fallback),
    ).toBe(fallback);
    expect(mapAiStartError("not-an-error", fallback)).toBe(fallback);
    error.mockRestore();
  });
});
