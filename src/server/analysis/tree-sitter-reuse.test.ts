import { describe, expect, it } from "vitest";
import { syntaxDescendants, withSyntaxTree } from "./tree-sitter";

/** Builds a distinct source large enough to press on the parse budget. */
function fillerSource(index: number) {
  return Array.from(
    { length: 400 },
    (_, line) => `export const value${index}_${line} = ${line} + ${index};`,
  ).join("\n");
}

/** Builds valid TypeScript whose UTF-8 representation has an exact size. */
function unicodeSource(bytes: number, index: number) {
  const framing = `//\nexport const unicode${index} = ${index};`;
  const remaining = bytes - Buffer.byteLength(framing);
  const fragment = "😀漢";
  const fragmentBytes = Buffer.byteLength(fragment);
  const source = `//${fragment.repeat(Math.floor(remaining / fragmentBytes))}${"x".repeat(remaining % fragmentBytes)}\nexport const unicode${index} = ${index};`;
  expect(Buffer.byteLength(source)).toBe(bytes);
  return source;
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

  it("accounts for Unicode parses at the exact UTF-8 byte ceiling", () => {
    const firstSource = unicodeSource(1_000_000, 1);
    const secondSource = unicodeSource(1_000_000, 2);
    const firstTree = withSyntaxTree("typescript", firstSource, (tree) => tree);
    const secondTree = withSyntaxTree(
      "typescript",
      secondSource,
      (tree) => tree,
    );

    // The exact two-megabyte ceiling retains both parses, and touching the
    // first makes the second the least-recently-used entry.
    expect(withSyntaxTree("typescript", firstSource, (tree) => tree)).toBe(
      firstTree,
    );

    withSyntaxTree("typescript", ";", (tree) => tree.rootNode.namedChildCount);

    // One additional UTF-8 byte evicts the second parse. This would remain
    // cached if the Unicode sources were incorrectly charged as UTF-16 units.
    expect(withSyntaxTree("typescript", secondSource, (tree) => tree)).not.toBe(
      secondTree,
    );
  });
});
