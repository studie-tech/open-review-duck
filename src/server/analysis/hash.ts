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
  let entering = true;
  let complete = false;
  while (!complete) {
    const node = cursor.currentNode;
    if (entering) {
      if (node.isNamed) tokens.push(`+${node.type.length}:${node.type}`);
      if (cursor.gotoFirstChild()) continue;
      if (node.endIndex > node.startIndex) {
        const value = source.slice(node.startIndex, node.endIndex);
        tokens.push(
          `${node.type.length}:${node.type}:${value.length}:${value}`,
        );
      }
    }
    while (true) {
      const completedNode = cursor.currentNode;
      if (completedNode.isNamed) {
        tokens.push(`-${completedNode.type.length}:${completedNode.type}`);
      }
      if (cursor.gotoNextSibling()) {
        entering = true;
        break;
      }
      if (!cursor.gotoParent()) {
        complete = true;
        break;
      }
      entering = false;
    }
  }
  cursor.delete();
  return tokens.join("|");
}
