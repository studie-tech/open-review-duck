import { describe, expect, it } from "vitest";
import { persistedUnitSourceRange, sourceRange } from "./source-range";

describe("persisted review-unit source ranges", () => {
  it("slices deleted units from the base object", () => {
    const current = Array.from(
      { length: 373 },
      (_, index) => `head ${index + 1}`,
    ).join("\n");
    const previous = Array.from(
      { length: 1_100 },
      (_, index) => `base ${index + 1}`,
    ).join("\n");

    const range = persistedUnitSourceRange(
      { content: current, previousContent: previous },
      {
        changeType: "deleted",
        startLine: 978,
        endLine: 1_058,
        previousStartLine: 978,
        previousEndLine: 1_058,
      },
    );

    expect(range.objectSide).toBe("previous");
    expect(
      Buffer.from(previous).subarray(range.startByte, range.endByte).toString(),
    ).toContain("base 978");
    expect(
      Buffer.from(previous).subarray(range.startByte, range.endByte).toString(),
    ).toContain("base 1058");
  });

  it("keeps modified units on the head object", () => {
    const range = persistedUnitSourceRange(
      { content: "first\nsecond\nthird", previousContent: "old" },
      {
        changeType: "modified",
        startLine: 2,
        endLine: 2,
        previousStartLine: 1,
        previousEndLine: 1,
      },
    );

    expect(range).toEqual({
      objectSide: "current",
      ...sourceRange("first\nsecond\nthird", 2, 2),
    });
  });

  it("uses the provider content for a deleted file without a separate base object", () => {
    expect(
      persistedUnitSourceRange(
        { content: "removed declaration" },
        {
          changeType: "deleted",
          startLine: 1,
          endLine: 1,
          previousStartLine: 1,
          previousEndLine: 1,
        },
      ).objectSide,
    ).toBe("current");
  });
});
