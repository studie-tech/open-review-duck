import { describe, expect, it } from "vitest";
import {
  buildReviewHierarchy,
  createReviewNavigationHistory,
  deletedFileSignOffUnits,
  nextPendingReviewIndex,
  nextPendingReviewIndexPreferring,
  optimisticallySignOffReviewUnit,
  optimisticallySignOffReviewUnits,
  pushReviewNavigationHistory,
  restoreReviewUnitAfterFailedSignOff,
  reviewNavigationHistoryTarget,
  reviewPathSearchMatches,
  reviewPathSections,
} from "./review-navigation";

describe("nextPendingReviewIndex", () => {
  it("returns the earliest outstanding unit in the planned review order", () => {
    expect(
      nextPendingReviewIndex([
        { status: "signed_off" },
        { status: "changed" },
        { status: "pending" },
      ]),
    ).toBe(1);
  });

  it("does not depend on which unit was selected out of order", () => {
    expect(
      nextPendingReviewIndex([
        { status: "pending" },
        { status: "signed_off" },
        { status: "signed_off" },
      ]),
    ).toBe(0);
  });

  it("returns -1 when every unit is signed off", () => {
    expect(
      nextPendingReviewIndex([
        { status: "signed_off" },
        { status: "signed_off" },
      ]),
    ).toBe(-1);
  });

  it("skips units that are waiting for a provider response", () => {
    expect(
      nextPendingReviewIndex([
        { status: "signed_off" },
        { status: "waiting" },
        { status: "changed" },
      ]),
    ).toBe(2);
  });

  it("can continue within a filtered subset without changing canonical order", () => {
    const units = [
      {
        name: "unrelated",
        path: "src/other.ts",
        kind: "function",
        status: "pending" as const,
      },
      {
        name: "first test",
        path: "src/example.test.ts",
        kind: "test",
        status: "signed_off" as const,
      },
      {
        name: "second test",
        path: "src/example.test.ts",
        kind: "test",
        status: "pending" as const,
      },
    ];

    expect(
      nextPendingReviewIndex(units, (unit) =>
        reviewPathSearchMatches(unit, "example.test.ts"),
      ),
    ).toBe(2);
  });
});

describe("nextPendingReviewIndexPreferring", () => {
  it("moves past deletion fragments after whole-file deletions are signed off", () => {
    const units = [
      { changeType: "deleted", status: "signed_off" as const },
      { changeType: "deleted", status: "pending" as const },
      { changeType: "modified", status: "pending" as const },
    ];

    expect(
      nextPendingReviewIndexPreferring(
        units,
        (unit) => unit.changeType !== "deleted",
      ),
    ).toBe(2);
  });

  it("falls back to a deletion when it is the only remaining work", () => {
    const units = [
      { changeType: "deleted", status: "pending" as const },
      { changeType: "modified", status: "signed_off" as const },
    ];

    expect(
      nextPendingReviewIndexPreferring(
        units,
        (unit) => unit.changeType !== "deleted",
      ),
    ).toBe(0);
  });
});

describe("optimisticallySignOffReviewUnit", () => {
  it("updates only the selected unit without mutating the prior state", () => {
    const units = [
      {
        id: "first",
        status: "changed" as const,
        changedSinceSignOff: true,
      },
      {
        id: "second",
        status: "pending" as const,
        changedSinceSignOff: false,
      },
    ];

    const updated = optimisticallySignOffReviewUnit(units, "first");

    expect(updated).toEqual([
      {
        id: "first",
        status: "signed_off",
        changedSinceSignOff: false,
      },
      units[1],
    ]);
    expect(units[0]?.status).toBe("changed");
  });

  it("preserves the existing state when the unit no longer exists", () => {
    const units = [
      {
        id: "first",
        status: "pending" as const,
        changedSinceSignOff: false,
      },
    ];

    expect(optimisticallySignOffReviewUnit(units, "missing")).toBe(units);
  });

  it("signs off several selected units in one immutable update", () => {
    const units = [
      {
        id: "first",
        status: "changed" as const,
        changedSinceSignOff: true,
      },
      {
        id: "second",
        status: "pending" as const,
        changedSinceSignOff: false,
      },
      {
        id: "third",
        status: "pending" as const,
        changedSinceSignOff: false,
      },
    ];

    expect(optimisticallySignOffReviewUnits(units, ["first", "third"])).toEqual(
      [
        {
          id: "first",
          status: "signed_off",
          changedSinceSignOff: false,
        },
        units[1],
        {
          id: "third",
          status: "signed_off",
          changedSinceSignOff: false,
        },
      ],
    );
    expect(units[0]?.status).toBe("changed");
  });

  it("rolls back only the failed unit after later optimistic saves", () => {
    type Unit = {
      id: string;
      status: "pending" | "signed_off" | "changed" | "waiting";
      changedSinceSignOff: boolean;
    };
    const original: Unit = {
      id: "first",
      status: "changed",
      changedSinceSignOff: true,
    };
    const current: Unit[] = [
      {
        ...original,
        status: "signed_off",
        changedSinceSignOff: false,
      },
      {
        id: "second",
        status: "signed_off",
        changedSinceSignOff: false,
      },
    ];

    expect(restoreReviewUnitAfterFailedSignOff(current, original)).toEqual([
      original,
      current[1],
    ]);
  });
});

