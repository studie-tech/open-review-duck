import {
  type LexicalInterpolation,
  type LexicalSyntax,
  lexicalSyntaxFor,
} from "~/server/analysis/types";
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
function endOfString(
  source: string,
  offset: number,
  quote: string,
  limit = source.length,
) {
  const triple = quote.repeat(3);
  if (source.startsWith(triple, offset)) {
    const closing = source.indexOf(triple, offset + triple.length);
    return closing < 0 || closing >= limit ? limit : closing + triple.length;
  }
  const multiline = quote === "`";
  for (let index = offset + quote.length; index < limit; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "\n" && !multiline) return index;
    if (character === quote) return index + 1;
  }
  return limit;
}

/** Finds the interpolation opener declared for this quote at an offset. */
function interpolationAt(
  source: string,
  offset: number,
  quote: string,
  interpolations: readonly LexicalInterpolation[],
) {
  let longest: LexicalInterpolation | undefined;
  for (const interpolation of interpolations) {
    if (!interpolation.quotes.includes(quote)) continue;
    if (!source.startsWith(interpolation.open, offset)) continue;
    if (!longest || interpolation.open.length > longest.open.length) {
      longest = interpolation;
    }
  }
  return longest;
}

/**
 * Finds the matching interpolation closer, skipping nested strings and braces.
 *
 * Brace depth is what keeps `${{ key: value }}` from closing on the first
 * `}`, and skipped quotes are what keep `` `${`${inner}`}` `` honest.
 */
function interpolationCloseAt(
  source: string,
  offset: number,
  interpolation: LexicalInterpolation,
  syntax: LexicalSyntax,
  limit: number,
) {
  let depth = interpolation.close === "}" ? 1 : 0;
  let index = offset;
  while (index < limit) {
    const block = blockAt(source, index, syntax.blockComments);
    if (block) {
      const closing = source.indexOf(block[1], index + block[0].length);
      index =
        closing < 0 || closing >= limit ? limit : closing + block[1].length;
      continue;
    }
    const lineComment = markerAt(source, index, syntax.lineComments);
    if (lineComment) {
      const newline = source.indexOf("\n", index);
      index = newline < 0 || newline >= limit ? limit : newline;
      continue;
    }
    const character = source[index] ?? "";
    if (syntax.quotes.includes(character)) {
      index = endOfInterpolatedString(source, index, character, syntax, limit);
      continue;
    }
    if (interpolation.close === "}" && character === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (source.startsWith(interpolation.close, index)) {
      if (interpolation.close === "}") {
        depth -= 1;
        if (depth === 0) return index;
        index += 1;
        continue;
      }
      return index;
    }
    index += 1;
  }
  return limit;
}

/**
 * Returns the end of a quote that may contain declared interpolations.
 *
 * Used both to emit tokens and to skip a nested quoted run while looking for
 * an interpolation closer.
 */
function endOfInterpolatedString(
  source: string,
  offset: number,
  quote: string,
  syntax: LexicalSyntax,
  limit: number,
) {
  if (
    !syntax.interpolations.some((interpolation) =>
      interpolation.quotes.includes(quote),
    )
  ) {
    return endOfString(source, offset, quote, limit);
  }
  const multiline = quote === "`";
  let index = offset + quote.length;
  while (index < limit) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "\n" && !multiline) return index;
    if (character === quote) return index + 1;
    const interpolation = interpolationAt(
      source,
      index,
      quote,
      syntax.interpolations,
    );
    if (interpolation) {
      const inner = interpolationCloseAt(
        source,
        index + interpolation.open.length,
        interpolation,
        syntax,
        limit,
      );
      index = inner >= limit ? limit : inner + interpolation.close.length;
      continue;
    }
    index += 1;
  }
  return limit;
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
 * Emits one quoted run, splitting declared interpolations out as nested code.
 */
