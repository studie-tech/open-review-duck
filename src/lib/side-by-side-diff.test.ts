import { describe, expect, it } from "vitest";
import {
  compactSideBySideDiff,
  currentChangedLineIndexes,
  sideBySideDiff,
  sourceByteOffsetLine,
  focusedRowSpan,
  sourceEndLine,
  sourceStartLine,
} from "./side-by-side-diff";

describe("sideBySideDiff", () => {
  it("aligns replacements and preserves surrounding lines", () => {
    expect(sideBySideDiff("one\nold\nthree", "one\nnew\nextra\nthree")).toEqual(
      [
        { kind: "unchanged", previousIndex: 0, currentIndex: 0 },
        { kind: "modified", previousIndex: 1, currentIndex: 1 },
        { kind: "added", previousIndex: undefined, currentIndex: 2 },
        { kind: "unchanged", previousIndex: 2, currentIndex: 3 },
      ],
    );
  });

  it("represents complete deletion without inventing current lines", () => {
    expect(sideBySideDiff("removed", "")).toEqual([
      { kind: "deleted", previousIndex: 0, currentIndex: undefined },
    ]);
  });

  it("uses unique anchors around repeated documentation markers", () => {
    const previous = [
      "/**",
      " * Existing declaration.",
      " */",
      "export const existing = true;",
    ].join("\n");
    const current = [
      "/**",
      " * Inserted declaration.",
      " */",
      "export const inserted = true;",
      "",
      "/**",
      " * Existing declaration.",
      " */",
      "export const existing = true;",
    ].join("\n");
    const rows = sideBySideDiff(previous, current);

    expect(rows.filter(({ kind }) => kind === "added")).toHaveLength(5);
    expect(rows.filter(({ kind }) => kind === "unchanged")).toHaveLength(4);
    expect(
      rows.some(({ kind }) => kind === "modified" || kind === "deleted"),
    ).toBe(false);
    expect(rows.at(-1)).toEqual({
      kind: "unchanged",
      previousIndex: 3,
      currentIndex: 8,
    });
  });

  it("does not consume a repeated doc opener before an inserted declaration", () => {
    const existing = [
      "/**",
      " * Checks if the given item is in the given array.",
      " */",
      "export const isInArray = () => true;",
    ];
    const inserted = [
      "/**",
      " * Splits an array into bounded batches.",
      " */",
      "export const chunkArray = () => [];",
      "",
    ];
    const rows = sideBySideDiff(
      ["export const before = true;", "", ...existing].join("\n"),
      ["export const before = true;", "", ...inserted, ...existing].join("\n"),
    );

    expect(rows.filter(({ kind }) => kind === "added")).toHaveLength(
      inserted.length,
    );
    expect(
      rows.some(
        ({ kind, currentIndex }) =>
          kind !== "unchanged" && currentIndex === inserted.length + 2,
      ),
    ).toBe(false);
    expect(
      rows.some(({ kind }) => kind === "modified" || kind === "deleted"),
    ).toBe(false);
  });

  it("keeps a declaration docstring unchanged when another documented declaration is inserted before it", () => {
    const previous = [
      "/**",
      " * Selects a random item.",
      " */",
      "export const getRandomElement = () => {",
      "  if (Math.random()) {",
      "    return undefined;",
      "  }",
      "};",
      "",
      "/**",
      " * Checks if the given item is in the given array.",
      " */",
      "export const isInArray = () => {",
      "  return true;",
      "};",
      "",
      "/**",
      " * Gets the most common element.",
      " */",
      "export const getMostCommonElement = () => undefined;",
    ];
    const insertion = [
      "/**",
      " * Splits an array into bounded batches without mutating the input.",
      " */",
      "export const chunkArray = () => {",
      "  const result = [];",
      "  return result;",
      "};",
      "",
    ];
    const current = [
      ...previous.slice(0, 9),
      ...insertion,
      ...previous.slice(9),
    ];
    const rows = sideBySideDiff(previous.join("\n"), current.join("\n"));

    expect(rows.filter(({ kind }) => kind === "added")).toHaveLength(
      insertion.length,
    );
    expect(
      rows.some(({ kind }) => kind === "modified" || kind === "deleted"),
    ).toBe(false);
    expect(
      rows.filter(
        ({ kind, currentIndex }) =>
          kind !== "unchanged" && currentIndex === insertion.length + 9,
      ),
    ).toHaveLength(0);
  });

  it.each([
    [
      "TypeScript",
      "export const before = 1;",
      ["export const inserted = <T>(value: T) => value;"],
      "export const after = 2;",
    ],
    [
      "JavaScript",
      "export const before = 1;",
      ["export const inserted = (value) => value;"],
      "export const after = 2;",
    ],
    [
      "Python",
      "before = 1",
      ["def inserted(value):", "    return value"],
      "after = 2",
    ],
    [
      "Java",
      "static int before = 1;",
      ["static int inserted(int value) {", "  return value;", "}"],
      "static int after = 2;",
    ],
    [
      "C#",
      "static int Before = 1;",
      ["static int Inserted(int value) {", "  return value;", "}"],
      "static int After = 2;",
    ],
    [
      "C++",
      "constexpr int before = 1;",
      ["int inserted(int value) {", "  return value;", "}"],
      "constexpr int after = 2;",
    ],
    [
      "PHP",
      "$before = 1;",
      ["function inserted($value) {", "  return $value;", "}"],
      "$after = 2;",
    ],
    [
      "Shell",
      "before=1",
      ["inserted() {", "  printf '%s\\n' \"$1\"", "}"],
      "after=2",
    ],
    [
      "C",
      "static const int before = 1;",
      ["int inserted(int value) {", "  return value;", "}"],
      "static const int after = 2;",
    ],
    [
      "Ruby",
      "BEFORE = 1",
      ["def inserted(value)", "  value", "end"],
      "AFTER = 2",
    ],
    [
      "HCL",
      'before = "one"',
      ["locals {", '  inserted = "value"', "}"],
      'after = "two"',
    ],
    [
      "Rust",
      "const BEFORE: i32 = 1;",
      ["fn inserted(value: i32) -> i32 {", "  value", "}"],
      "const AFTER: i32 = 2;",
    ],
    [
      "Lua",
      "local before = 1",
      ["local function inserted(value)", "  return value", "end"],
      "local after = 2",
    ],
    [
      "Go",
      "const before = 1",
      ["func inserted(value int) int {", "  return value", "}"],
      "const after = 2",
    ],
    [
      "Makefile",
      "BEFORE := 1",
      ["inserted:", "\t@echo inserted"],
      "AFTER := 2",
    ],
    [
      "Kotlin",
      "const val BEFORE = 1",
      ["fun inserted(value: Int): Int {", "  return value", "}"],
      "const val AFTER = 2",
    ],
  ])(
    "aligns a %s insertion without modifying its unchanged neighbors",
    (_language, before, inserted, after) => {
      const rows = sideBySideDiff(
        [before, after].join("\n"),
        [before, ...inserted, after].join("\n"),
      );

      expect(rows.filter(({ kind }) => kind === "added")).toHaveLength(
        inserted.length,
      );
      expect(rows.filter(({ kind }) => kind === "unchanged")).toHaveLength(2);
      expect(
        rows.some(({ kind }) => kind === "modified" || kind === "deleted"),
      ).toBe(false);
    },
  );

  it.each([
    "TypeScript",
    "JavaScript",
    "Python",
    "Java",
    "C#",
    "C++",
    "PHP",
    "Shell",
    "C",
    "Ruby",
    "HCL",
    "Rust",
    "Lua",
    "Go",
    "Makefile",
    "Kotlin",
  ])("focuses a large %s unit on its changed hunk", (language) => {
    const before = Array.from(
      { length: 12 },
      (_, index) => `${language} unchanged before ${index}`,
    );
    const after = Array.from(
      { length: 12 },
      (_, index) => `${language} unchanged after ${index}`,
    );
    const rows = sideBySideDiff(
      [...before, `${language} old behavior`, ...after].join("\n"),
      [...before, `${language} new behavior`, ...after].join("\n"),
    );
    const compact = compactSideBySideDiff(rows);

    expect(compact.filter(({ kind }) => kind === "collapsed")).toEqual([
      { kind: "collapsed", rowStart: 0, rowEnd: 9, count: 9 },
      { kind: "collapsed", rowStart: 16, rowEnd: 25, count: 9 },
    ]);
    expect(
      compact.some(
        (item) => item.kind === "row" && item.row.kind === "modified",
      ),
    ).toBe(true);
  });

  it("keeps the selected review range visible when another hunk drives compaction", () => {
    const rows = sideBySideDiff(
      [
        "one",
        "old",
        ...Array.from({ length: 20 }, (_, index) => `line ${index}`),
      ].join("\n"),
      [
        "one",
        "new",
        ...Array.from({ length: 20 }, (_, index) => `line ${index}`),
      ].join("\n"),
    );
    const compact = compactSideBySideDiff(rows, 3, { start: 16, end: 18 });

    expect(
      compact.some(
        (item) =>
          item.kind === "collapsed" && item.rowStart <= 16 && item.rowEnd >= 18,
      ),
    ).toBe(false);
    expect(
      compact.filter(
        (item) =>
          item.kind === "row" && item.rowIndex >= 16 && item.rowIndex < 18,
      ),
    ).toHaveLength(2);
  });

  it("never collapses paged surrounding context outside the unit window", () => {
    const before = Array.from({ length: 10 }, (_, index) => `before ${index}`);
    const after = Array.from({ length: 10 }, (_, index) => `after ${index}`);
    const rows = sideBySideDiff(
      [...before, "old", ...after].join("\n"),
      [...before, "new", ...after].join("\n"),
    );
    const compact = compactSideBySideDiff(rows, 3, {
      collapseWithin: { start: 10, end: 11 },
      pinRangeEnds: 1,
    });

    expect(
      compact.filter(
        (item) =>
          item.kind === "collapsed" &&
          (item.rowEnd <= 10 || item.rowStart >= 11),
      ),
    ).toHaveLength(0);
    expect(
      compact.filter((item) => item.kind === "row" && item.rowIndex < 10),
    ).toHaveLength(10);
    expect(
      compact.filter((item) => item.kind === "row" && item.rowIndex >= 11),
    ).toHaveLength(10);
  });
});

