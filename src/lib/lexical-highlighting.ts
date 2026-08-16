import { type LexicalSyntax, lexicalSyntaxFor } from "~/server/analysis/types";
import {
  type HighlightedLine,
  lexicalValueClass,
  linesFromSpans,
  numericLiteralPattern,
  plainLines,
  type TokenSpan,
} from "./highlight-tokens";

const identifierStart = /[A-Za-z_$]/;
const identifierBody = /[\w$]/;

/** Finds the longest declared marker that opens at an offset. */
function markerAt(source: string, offset: number, markers: readonly string[]) {
  let longest: string | undefined;
  for (const marker of markers) {
    if (!source.startsWith(marker, offset)) continue;
    if (!longest || marker.length > longest.length) longest = marker;
  }
  return longest;
}

/** Finds the longest declared block comment that opens at an offset. */
function blockAt(
  source: string,
  offset: number,
  blocks: readonly (readonly [string, string])[],
) {
  let longest: readonly [string, string] | undefined;
  for (const block of blocks) {
    if (!source.startsWith(block[0], offset)) continue;
    if (!longest || block[0].length > longest[0].length) longest = block;
  }
  return longest;
}

/** Reports whether only whitespace precedes an offset on its own line. */
function atLineStart(source: string, offset: number) {
  for (let index = offset - 1; index >= 0; index -= 1) {
    const character = source[index];
    if (character === "\n") return true;
    if (character !== " " && character !== "\t") return false;
  }
  return true;
}

/** Returns the end of a quoted run, closing at a newline when none may span lines. */
function endOfString(source: string, offset: number, quote: string) {
  const triple = quote.repeat(3);
  if (source.startsWith(triple, offset)) {
    const closing = source.indexOf(triple, offset + triple.length);
    return closing < 0 ? source.length : closing + triple.length;
  }
  const multiline = quote === "`";
  for (let index = offset + quote.length; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "\n" && !multiline) return index;
    if (character === quote) return index + 1;
  }
  return source.length;
}

/** Returns the end of a numeric literal that starts at an offset. */
function endOfNumber(source: string, offset: number) {
  let index = offset;
  while (index < source.length && /[\dA-Fa-f_xXoObB]/.test(source[index] ?? ""))
    index += 1;
  if (source[index] === "." && /\d/.test(source[index + 1] ?? "")) {
    index += 1;
    while (index < source.length && /[\d_]/.test(source[index] ?? ""))
      index += 1;
  }
  if (
    /[eE]/.test(source[index] ?? "") &&
    /[\d+-]/.test(source[index + 1] ?? "")
  )
    index += 2;
  while (index < source.length && /[\d_]/.test(source[index] ?? "")) index += 1;
  return index;
}

/**
 * Scans source into token spans using only the language's lexical syntax.
 *
 * The scan recognizes comments, quoted runs, numbers and identifiers, which is
 * everything the shared classifier can decide without a parse tree.
 */
function lexicalTokenSpans(source: string, syntax: LexicalSyntax) {
  const spans: TokenSpan[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? "";
    const block = blockAt(source, index, syntax.blockComments);
    if (block) {
      const closing = source.indexOf(block[1], index + block[0].length);
      const to = closing < 0 ? source.length : closing + block[1].length;
      spans.push({ from: index, to, className: "tok-comment" });
      index = to;
      continue;
    }
    const lineComment = markerAt(source, index, syntax.lineComments);
    if (lineComment) {
      const newline = source.indexOf("\n", index);
      const to = newline < 0 ? source.length : newline;
      spans.push({ from: index, to, className: "tok-comment" });
      index = to;
      continue;
    }
    if (
      syntax.directive &&
      source.startsWith(syntax.directive, index) &&
      atLineStart(source, index)
    ) {
      let end = index + syntax.directive.length;
      while (end < source.length && identifierBody.test(source[end] ?? ""))
        end += 1;
      spans.push({ from: index, to: end, className: "tok-meta" });
      index = end;
      continue;
    }
    if (syntax.quotes.includes(character)) {
      const to = endOfString(source, index, character);
      spans.push({ from: index, to, className: "tok-string" });
      index = to;
      continue;
    }
    if (/\d/.test(character)) {
      const to = endOfNumber(source, index);
      const value = source.slice(index, to);
      spans.push({
        from: index,
        to,
        className: numericLiteralPattern.test(value)
          ? "tok-number"
          : lexicalValueClass(value),
      });
      index = to;
      continue;
    }
    if (identifierStart.test(character)) {
      let end = index + 1;
      while (end < source.length && identifierBody.test(source[end] ?? ""))
        end += 1;
      const value = source.slice(index, end);
      spans.push({ from: index, to: end, className: lexicalValueClass(value) });
      index = end;
      continue;
    }
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    spans.push({ from: index, to: index + 1, className: "tok-operator" });
    index += 1;
  }
  return spans;
}

/**
 * Highlights source without a grammar, for the first paint of a code pane.
 *
 * Languages that declare no lexical syntax fall back to unstyled lines, so this
 * pass is never worse than showing the raw source while a grammar loads.
 */
export function lexicalLines(
  source: string,
  language: string,
): HighlightedLine[] {
  const syntax = lexicalSyntaxFor(language);
  if (!syntax) return plainLines(source);
  return linesFromSpans(source, lexicalTokenSpans(source, syntax));
}
