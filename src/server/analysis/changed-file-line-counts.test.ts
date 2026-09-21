import { describe, expect, it } from "vitest";
import { changedFileLineCounts } from "./engine";

describe("changedFileLineCounts", () => {
  it("counts the lines a revision changed in one file", () => {
    const previous = ["one", "two", "three"].join("\n");

    expect(
      changedFileLineCounts({
        changeType: "renamed",
        content: previous,
        previousContent: previous,
      }),
    ).toEqual({ additions: 0, deletions: 0 });
    expect(
      changedFileLineCounts({
        changeType: "modified",
        content: ["one", "2", "three", "four"].join("\n"),
        previousContent: previous,
      }),
    ).toEqual({ additions: 2, deletions: 1 });
    expect(
      changedFileLineCounts({ changeType: "added", content: previous }),
    ).toEqual({ additions: 3, deletions: 0 });
    expect(
      changedFileLineCounts({ changeType: "deleted", content: previous }),
    ).toEqual({ additions: 0, deletions: 3 });
    expect(
      changedFileLineCounts({
        changeType: "modified",
        content: "",
        previousContent: previous,
        skipReason: "too_large",
      }),
    ).toEqual({ additions: 0, deletions: 0 });
  });
});
