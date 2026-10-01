import { describe, expect, it } from "vitest";
import { evalCaseSchema, evalMetrics } from "./evaluations";

describe("evaluation metrics", () => {
  it("uses negative cases as the false positive rate denominator", () => {
    expect(
      evalMetrics([
        { label: "bug", prediction: "report" },
        { label: "bug", prediction: "report" },
        { label: "bug", prediction: "suppress" },
        { label: "false_positive", prediction: "report" },
        { label: "false_positive", prediction: "suppress" },
      ]),
    ).toEqual({
      tp: 2,
      fp: 1,
      fn: 1,
      tn: 1,
      excluded: 0,
      graded: 5,
      precision: 2 / 3,
      recall: 2 / 3,
      falsePositiveRate: 1 / 2,
    });
  });
  it("excludes provider failures, unknown labels, and ungraded matches", () => {
    expect(
      evalMetrics([
        { label: "bug", prediction: "error" },
        { label: "unlabeled", prediction: "report" },
        { label: "false_positive", prediction: "ungraded" },
      ]),
    ).toMatchObject({
      graded: 0,
      excluded: 3,
      precision: null,
      recall: null,
      falsePositiveRate: null,
    });
  });
  it("does not turn missing denominators into 100 percent", () => {
    expect(
      evalMetrics([{ label: "false_positive", prediction: "suppress" }]),
    ).toMatchObject({ precision: null, recall: null, falsePositiveRate: 0 });
  });
  it("rejects empty and excessive context", () => {
    const example = {
      title: "Bug",
      path: "a.ts",
      source: "a".repeat(100_001),
      finding: "Bug",
      label: "bug",
    };
    expect(evalCaseSchema.safeParse(example).success).toBe(false);
    expect(evalCaseSchema.safeParse({ ...example, source: "" }).success).toBe(
      false,
    );
    expect(
      evalCaseSchema.safeParse({ ...example, source: "x", title: " " }).success,
    ).toBe(false);
  });
});
