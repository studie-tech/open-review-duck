import { describe, expect, it } from "vitest";
import {
  analyzeFiles,
  calculateRevisionDepths,
  extractFileAnalysis,
} from "./engine";
import type { SourceFile } from "./types";

const files: SourceFile[] = [
  {
    path: "src/a.ts",
    changeType: "added",
    content: "export function work() { return 1; }\n",
  },
  {
    path: "src/b.ts",
    changeType: "added",
    content:
      "import { work } from './a';\nexport function caller() { return work(); }\n",
  },
];

describe("incremental file extraction", () => {
  it("is identical to full analysis while rebuilding changed imports and symbol ambiguity", () => {
    const cached = new Map(
      files.map((file) => [file.path, extractFileAnalysis(file)]),
    );
    expect(analyzeFiles(files, undefined, cached)).toEqual(analyzeFiles(files));
    const next = [
      ...files,
      {
        path: "src/c.ts",
        changeType: "added" as const,
        content: "export function work() { return 2; }\n",
      },
    ];
    expect(analyzeFiles(next, undefined, cached)).toEqual(analyzeFiles(next));
    next[1] = {
      path: "src/b.ts",
      changeType: "added",
      content:
        "import { work } from './c';\nexport function caller() { return work(); }\n",
    };
    cached.delete("src/b.ts");
    const result = analyzeFiles(next, undefined, cached);
    expect(result).toEqual(analyzeFiles(next));
    const caller = result.units.find((unit) => unit.name === "caller");
    const target = result.units.find(
      (unit) => unit.path === "src/c.ts" && unit.name === "work",
    );
    expect(caller?.dependencies).toContain(target?.stableKey);
  });

  it("preserves base-side ranges and deletions when unchanged file facts are reused", () => {
    const changed: SourceFile[] = [
      {
        path: "renamed.ts",
        previousPath: "original.ts",
        changeType: "renamed",
        previousContent: "export function oldName() { return '🦆'; }\n",
        content: "export function newName() { return '🦆'; }\n",
      },
    ];
    const cached = new Map(
      changed.map((file) => [file.path, extractFileAnalysis(file)]),
    );
    expect(analyzeFiles(changed, undefined, cached)).toEqual(
      analyzeFiles(changed),
    );
  });
});

describe("shared dependency depths", () => {
  /** Matches the original depth traversal, including root-dependent cycle cuts. */
  function originalDepth(
    key: string,
    graph: Map<string, string[]>,
    visiting = new Set<string>(),
    memo = new Map<string, number>(),
  ): number {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const depth = Math.max(
      0,
      ...(graph.get(key) ?? []).map(
        (dependency) =>
          1 + originalDepth(dependency, graph, new Set(visiting), memo),
      ),
    );
    memo.set(key, depth);
    return depth;
  }

  it("matches the original algorithm for cyclic and branching graphs", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const keys = Array.from({ length: 12 }, (_, index) => String(index));
      const graph = new Map(
        keys.map((key, index) => [
          key,
          keys.filter(
            (_target, target) =>
              target !== index &&
              (seed * 17 + index * 13 + target * 7) % 11 === 0,
          ),
        ]),
      );
      const depths = calculateRevisionDepths(graph);
      for (const key of keys)
        expect(depths.get(key)).toBe(originalDepth(key, graph));
    }
  });

  it("handles a large acyclic chain without per-root recursive traversals", () => {
    const graph = new Map(
      Array.from({ length: 10000 }, (_, index) => [
        String(index),
        index === 0 ? [] : [String(index - 1)],
      ]),
    );
    expect(calculateRevisionDepths(graph).get("9999")).toBe(9999);
  });
});
