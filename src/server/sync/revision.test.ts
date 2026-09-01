import { describe, expect, it } from "vitest";
import {
  assertCompleteChangedFileSet,
  reviewSnapshotCanBeReused,
} from "./revision";

describe("reviewSnapshotCanBeReused", () => {
  const snapshot = {
    analysisVersion: 25,
    baseSha: "base",
    createdAt: new Date("2026-08-10T00:00:00Z"),
    headSha: "head",
  };
  const cutoff = new Date("2026-08-01T00:00:00Z");

  it("keeps an unchanged, current snapshot on the metadata-only path", () => {
    expect(
      reviewSnapshotCanBeReused(
        snapshot,
        { headSha: "head", baseSha: "base" },
        25,
        cutoff,
      ),
    ).toBe(true);
  });

  it("rebuilds changed, stale-analysis, and retention-expired snapshots", () => {
    expect(
      reviewSnapshotCanBeReused(
        snapshot,
        { headSha: "new-head", baseSha: "base" },
        25,
        cutoff,
      ),
    ).toBe(false);
    expect(
      reviewSnapshotCanBeReused(
        snapshot,
        { headSha: "head", baseSha: "base" },
        26,
        cutoff,
      ),
    ).toBe(false);
    expect(
      reviewSnapshotCanBeReused(
        snapshot,
        { headSha: "head", baseSha: "base" },
        25,
        new Date("2026-08-11T00:00:00Z"),
      ),
    ).toBe(false);
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
