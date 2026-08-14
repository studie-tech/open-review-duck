import { describe, expect, it } from "vitest";
import {
  MAX_SIGN_OFF_UNDO_ENTRIES,
  nextUndoableSignOff,
  type ReviewViewSnapshot,
  rememberSignOff,
  type SignOffUndoEntry,
  signOffUndoTarget,
} from "./sign-off-undo";

const view: ReviewViewSnapshot = {
  contextAfter: 0,
  contextBefore: 0,
  pathSearch: "",
  scrollTop: 0,
  searchLimit: 20,
  showDiff: true,
  unitIndex: 3,
};

/** Builds one recorded unit sign-off for the history under test. */
function unitEntry(unitId: string): SignOffUndoEntry {
  return { kind: "unit", label: unitId, unitIds: [unitId], view };
}

/** Builds one recorded concept sign-off for the history under test. */
function conceptEntry(
  conceptId: string,
  unitIds: string[],
  layoutVersion = 1,
): SignOffUndoEntry {
  return {
    kind: "concept",
    conceptId,
    label: conceptId,
    layoutId: "layout",
    layoutVersion,
    unitIds,
    view,
  };
}

const layout = { id: "layout", version: 1 };

describe("sign-off undo history", () => {
  it("puts the newest sign-off first", () => {
    const history = rememberSignOff(
      rememberSignOff([], unitEntry("one")),
      unitEntry("two"),
    );

    expect(history.map(({ label }) => label)).toEqual(["two", "one"]);
  });

  it("forgets the oldest sign-off once the history is full", () => {
    const history = Array.from({ length: 40 }).reduce<SignOffUndoEntry[]>(
      (current, _entry, index) =>
        rememberSignOff(current, unitEntry(`unit-${index}`)),
      [],
    );

    expect(history).toHaveLength(MAX_SIGN_OFF_UNDO_ENTRIES);
    expect(history.at(0)?.label).toBe("unit-39");
    expect(history.at(-1)?.label).toBe(
      `unit-${40 - MAX_SIGN_OFF_UNDO_ENTRIES}`,
    );
  });

  it("offers the newest step and keeps the ones below it", () => {
    const history = [unitEntry("two"), unitEntry("one")];
    const units = [
      { id: "one", status: "signed_off" },
      { id: "two", status: "signed_off" },
    ];

    const undoable = nextUndoableSignOff(history, units);

    expect(undoable?.entry.label).toBe("two");
    expect(undoable?.remaining.map(({ label }) => label)).toEqual(["one"]);
  });

  it("skips a unit already returned to the queue another way", () => {
    const history = [unitEntry("two"), unitEntry("one")];
    const units = [
      { id: "one", status: "signed_off" },
      { id: "two", status: "pending" },
    ];

    const undoable = nextUndoableSignOff(history, units);

    expect(undoable?.entry.label).toBe("one");
    expect(undoable?.remaining).toEqual([]);
  });

  it("skips a step whose units left the snapshot", () => {
    const history = [unitEntry("gone"), unitEntry("one")];
    const units = [{ id: "one", status: "signed_off" }];

    expect(nextUndoableSignOff(history, units)?.entry.label).toBe("one");
  });

  it("undoes a concept while any one of its members is still signed off", () => {
    const history = [conceptEntry("concept", ["one", "two"])];
    const units = [
      { id: "one", status: "waiting" },
      { id: "two", status: "signed_off" },
    ];

    expect(nextUndoableSignOff(history, units)?.entry.label).toBe("concept");
  });

  it("undoes a concept as a concept while its layout is still active", () => {
    expect(signOffUndoTarget(conceptEntry("concept", ["one"]), layout)).toEqual(
      {
        kind: "concept",
        conceptId: "concept",
        layoutId: "layout",
        layoutVersion: 1,
      },
    );
  });

  it("falls back to the units when the layout it was signed off under is gone", () => {
    const entry = conceptEntry("concept", ["one", "two"]);

    // The reviewer's first sign-off replaces a shared baseline layout with a
    // personal copy, and every concept id in it is new.
    expect(signOffUndoTarget(entry, { id: "personal", version: 1 })).toEqual({
      kind: "units",
      unitIds: ["one", "two"],
    });
    expect(signOffUndoTarget(entry, { id: "layout", version: 2 })).toEqual({
      kind: "units",
      unitIds: ["one", "two"],
    });
    expect(signOffUndoTarget(entry)).toEqual({
      kind: "units",
      unitIds: ["one", "two"],
    });
  });

  it("undoes a unit step through its units", () => {
    expect(signOffUndoTarget(unitEntry("one"), layout)).toEqual({
      kind: "units",
      unitIds: ["one"],
    });
  });

  it("offers nothing when no recorded step still stands", () => {
    const history = [unitEntry("one")];

    expect(nextUndoableSignOff([], [])).toBeUndefined();
    expect(
      nextUndoableSignOff(history, [{ id: "one", status: "pending" }]),
    ).toBeUndefined();
  });
});
