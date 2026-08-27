import { describe, expect, it } from "vitest";
import {
  buildReviewFileTree,
  filterReviewFiles,
  reviewFileEntries,
} from "./review-files";

const files = [
  {
    id: "one",
    path: "src/review/one.ts",
    previousPath: null,
    changeType: "modified",
    additions: 4,
    deletions: 1,
    isBinary: false,
    skipReason: null,
  },
  {
    id: "two",
    path: "src/two.ts",
    previousPath: null,
    changeType: "added",
    additions: 2,
    deletions: 0,
    isBinary: false,
    skipReason: null,
  },
  {
    id: "asset",
    path: "public/duck.png",
    previousPath: null,
    changeType: "modified",
    additions: 0,
    deletions: 0,
    isBinary: true,
    skipReason: null,
  },
];

const units = [
  {
    id: "reviewed",
    path: "src/review/one.ts",
    status: "signed_off",
    revisionState: "unchanged" as const,
  },
  {
    id: "updated",
    path: "src/review/one.ts",
    status: "changed",
    revisionState: "updated" as const,
  },
  {
    id: "new",
    path: "src/two.ts",
    status: "pending",
    revisionState: "new" as const,
  },
];

describe("reviewFileEntries", () => {
  it("derives file completion without inventing a file ledger", () => {
    const entries = reviewFileEntries(files, units);
    expect(entries[1]).toMatchObject({
      path: "src/review/one.ts",
      reviewedUnits: 1,
      totalUnits: 2,
      updatedUnits: 1,
      state: "partial",
    });
    expect(entries[0]).toMatchObject({
      path: "public/duck.png",
      totalUnits: 0,
      state: "empty",
    });
  });

  it("keeps revision attention independent from review progress", () => {
    const newUnit = units[2];
    if (!newUnit) throw new Error("Missing new unit fixture");
    const entries = reviewFileEntries(files, [
      ...units.filter(({ id }) => id !== "new"),
      { ...newUnit, status: "signed_off" },
    ]);
    expect(entries.find(({ id }) => id === "two")).toMatchObject({
      state: "reviewed",
      newUnits: 1,
    });
  });
});

describe("review file browsing", () => {
  it("builds nested repository folders with aggregate progress", () => {
    const tree = buildReviewFileTree(reviewFileEntries(files, units));
    const source = tree.find(
      (node) => node.kind === "directory" && node.path === "src",
    );
    expect(source).toMatchObject({
      reviewedUnits: 1,
      totalUnits: 3,
      attentionUnits: 2,
    });
  });

  it("filters new and updated files without hiding zero-unit files from All", () => {
    const entries = reviewFileEntries(files, units);
    expect(
      filterReviewFiles(entries, "attention", "").map(({ id }) => id),
    ).toEqual(["one", "two"]);
    expect(
      filterReviewFiles(entries, "all", "duck").map(({ id }) => id),
    ).toEqual(["asset"]);
  });
});