describe("deletedFileSignOffUnits", () => {
  it("selects actionable units only when their entire file was deleted", () => {
    const units = [
      { path: "removed.ts", status: "pending" as const },
      { path: "removed.ts", status: "changed" as const },
      { path: "removed.ts", status: "signed_off" as const },
      { path: "removed.ts", status: "waiting" as const },
      { path: "modified.ts", status: "pending" as const },
    ];

    expect(
      deletedFileSignOffUnits(units, [
        { path: "removed.ts", changeType: "deleted" },
        { path: "modified.ts", changeType: "modified" },
      ]),
    ).toEqual([units[0], units[1]]);
  });
});

describe("reviewPathSections", () => {
  const units = [
    { id: "reviewed-before", status: "signed_off" as const },
    { id: "pending-before", status: "pending" as const },
    { id: "current", status: "changed" as const },
    { id: "reviewed-after", status: "signed_off" as const },
    { id: "waiting-after", status: "waiting" as const },
    { id: "pending-after", status: "pending" as const },
  ];

  it("anchors the current unit without rotating the planned review order", () => {
    const sections = reviewPathSections(units, 2);

    expect(sections.current?.unit.id).toBe("current");
    expect(sections.upcoming.map(({ unit }) => unit.id)).toEqual([
      "pending-before",
      "pending-after",
    ]);
    expect(sections.waiting.map(({ unit }) => unit.id)).toEqual([
      "waiting-after",
    ]);
    expect(
      sections.reviewed.length +
        sections.waiting.length +
        sections.upcoming.length +
        (sections.current ? 1 : 0),
    ).toBe(units.length);
  });

  it("keeps earlier planned units at the top after out-of-order navigation", () => {
    const sections = reviewPathSections(units, 5);

    expect(sections.current?.unit.id).toBe("pending-after");
    expect(sections.upcoming.map(({ unit }) => unit.id)).toEqual([
      "pending-before",
      "current",
    ]);
  });

  it("keeps signed-off units available without duplicating a reviewed current unit", () => {
    const sections = reviewPathSections(units, 3);

    expect(sections.current?.unit.id).toBe("reviewed-after");
    expect(sections.reviewed.map(({ unit }) => unit.id)).toEqual([
      "reviewed-before",
    ]);
  });
});

describe("buildReviewHierarchy", () => {
  it("groups independent concepts and claims shared dependencies once", () => {
    const hierarchy = buildReviewHierarchy([
      { id: "shared", dependencies: [] },
      { id: "alpha-leaf", dependencies: ["shared"] },
      { id: "alpha", dependencies: ["alpha-leaf"] },
      { id: "beta-leaf", dependencies: ["shared"] },
      { id: "beta", dependencies: ["beta-leaf"] },
    ]);

    expect(hierarchy.map(({ unit }) => unit.id)).toEqual(["alpha", "beta"]);
    expect(hierarchy[0]?.children[0]?.unit.id).toBe("alpha-leaf");
    expect(hierarchy[0]?.children[0]?.children[0]?.unit.id).toBe("shared");
    expect(hierarchy[1]?.children[0]?.unit.id).toBe("beta-leaf");
    expect(hierarchy[1]?.children[0]?.children).toEqual([]);
  });
});

describe("review navigation history", () => {
  it("returns to the unit visited immediately before an automatic advance", () => {
    const started = createReviewNavigationHistory("unit-a");
    const advanced = pushReviewNavigationHistory(started, "unit-b");
    const back = reviewNavigationHistoryTarget(advanced, -1);

    expect(back?.unitId).toBe("unit-a");
    expect(
      reviewNavigationHistoryTarget(back?.history ?? advanced, 1)?.unitId,
    ).toBe("unit-b");
  });

  it("discards forward history after navigating to a different unit", () => {
    const visited = pushReviewNavigationHistory(
      pushReviewNavigationHistory(
        createReviewNavigationHistory("unit-a"),
        "unit-b",
      ),
      "unit-c",
    );
    const back = reviewNavigationHistoryTarget(visited, -1);
    const branched = pushReviewNavigationHistory(
      back?.history ?? visited,
      "unit-x",
    );

    expect(branched.unitIds).toEqual(["unit-a", "unit-b", "unit-x"]);
    expect(reviewNavigationHistoryTarget(branched, 1)).toBeUndefined();
  });
});
