import { describe, expect, it } from "vitest";
import {
  constrainAnnotationToChangedLines,
  explanationChangedLineRanges,
} from "./change-scope";

describe("AI explanation change scope", () => {
  it("targets only changed head lines inside a large language-neutral unit", () => {
    expect(
      explanationChangedLineRanges({
        changeType: "modified",
        startLine: 100,
        endLine: 106,
        previousSource: [
          "function run() {",
          "  prepare();",
          "  oldStep();",
          "  retain();",
          "  oldFinish();",
          "  return true;",
          "}",
        ].join("\n"),
        source: [
          "function run() {",
          "  prepare();",
          "  newStep();",
          "  retain();",
          "  newFinish();",
          "  return true;",
          "}",
        ].join("\n"),
      }),
    ).toEqual([
      { startLine: 102, endLine: 102 },
      { startLine: 104, endLine: 104 },
    ]);
  });

  it("treats additions and removals as wholly changed review scope", () => {
    const unit = {
      startLine: 20,
      endLine: 24,
      source: "one\ntwo\nthree\nfour\nfive",
      previousSource: null,
    };
    expect(
      explanationChangedLineRanges({ ...unit, changeType: "added" }),
    ).toEqual([{ startLine: 20, endLine: 24 }]);
    expect(
      explanationChangedLineRanges({ ...unit, changeType: "deleted" }),
    ).toEqual([{ startLine: 20, endLine: 24 }]);
  });

  it("drops context-only annotations and clips partial ranges to the change", () => {
    const ranges = [{ startLine: 40, endLine: 42 }];
    expect(
      constrainAnnotationToChangedLines(
        { line: 12, endLine: 18, title: "Context" },
        ranges,
      ),
    ).toBeNull();
    expect(
      constrainAnnotationToChangedLines(
        { line: 38, endLine: 45, title: "Changed behavior" },
        ranges,
      ),
    ).toEqual({
      line: 40,
      endLine: 42,
      title: "Changed behavior",
    });
  });
});
