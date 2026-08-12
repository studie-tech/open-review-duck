import { describe, expect, it } from "vitest";
import {
  anchorIsGrounded,
  anchorIsInScope,
  matchAllConsecutive,
  normalizeSnippetLines,
  resolveAnchor,
} from "./anchor";

const HANDLER = [
  "export function handler(request) {",
  "  const user = authenticate(request);",
  "",
  "  if (!user) {",
  "    return deny();",
  "  }",
  "  return allow(user);",
  "}",
].join("\n");

const REPEATED = [
  "function first() {",
  "  return compute(value);",
  "}",
  "function second() {",
  "  return compute(value);",
  "}",
].join("\n");

/** Builds a resolver input with the tiers the case under test needs. */
function input(overrides: Partial<Parameters<typeof resolveAnchor>[0]>) {
  return resolveAnchor({
    existingCode: "",
    currentSource: null,
    previousSource: null,
    changedRanges: [],
    ...overrides,
  });
}

describe("deep review anchoring", () => {
  it("anchors an exact single match to 1-based file lines", () => {
    expect(
      input({
        existingCode: "if (!user) {\n  return deny();\n}",
        currentSource: HANDLER,
      }),
    ).toEqual({
      tier: "file_current",
      side: "current",
      startLine: 4,
      endLine: 6,
      ambiguous: false,
    });
  });

  it("matches across a blank line because blanks are dropped both sides", () => {
    expect(
      input({
        existingCode: "const user = authenticate(request);\nif (!user) {",
        currentSource: HANDLER,
      }),
    ).toEqual({
      tier: "file_current",
      side: "current",
      startLine: 2,
      endLine: 4,
      ambiguous: false,
    });
  });

  it("ignores diff markers and indentation when normalizing a snippet", () => {
    expect(normalizeSnippetLines("+  const a = 1;\n\n-  const b = 2;")).toEqual(
      ["const a = 1;", "const b = 2;"],
    );
    expect(
      input({
        existingCode: "+    return deny();\n+  }",
        currentSource: HANDLER,
      }),
    ).toMatchObject({ startLine: 5, endLine: 6 });
  });

  it("strips only one leading marker so a negated diff line survives", () => {
    expect(normalizeSnippetLines("+  -1")).toEqual(["-1"]);
  });

  it("returns every consecutive match rather than only the first", () => {
    const lines = [
      { line: 1, content: "log();" },
      { line: 2, content: "flush();" },
      { line: 9, content: "log();" },
      { line: 10, content: "flush();" },
    ];
    expect(matchAllConsecutive(lines, ["log();", "flush();"])).toEqual([
      { startLine: 1, endLine: 2 },
      { startLine: 9, endLine: 10 },
    ]);
  });

  it("finds no match for a needle longer than the haystack", () => {
    expect(
      matchAllConsecutive([{ line: 1, content: "a" }], ["a", "b"]),
    ).toEqual([]);
  });

  it("restricts the changed tier to the file's changed line ranges", () => {
    expect(
      input({
        existingCode: "return compute(value);",
        currentSource: REPEATED,
        changedRanges: [{ startLine: 4, endLine: 6 }],
      }),
    ).toEqual({
      tier: "changed_current",
      side: "current",
      startLine: 5,
      endLine: 5,
      ambiguous: false,
    });
  });

  it("prefers the whole-file candidate that overlaps a changed range", () => {
    expect(
      input({
        existingCode: "return compute(value);\n}",
        currentSource: REPEATED,
        // Too narrow to contain the two-line snippet, so the changed tier
        // misses it and the whole-file tier must break the tie itself.
        changedRanges: [{ startLine: 6, endLine: 6 }],
      }),
    ).toEqual({
      tier: "file_current",
      side: "current",
      startLine: 5,
      endLine: 6,
      ambiguous: false,
    });
  });

  it("restricts the first tier to the owning unit's line ranges", () => {
    const source = [
      "const a = read();",
      "const b = read();",
      "const c = read();",
    ].join("\n");
    expect(
      input({
        existingCode: "const b = read();",
        currentSource: source,
        changedRanges: [{ startLine: 1, endLine: 3 }],
        unitRanges: [{ startLine: 2, endLine: 2 }],
      }),
    ).toEqual({
      tier: "unit_current",
      side: "current",
      startLine: 2,
      endLine: 2,
      ambiguous: false,
    });
  });

  it("never lets a match span the gap between two disjoint ranges", () => {
    const source = ["alpha();", "unrelated();", "beta();"].join("\n");
    expect(
      input({
        existingCode: "alpha();\nbeta();",
        currentSource: source,
        changedRanges: [
          { startLine: 1, endLine: 1 },
          { startLine: 3, endLine: 3 },
        ],
      }),
    ).toEqual({
      tier: "none",
      side: null,
      startLine: null,
      endLine: null,
      ambiguous: false,
    });
  });

  it("breaks a change-range tie by containment in a read unit", () => {
    const previous = [
      "  total += 1;",
      "  helper();",
      "  total += 1;",
      "  helper();",
    ].join("\n");
    expect(
      input({
        existingCode: "total += 1;\nhelper();",
        currentSource: null,
        previousSource: previous,
        changedRanges: [{ startLine: 1, endLine: 4 }],
        unitRanges: [{ startLine: 3, endLine: 4 }],
      }),
    ).toMatchObject({
      tier: "file_previous",
      side: "previous",
      startLine: 3,
      endLine: 4,
      ambiguous: false,
    });
  });

  it("breaks a remaining tie by proximity to the agent's evidence", () => {
    const source = [
      "emit(payload);",
      "gap();",
      "gap();",
      "gap();",
      "emit(payload);",
    ].join("\n");
    expect(
      input({
        existingCode: "emit(payload);",
        currentSource: source,
        changedRanges: [{ startLine: 1, endLine: 5 }],
        evidenceRanges: [{ startLine: 4, endLine: 6 }],
      }),
    ).toMatchObject({ startLine: 5, endLine: 5, ambiguous: false });
  });

  it("reports ambiguity instead of guessing a line for a tied snippet", () => {
    const source = ["retry();", "retry();"].join("\n");
    expect(
      input({
        existingCode: "retry();",
        currentSource: source,
        changedRanges: [{ startLine: 1, endLine: 2 }],
      }),
    ).toEqual({
      tier: "ambiguous",
      side: null,
      startLine: null,
      endLine: null,
      ambiguous: true,
    });
  });

  it("stays ambiguous when evidence is equidistant from both candidates", () => {
    const source = ["guard();", "middle();", "guard();"].join("\n");
    expect(
      input({
        existingCode: "guard();",
        currentSource: source,
        changedRanges: [{ startLine: 1, endLine: 3 }],
        evidenceRanges: [{ startLine: 2, endLine: 2 }],
      }),
    ).toMatchObject({ tier: "ambiguous", ambiguous: true });
  });

  it("falls back to the previous revision for a deleted file", () => {
    expect(
      input({
        existingCode: "return allow(user);",
        currentSource: null,
        previousSource: HANDLER,
        changedRanges: [{ startLine: 1, endLine: 8 }],
      }),
    ).toEqual({
      tier: "file_previous",
      side: "previous",
      startLine: 7,
      endLine: 7,
      ambiguous: false,
    });
  });

  it("prefers a current-revision match over the previous revision", () => {
    expect(
      input({
        existingCode: "return deny();",
        currentSource: HANDLER,
        previousSource: HANDLER,
      }),
    ).toMatchObject({ tier: "file_current", side: "current", startLine: 5 });
  });

  it("resolves nothing for an empty or whitespace-only snippet", () => {
    const nothing = {
      tier: "none",
      side: null,
      startLine: null,
      endLine: null,
      ambiguous: false,
    };
    expect(input({ existingCode: "", currentSource: HANDLER })).toEqual(
      nothing,
    );
    expect(
      input({ existingCode: "   \n\t\n +\n", currentSource: HANDLER }),
    ).toEqual(nothing);
  });

  it("resolves nothing when the snippet is absent from both revisions", () => {
    expect(
      input({
        existingCode: "launchMissiles();",
        currentSource: HANDLER,
        previousSource: HANDLER,
      }),
    ).toMatchObject({ tier: "none", startLine: null });
  });

  it("gates an anchor on overlap with the changed and evidence ranges", () => {
    const anchor = input({
      existingCode: "return deny();",
      currentSource: HANDLER,
    });
    expect(anchorIsInScope(anchor, [{ startLine: 4, endLine: 6 }])).toBe(true);
    expect(anchorIsInScope(anchor, [{ startLine: 1, endLine: 4 }])).toBe(false);
    expect(anchorIsGrounded(anchor, [{ startLine: 5, endLine: 5 }])).toBe(true);
    expect(anchorIsGrounded(anchor, [])).toBe(false);
  });

  it("fails both gates for an unresolved or ambiguous anchor", () => {
    const unresolved = input({ existingCode: "", currentSource: HANDLER });
    const ambiguous = input({
      existingCode: "retry();",
      currentSource: "retry();\nretry();",
      changedRanges: [{ startLine: 1, endLine: 2 }],
    });
    const everything = [{ startLine: 1, endLine: 1000 }];
    expect(anchorIsInScope(unresolved, everything)).toBe(false);
    expect(anchorIsGrounded(unresolved, everything)).toBe(false);
    expect(anchorIsInScope(ambiguous, everything)).toBe(false);
    expect(anchorIsGrounded(ambiguous, everything)).toBe(false);
  });
});
