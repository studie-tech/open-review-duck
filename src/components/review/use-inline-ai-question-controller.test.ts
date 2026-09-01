import { describe, expect, it } from "vitest";
import { closestReviewLine } from "./use-inline-ai-question-controller";

describe("closestReviewLine", () => {
  it("keeps a line that is already inside a disjoint review range", () => {
    expect(
      closestReviewLine(
        24,
        [
          { startLine: 10, endLine: 14 },
          { startLine: 22, endLine: 28 },
        ],
        1,
        40,
      ),
    ).toBe(24);
  });

  it("chooses the nearest range edge for a line between ranges", () => {
    const ranges = [
      { startLine: 10, endLine: 14 },
      { startLine: 22, endLine: 28 },
    ];
    expect(closestReviewLine(17, ranges, 1, 40)).toBe(14);
    expect(closestReviewLine(20, ranges, 1, 40)).toBe(22);
  });

  it("uses the unit bounds when no related ranges are available", () => {
    expect(closestReviewLine(4, undefined, 8, 12)).toBe(8);
    expect(closestReviewLine(15, undefined, 8, 12)).toBe(12);
  });
});