describe("sourceStartLine", () => {
  it("derives base line numbers from the retained base file", () => {
    expect(sourceStartLine("first\nsecond\nunit\nlast", "unit", 99)).toBe(3);
  });

  it("uses the exact UTF-8 byte offset when source text repeats", () => {
    const source = "å unit\nmiddle\nå unit\nlast";
    const second = new TextEncoder().encode("å unit\nmiddle\n").byteLength;
    expect(sourceByteOffsetLine(source, second, 99)).toBe(3);
  });
});

describe("currentChangedLineIndexes", () => {
  it("returns only added and modified pull-request lines", () => {
    expect([
      ...currentChangedLineIndexes("one\nold\nthree", "one\nnew\nextra\nthree"),
    ]).toEqual([1, 2]);
  });
});

describe("sourceEndLine", () => {
  it("does not count a terminating newline as another line", () => {
    // A unit of three lines ending in a newline occupies 10-12, never 10-13:
    // claiming line 13 would reach past the unit into whatever follows it.
    expect(
      sourceEndLine("const a = 1;\nconst b = 2;\nconst c = 3;\n", 10),
    ).toBe(12);
    expect(sourceEndLine("const a = 1;\nconst b = 2;\nconst c = 3;", 10)).toBe(
      12,
    );
  });

  it("keeps a single line on its own start line", () => {
    expect(sourceEndLine("const a = 1;", 7)).toBe(7);
    expect(sourceEndLine("", 7)).toBe(7);
  });
});

