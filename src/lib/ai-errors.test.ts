import { describe, expect, it } from "vitest";
import { aiErrorPresentation } from "./ai-errors";

describe("aiErrorPresentation", () => {
  it("upgrades opaque fetch failures into actionable copy", () => {
    expect(aiErrorPresentation("fetch failed")).toEqual({
      title: "AI service unavailable",
      detail:
        "The explanation service could not be reached. Try again now. If you self-host ReviewDuck, start it with make start.",
    });
  });

  it("presents provider failures without discarding their detail", () => {
    expect(aiErrorPresentation("Invalid model deployment")).toEqual({
      title: "Explanation failed",
      detail: "Invalid model deployment",
    });
  });
});
