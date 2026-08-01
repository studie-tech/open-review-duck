import { createHash } from "node:crypto";
import type { Tree } from "web-tree-sitter";
import { withSyntaxTree } from "./tree-sitter";
import type { SupportedLanguage } from "./types";

/** Returns the SHA-256 digest of a string. */
export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Creates a stable identity for a review unit across revisions. */
export function stableReviewKey(path: string, kind: string, name: string) {
  const readable = `${path}:${kind}:${name}`;
  return readable.length <= 400
    ? readable
    : `${readable.slice(0, 335)}:${sha256(readable)}`;
}

/** Ignores parser whitespace while retaining comments, literals, and code tokens. */
export function semanticSource(source: string, language: SupportedLanguage) {
  if (language === "text") return source;
  return withSyntaxTree(language, source, (tree) => tokenStream(source, tree));
}

/** Extracts the semantic token stream used to hash a code unit. */
function tokenStream(source: string, tree: Tree) {
  const tokens: string[] = [];
  const cursor = tree.walk();
  let complete = false;
  while (!complete) {
    if (cursor.gotoFirstChild()) continue;
    const node = cursor.currentNode;
    if (node.endIndex > node.startIndex) {
      const value = source.slice(node.startIndex, node.endIndex);
      tokens.push(`${node.type.length}:${node.type}:${value.length}:${value}`);
    }
    if (cursor.gotoNextSibling()) continue;
    while (true) {
      if (!cursor.gotoParent()) {
        complete = true;
        break;
      }
      if (cursor.gotoNextSibling()) break;
    }
  }
  cursor.delete();
  return tokens.join("|");
}