describe("focusedRowSpan", () => {
  /** Builds diff rows from a compact "prev/curr" description, "-" for absent. */
  function rowsFrom(pairs: Array<[number | null, number | null]>) {
    return pairs.map(([previous, current]) => ({
      kind:
        previous === null
          ? ("added" as const)
          : current === null
            ? ("deleted" as const)
            : ("unchanged" as const),
      previousIndex: previous === null ? undefined : previous - 1,
      currentIndex: current === null ? undefined : current - 1,
    }));
  }

  /** Computes the span for one declaration range on each side. */
  const span = (
    rows: ReturnType<typeof rowsFrom>,
    previous: { startLine: number; endLine: number },
    current: { startLine: number; endLine: number },
    multiRange = false,
  ) =>
    focusedRowSpan({
      rows,
      previousStartLine: 1,
      currentStartLine: 1,
      previousRanges: [previous],
      currentRanges: [current],
      multiRange,
    });

  it("ends at the declaration when its closer is paired far below", () => {
    // The declaration is base 1-3 / head 1-3. Lines 4-6 are a second
    // declaration inserted whole. The diff paired the first declaration's
    // closing base line 3 with head line 6 — the second declaration's
    // identical closer — leaving head 4 and 5 as insertions in between.
    const rows = rowsFrom([
      [1, 1],
      [2, 2],
      [null, 3],
      [null, 4],
      [null, 5],
      [3, 6],
      [4, 7],
    ]);
    expect(
      span(rows, { startLine: 1, endLine: 3 }, { startLine: 1, endLine: 3 }),
    ).toEqual({ start: 0, end: 3 });
  });

  it("keeps a deletion inside the declaration from ending it early", () => {
    // Row 2 is a removed line: it carries no head line, so it cannot show the
    // declaration has been left, and rows 3-4 still belong to it.
    const rows = rowsFrom([
      [1, 1],
      [2, null],
      [3, 2],
      [4, 3],
      [5, 4],
    ]);
    expect(
      span(rows, { startLine: 1, endLine: 4 }, { startLine: 1, endLine: 3 }),
    ).toEqual({ start: 0, end: 4 });
  });

  it("keeps an insertion inside the declaration from ending it early", () => {
    const rows = rowsFrom([
      [1, 1],
      [null, 2],
      [2, 3],
      [3, 4],
    ]);
    expect(
      span(rows, { startLine: 1, endLine: 3 }, { startLine: 1, endLine: 4 }),
    ).toEqual({ start: 0, end: 4 });
  });

  it("lets a declaration of several ranges skip the rows between them", () => {
    const rows = rowsFrom([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ]);
    expect(
      span(
        rows,
        { startLine: 1, endLine: 4 },
        { startLine: 1, endLine: 4 },
        true,
      ).end,
    ).toBe(4);
  });
});
