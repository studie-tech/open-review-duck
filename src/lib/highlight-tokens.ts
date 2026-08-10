export interface SyntaxToken {
  className: string;
  text: string;
  from: number;
  to: number;
}

export interface HighlightedLine {
  text: string;
  tokens: SyntaxToken[];
}

/** One classified, non-overlapping byte range of a source document. */
export interface TokenSpan {
  from: number;
  to: number;
  className: string;
}

export const keywords = new Set([
  "abstract",
  "alias",
  "and",
  "as",
  "async",
  "await",
  "begin",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "default",
  "defer",
  "do",
  "else",
  "elseif",
  "elsif",
  "end",
  "enum",
  "except",
  "export",
  "extends",
  "extern",
  "false",
  "final",
  "finally",
  "fn",
  "for",
  "foreach",
  "from",
  "fun",
  "function",
  "go",
  "if",
  "implements",
  "import",
  "in",
  "interface",
  "internal",
  "is",
  "lambda",
  "let",
  "local",
  "match",
  "mod",
  "module",
  "namespace",
  "new",
  "nil",
  "none",
  "not",
  "null",
  "operator",
  "or",
  "package",
  "private",
  "protected",
  "public",
  "readonly",
  "record",
  "repeat",
  "require",
  "rescue",
  "return",
  "sealed",
  "static",
  "struct",
  "switch",
  "then",
  "throw",
  "trait",
  "true",
  "try",
  "type",
  "typedef",
  "union",
  "unless",
  "until",
  "use",
  "using",
  "val",
  "var",
  "virtual",
  "when",
  "where",
  "while",
  "with",
  "yield",
]);

export const builtinTypes = new Set([
  "any",
  "bool",
  "boolean",
  "byte",
  "char",
  "decimal",
  "double",
  "float",
  "int",
  "integer",
  "long",
  "never",
  "number",
  "object",
  "short",
  "str",
  "string",
  "symbol",
  "uint",
  "ulong",
  "unknown",
  "ushort",
  "void",
]);

export const numericLiteralPattern =
  /^(?:0[xob])?[\d_]+(?:\.[\d_]+)?(?:e[+-]?[\d_]+)?$/i;

/**
 * Classifies a token from its text alone, without any grammar knowledge.
 *
 * Both the grammar-backed and the lexical highlighter end in these same
 * language-independent rules, so a token only changes class between the two
 * passes when the grammar contributes structure the text cannot express.
 */
export function lexicalValueClass(value: string) {
  const lower = value.toLowerCase();
  if (keywords.has(lower)) {
    return lower === "true" || lower === "false" ? "tok-bool" : "tok-keyword";
  }
  if (builtinTypes.has(lower)) return "tok-typeName";
  if (/^[A-Z][\w$]*$/.test(value)) return "tok-typeName";
  if (/^[A-Za-z_$][\w$]*$/.test(value)) return "tok-variableName";
  if (/^\s+$/.test(value)) return "";
  return "tok-operator";
}

/** Splits unparsed source into unstyled highlighted lines. */
export function plainLines(source: string) {
  let offset = 0;
  return source.split("\n").map((text) => {
    const line: HighlightedLine = {
      text,
      tokens: text
        ? [{ className: "", text, from: offset, to: offset + text.length }]
        : [],
    };
    offset += text.length + 1;
    return line;
  });
}

/**
 * Projects classified spans onto line-local token spans.
 *
 * Spans arrive sorted and non-overlapping, so one forward cursor walks them
 * alongside the lines instead of rescanning every span for every line.
 */
export function linesFromSpans(source: string, spans: TokenSpan[]) {
  const lines: HighlightedLine[] = [];
  let absoluteOffset = 0;
  let spanIndex = 0;
  for (const text of source.split("\n")) {
    const lineStart = absoluteOffset;
    const lineEnd = lineStart + text.length;
    const tokens: SyntaxToken[] = [];
    let cursor = lineStart;
    while (spanIndex < spans.length && (spans[spanIndex]?.to ?? 0) <= lineStart)
      spanIndex += 1;
    for (let index = spanIndex; index < spans.length; index += 1) {
      const span = spans[index];
      if (!span || span.from >= lineEnd) break;
      const from = Math.max(lineStart, span.from);
      const to = Math.min(lineEnd, span.to);
      if (to <= from) continue;
      if (from > cursor) {
        tokens.push({
          className: "",
          text: source.slice(cursor, from),
          from: cursor,
          to: from,
        });
      }
      const previous = tokens.at(-1);
      const value = source.slice(from, to);
      if (previous?.className === span.className && previous.to === from) {
        previous.text += value;
        previous.to = to;
      } else {
        tokens.push({ className: span.className, text: value, from, to });
      }
      cursor = Math.max(cursor, to);
    }
    if (cursor < lineEnd) {
      tokens.push({
        className: "",
        text: source.slice(cursor, lineEnd),
        from: cursor,
        to: lineEnd,
      });
    }
    lines.push({ text, tokens });
    absoluteOffset = lineEnd + 1;
  }
  return lines;
}
