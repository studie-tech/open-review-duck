import { describe, expect, it, vi } from "vitest";
import { clusterReviewConcepts, validateConceptPartition } from "./concepts";
import { analyzeFiles } from "./engine";
import type { SourceFile } from "./types";

/**
 * One declaration per language, each holding a line the revision removes.
 *
 * Diff scoping decides which declarations a revision touched by reading the
 * head side, and a revision that only removes lines changes nothing there, so
 * every one of these used to surface as an anonymous "Changed line 3".
 */
const declarations = [
  {
    language: "TypeScript",
    path: "math.ts",
    name: "total",
    removed: "  const unused = 1;\n",
    source:
      "export function total(n: number) {\n  const doubled = n * 2;\n  const unused = 1;\n  return doubled;\n}\n",
  },
  {
    language: "Python",
    path: "math.py",
    name: "total",
    removed: "    unused = 1\n",
    source:
      "def total(n):\n    doubled = n * 2\n    unused = 1\n    return doubled\n",
  },
  {
    language: "Go",
    path: "math.go",
    name: "Total",
    removed: "\tunused := 1\n",
    source:
      "func Total(n int) int {\n\tdoubled := n * 2\n\tunused := 1\n\treturn doubled\n}\n",
  },
  {
    language: "Rust",
    path: "math.rs",
    name: "total",
    removed: "    let unused = 1;\n",
    source:
      "pub fn total(n: i32) -> i32 {\n    let doubled = n * 2;\n    let unused = 1;\n    doubled\n}\n",
  },
  {
    language: "Ruby",
    path: "math.rb",
    name: "#total",
    removed: "  unused = 1\n",
    source: "def total(n)\n  doubled = n * 2\n  unused = 1\n  doubled\nend\n",
  },
];

describe("a revision that only removes lines", () => {
  it.each(declarations)(
    "names the $language declaration it removed them from",
    ({ path, name, removed, source }) => {
      const reviewable = analyzeFiles([
        {
          path,
          content: source.replace(removed, ""),
          previousContent: source,
          changeType: "modified",
        },
      ]).units.filter(({ kind }) => kind !== "file");

      expect(reviewable).toHaveLength(1);
      expect(reviewable[0]).toMatchObject({ name, changeType: "modified" });
      expect(reviewable[0]?.previousSource).toContain("unused");
      expect(reviewable[0]?.source).not.toContain("unused");
    },
  );

  it("still leaves every removed line reachable", () => {
    const [first] = declarations;
    if (!first) throw new Error("Expected a declaration fixture");
    const file: SourceFile = {
      path: first.path,
      content: first.source.replace(first.removed, ""),
      previousContent: first.source,
      changeType: "modified",
    };
    const units = analyzeFiles([file]).units.filter(
      ({ kind }) => kind !== "file",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    validateConceptPartition(units, clusterReviewConcepts(units), [file]);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("gives the innermost declaration the removal, not the file", () => {
    // Ownership is settled on both sides now, so an enclosing declaration must
    // still find nothing left to claim once the one inside it has claimed.
    const source = [
      "export class Basket {",
      "  add(item: string) {",
      "    const trimmed = item.trim();",
      "    const legacy = true;",
      "    return trimmed;",
      "  }",
      "",
      "  clear() {",
      "    return [];",
      "  }",
      "}",
      "",
    ].join("\n");
    const reviewable = analyzeFiles([
      {
        path: "basket.ts",
        content: source.replace("    const legacy = true;\n", ""),
        previousContent: source,
        changeType: "modified",
      },
    ]).units.filter(({ kind }) => kind !== "file");

    expect(reviewable).toHaveLength(1);
    expect(reviewable[0]).toMatchObject({ name: "add", kind: "method" });
  });
});