function emitQuoted(
  source: string,
  offset: number,
  quote: string,
  syntax: LexicalSyntax,
  spans: TokenSpan[],
  limit: number,
) {
  if (
    !syntax.interpolations.some((interpolation) =>
      interpolation.quotes.includes(quote),
    )
  ) {
    const end = endOfString(source, offset, quote, limit);
    spans.push({ from: offset, to: end, className: "tok-string" });
    return end;
  }
  const multiline = quote === "`";
  let stringStart = offset;
  let index = offset + quote.length;
  while (index < limit) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "\n" && !multiline) {
      if (index > stringStart) {
        spans.push({ from: stringStart, to: index, className: "tok-string" });
      }
      return index;
    }
    if (character === quote) {
      spans.push({
        from: stringStart,
        to: index + 1,
        className: "tok-string",
      });
      return index + 1;
    }
    const interpolation = interpolationAt(
      source,
      index,
      quote,
      syntax.interpolations,
    );
    if (interpolation) {
      if (index > stringStart) {
        spans.push({ from: stringStart, to: index, className: "tok-string" });
      }
      const openEnd = index + interpolation.open.length;
      spans.push({ from: index, to: openEnd, className: "tok-operator" });
      const closeAt = interpolationCloseAt(
        source,
        openEnd,
        interpolation,
        syntax,
        limit,
      );
      spans.push(...lexicalTokenSpans(source, syntax, openEnd, closeAt));
      if (closeAt < limit) {
        const closeEnd = closeAt + interpolation.close.length;
        spans.push({ from: closeAt, to: closeEnd, className: "tok-operator" });
        stringStart = closeEnd;
        index = closeEnd;
        continue;
      }
      return limit;
    }
    index += 1;
  }
  if (limit > stringStart) {
    spans.push({ from: stringStart, to: limit, className: "tok-string" });
  }
  return limit;
}

/**
 * Scans source into token spans using only the language's lexical syntax.
 *
 * The scan recognizes comments, quoted runs, interpolations, numbers and
 * identifiers, which is everything the shared classifier can decide without a
 * parse tree.
 */
function lexicalTokenSpans(
  source: string,
  syntax: LexicalSyntax,
  from = 0,
  to = source.length,
) {
  const spans: TokenSpan[] = [];
  let index = from;
  while (index < to) {
    const character = source[index] ?? "";
    const block = blockAt(source, index, syntax.blockComments);
    if (block) {
      const closing = source.indexOf(block[1], index + block[0].length);
      const end = closing < 0 || closing >= to ? to : closing + block[1].length;
      spans.push({ from: index, to: end, className: "tok-comment" });
      index = end;
      continue;
    }
    const lineComment = markerAt(source, index, syntax.lineComments);
    if (lineComment) {
      const newline = source.indexOf("\n", index);
      const end = newline < 0 || newline >= to ? to : newline;
      spans.push({ from: index, to: end, className: "tok-comment" });
      index = end;
      continue;
    }
    if (
      syntax.directive &&
      source.startsWith(syntax.directive, index) &&
      atLineStart(source, index)
    ) {
      let end = index + syntax.directive.length;
      while (end < to && identifierBody.test(source[end] ?? "")) end += 1;
      spans.push({ from: index, to: end, className: "tok-meta" });
      index = end;
      continue;
    }
    if (syntax.quotes.includes(character)) {
      index = emitQuoted(source, index, character, syntax, spans, to);
      continue;
    }
    if (/\d/.test(character)) {
      const end = Math.min(to, endOfNumber(source, index));
      const value = source.slice(index, end);
      spans.push({
        from: index,
        to: end,
        className: numericLiteralPattern.test(value)
          ? "tok-number"
          : lexicalValueClass(value),
      });
      index = end;
      continue;
    }
    if (identifierStart.test(character)) {
      let end = index + 1;
      while (end < to && identifierBody.test(source[end] ?? "")) end += 1;
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
