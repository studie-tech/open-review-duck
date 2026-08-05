import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  clusterReviewConcepts,
  MAX_CONCEPT_CHANGED_LINES,
  MAX_CONCEPT_FILES,
  validateConceptPartition,
} from "./concepts";
import { analyzeFiles, changedLineCount } from "./engine";
import type { AnalyzedUnit } from "./types";

/** Creates a compact atomic unit for deterministic clustering tests. */
function unit(
  stableKey: string,
  overrides: Partial<AnalyzedUnit> = {},
): AnalyzedUnit {
  const [path = "src/service.ts", name = stableKey] = stableKey.split(":");
  return {
    stableKey,
    path,
    language: "typescript",
    kind: "function",
    name,
    startLine: 1,
    endLine: 3,
    source: "export function value() {}",
    contentHash: stableKey,
    semanticHash: stableKey,
    changeType: "modified",
    complexity: 1,
    changedLineCount: 3,
    dependencies: [],
    depth: 0,
    reviewOrder: 0,
    ...overrides,
  };
}

describe("clusterReviewConcepts", () => {
  it("assigns every changed base/head line to exactly one atomic unit", () => {
    const previous = [
      "import { save } from './store';",
      "export function run(value: string) {",
      "  return save(value);",
      "}",
    ].join("\n");
    const current = [
      "import { persist } from './store';",
      "export function run(value: string) {",
      "  const normalized = value.trim();",
      "  return persist(normalized);",
      "}",
    ].join("\n");
    const atomic = analyzeFiles([
      {
        path: "src/run.ts",
        previousContent: previous,
        content: current,
        changeType: "modified",
      },
    ]).units.filter(({ kind }) => kind !== "file");
    expect(
      atomic.reduce((total, item) => total + item.changedLineCount, 0),
    ).toBe(changedLineCount(previous, current));
    expect(atomic.every(({ changedLineCount }) => changedLineCount >= 0)).toBe(
      true,
    );
  });

  it("groups dependency-connected production and test changes", () => {
    const production = unit("src/token-usage.ts:TokenUsage.save", {
      name: "TokenUsage.save",
    });
    const test = unit("tests/token-usage.test.ts:saves token usage", {
      path: "tests/token-usage.test.ts",
      name: "saves token usage",
      kind: "test",
      reviewOrder: 1,
      dependencies: [production.stableKey],
    });
    const concepts = clusterReviewConcepts([production, test]);
    expect(concepts).toHaveLength(1);
    expect(concepts[0]?.memberStableKeys).toEqual([
      production.stableKey,
      test.stableKey,
    ]);
    expect(concepts[0]?.title).toContain("tests");
    validateConceptPartition([production, test], concepts);
  });

  it("is byte-identical when input order changes", () => {
    const units = Array.from({ length: 30 }, (_, index) =>
      unit(`src/model.ts:Usage.field${index}`, {
        name: `Usage.field${index}`,
        startLine: index * 4 + 1,
        endLine: index * 4 + 2,
        reviewOrder: index,
      }),
    );
    const expected = JSON.stringify(clusterReviewConcepts(units));
    const shuffled = [...units].sort((left, right) =>
      right.stableKey.localeCompare(left.stableKey),
    );
    expect(JSON.stringify(clusterReviewConcepts(shuffled))).toBe(expected);
  });

  it("keeps unrelated adjacent edits separate", () => {
    const concepts = clusterReviewConcepts([
      unit("src/settings.ts:parseBillingAddress", {
        name: "parseBillingAddress",
        startLine: 10,
        endLine: 20,
      }),
      unit("src/settings.ts:rotateWebhookSecret", {
        name: "rotateWebhookSecret",
        startLine: 24,
        endLine: 31,
        reviewOrder: 1,
      }),
    ]);
    expect(concepts).toHaveLength(2);
  });

  it("orders dependency cycles deterministically without forcing a merge", () => {
    const first = unit("src/a.ts:alpha", {
      dependencies: ["src/b.ts:beta"],
      changedLineCount: 300,
    });
    const second = unit("src/b.ts:beta", {
      dependencies: ["src/a.ts:alpha"],
      changedLineCount: 300,
      reviewOrder: 1,
    });
    const expected = clusterReviewConcepts([first, second]);
    expect(expected).toHaveLength(2);
    expect(clusterReviewConcepts([second, first])).toEqual(expected);
    validateConceptPartition([first, second], expected);
  });

  it("keeps an intrinsically oversized atomic unit as a flagged singleton", () => {
    const oversized = unit("generated/schema.ts:Schema", {
      changedLineCount: MAX_CONCEPT_CHANGED_LINES + 1,
    });
    const companion = unit("generated/schema.ts:Schema.parse", {
      name: "Schema.parse",
      changedLineCount: 2,
      dependencies: [oversized.stableKey],
      reviewOrder: 1,
    });
    const concepts = clusterReviewConcepts([oversized, companion]);
    expect(concepts).toHaveLength(2);
    expect(
      concepts.find(({ memberStableKeys }) =>
        memberStableKeys.includes(oversized.stableKey),
      )?.oversized,
    ).toBe(true);
    validateConceptPartition([oversized, companion], concepts);
  });

  it("rejects duplicate and missing memberships", () => {
    const first = unit("src/a.ts:a");
    const second = unit("src/b.ts:b");
    expect(() =>
      validateConceptPartition(
        [first, second],
        [{ memberStableKeys: [first.stableKey] }],
      ),
    ).toThrow(/missing/i);
    expect(() =>
      validateConceptPartition(
        [first, second],
        [
          { memberStableKeys: [first.stableKey] },
          { memberStableKeys: [first.stableKey, second.stableKey] },
        ],
      ),
    ).toThrow(/duplicate/i);
  });

  it("clusters 1,000 sparse units without quadratic growth", () => {
    const units = Array.from({ length: 1_000 }, (_, index) =>
      unit(
        `src/module-${Math.floor(index / 10)}/item-${index}.ts:item${index}`,
        {
          name: `Module${Math.floor(index / 10)}.item${index}`,
          reviewOrder: index,
          startLine: (index % 10) * 5 + 1,
        },
      ),
    );
    const startedAt = performance.now();
    const concepts = clusterReviewConcepts(units);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    validateConceptPartition(units, concepts);
  });

  it("substantially reduces a 139-unit dependency-rich review fixture", () => {
    const units = Array.from({ length: 139 }, (_, index) => {
      const concern = Math.floor(index / 8);
      const prior = index % 8 === 0 ? undefined : index - 1;
      return unit(
        `src/concern-${concern}/part-${index % 8}.ts:Concern${concern}.part${index % 8}`,
        {
          name: `Concern${concern}.part${index % 8}`,
          path: `src/concern-${concern}/part-${index % 8}.ts`,
          reviewOrder: index,
          dependencies:
            prior === undefined
              ? []
              : [
                  `src/concern-${concern}/part-${prior % 8}.ts:Concern${concern}.part${prior % 8}`,
                ],
        },
      );
    });
    const concepts = clusterReviewConcepts(units);
    expect(concepts.length).toBeLessThan(70);
    expect(
      concepts.flatMap(({ memberStableKeys }) => memberStableKeys),
    ).toHaveLength(139);
    expect(
      concepts.every(
        ({ fileCount, changedLineCount, memberStableKeys }) =>
          memberStableKeys.length === 1 ||
          (fileCount <= MAX_CONCEPT_FILES &&
            changedLineCount <= MAX_CONCEPT_CHANGED_LINES),
      ),
    ).toBe(true);
    validateConceptPartition(units, concepts);
  });
});
