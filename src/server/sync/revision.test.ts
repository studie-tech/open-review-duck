import { describe, expect, it } from "vitest";
import {
  assertCompleteChangedFileSet,
  pullRequestRevisionChanged,
  reviewAnalysisNeedsRefresh,
} from "./revision";

describe("pullRequestRevisionChanged", () => {
  it("keeps an unchanged revision cheap to poll", () => {
    expect(
      pullRequestRevisionChanged(
        { headSha: "head", baseSha: "base" },
        { headSha: "head", baseSha: "base" },
      ),
    ).toBe(false);
  });

  it("detects head and base branch changes", () => {
    expect(
      pullRequestRevisionChanged(
        { headSha: "head", baseSha: "base" },
        { headSha: "new-head", baseSha: "base" },
      ),
    ).toBe(true);
    expect(
      pullRequestRevisionChanged(
        { headSha: "head", baseSha: "base" },
        { headSha: "head", baseSha: "new-base" },
      ),
    ).toBe(true);
  });
});

describe("reviewAnalysisNeedsRefresh", () => {
  it("rebuilds missing and stale snapshots even when the Git revision is unchanged", () => {
    expect(reviewAnalysisNeedsRefresh(undefined, 25)).toBe(true);
    expect(reviewAnalysisNeedsRefresh(null, 25)).toBe(true);
    expect(reviewAnalysisNeedsRefresh(24, 25)).toBe(true);
    expect(reviewAnalysisNeedsRefresh(25, 25)).toBe(false);
  });
});

describe("assertCompleteChangedFileSet", () => {
  it("accepts complete and provider-count-unknown responses", () => {
    expect(() =>
      assertCompleteChangedFileSet(
        { additions: 2, deletions: 1, changedFiles: 2 },
        2,
      ),
    ).not.toThrow();
    expect(() =>
      assertCompleteChangedFileSet(
        { additions: 2, deletions: 1, changedFiles: 0 },
        2,
      ),
    ).not.toThrow();
  });

  it("fails closed when provider data cannot cover every changed file", () => {
    expect(() =>
      assertCompleteChangedFileSet(
        { additions: 3, deletions: 1, changedFiles: 2 },
        1,
      ),
    ).toThrow("refusing to prepare an incomplete review");
    expect(() =>
      assertCompleteChangedFileSet(
        { additions: 3, deletions: 1, changedFiles: 0 },
        0,
      ),
    ).toThrow("refusing to prepare an incomplete review");
  });
});
