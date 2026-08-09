import { describe, expect, it } from "vitest";
import { syntaxDescendants, withSyntaxTree } from "./tree-sitter";

/** Builds a distinct source large enough to press on the parse budget. */
function fillerSource(index: number) {
  return Array.from(
    { length: 400 },
    (_, line) => `export const value${index}_${line} = ${line} + ${index};`,
  ).join("\n");
}

describe("syntax tree reuse", () => {
  it("returns the same structure whether a source is parsed or reused", () => {
    const source =
      "export function reused(input: number) {\n  return input;\n}";
    /** Lists the node types of one parse of the shared source. */
    const nodeTypes = () =>
      withSyntaxTree("typescript", source, (tree) =>
        syntaxDescendants(tree.rootNode).map((node) => node.type),
      );
    expect(nodeTypes()).toEqual(nodeTypes());
  });

  it("keeps a tree usable while nested parses evict the cache around it", () => {
    const source = "export function outer() {\n  return { value: 1 };\n}";
    const observed = withSyntaxTree("typescript", source, (tree) => {
      const before = syntaxDescendants(tree.rootNode).map((node) => node.type);
      // Well over the retained-parse budget, so every unborrowed entry — but
      // never this one — is evicted while the outer traversal is suspended.
      for (let index = 0; index < 200; index += 1) {
        withSyntaxTree(
          "typescript",
          fillerSource(index),
          (nested) => nested.rootNode.namedChildCount,
        );
      }
      const after = syntaxDescendants(tree.rootNode).map((node) => node.type);
      return { before, after };
    });
    expect(observed.after).toEqual(observed.before);
    expect(observed.before.length).toBeGreaterThan(5);
  });

  it("reuses a tree a nested traversal of the same source re-entered", () => {
    const source = "def handler(value):\n    return value + 1\n";
    const observed = withSyntaxTree("python", source, (outer) => {
      const nested = withSyntaxTree(
        "python",
        source,
        (tree) => syntaxDescendants(tree.rootNode).length,
      );
      return { nested, outer: syntaxDescendants(outer.rootNode).length };
    });
    expect(observed.nested).toBe(observed.outer);
  });
});
