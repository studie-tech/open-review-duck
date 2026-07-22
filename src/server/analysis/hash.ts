import { createHash } from "node:crypto";
import type { Tree } from "@lezer/common";
import { parser as javascriptParser } from "@lezer/javascript";
import { parser as pythonParser } from "@lezer/python";
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

/** Normalizes source text so non-semantic formatting changes preserve sign-offs. */
export function semanticSource(source: string, language: SupportedLanguage) {
  if (
    language !== "javascript" &&
    language !== "typescript" &&
    language !== "python"
  ) {
    if (["hcl", "lua", "makefile", "php", "ruby", "shell"].includes(language)) {
      return source;
    }
    return whitespaceInsensitiveSource(source);
  }
  const tree =
    language === "python"
      ? pythonParser.parse(source)
      : javascriptParser
          .configure({
            dialect: language === "typescript" ? "ts jsx" : "jsx",
          })
          .parse(source);
  return tokenStream(source, tree);
}

/** Removes formatting whitespace while preserving literals and documentation. */
function whitespaceInsensitiveSource(source: string) {
  let normalized = "";
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (quote) {
      normalized += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (["'", '"', "`"].includes(character)) {
      quote = character;
      normalized += character;
      continue;
    }
    if (!/\s/.test(character)) normalized += character;
  }
  return normalized;
}

/** Extracts the semantic token stream used to hash a code unit. */
function tokenStream(source: string, tree: Tree) {
  const tokens: string[] = [];
  const cursor = tree.cursor();
  while (true) {
    if (cursor.firstChild()) continue;
    if (cursor.to > cursor.from) {
      tokens.push(
        `${cursor.name.length}:${cursor.name}:${source.slice(cursor.from, cursor.to).length}:${source.slice(cursor.from, cursor.to)}`,
      );
    }
    while (!cursor.nextSibling()) {
      if (!cursor.parent()) return tokens.join("|");
    }
  }
}
