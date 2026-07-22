import { classHighlighter, highlightCode } from "@lezer/highlight";
import { parser as javascriptParser } from "@lezer/javascript";
import { parser as pythonParser } from "@lezer/python";
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

const javascript = javascriptParser.configure({ dialect: "jsx" });
const typescript = javascriptParser.configure({ dialect: "ts jsx" });

/** Selects the syntax parser for a supported source language. */
function parserFor(language: string) {
  if (language === "python") return pythonParser;
  if (language === "typescript") return typescript;
  if (language === "javascript") return javascript;
  return undefined;
}

const genericKeywords = new Set([
  "abstract",
  "async",
  "await",
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
  "enum",
  "export",
  "extends",
  "final",
  "finally",
  "fn",
  "for",
  "foreach",
  "fun",
  "function",
  "go",
  "if",
  "implements",
  "import",
  "in",
  "interface",
  "internal",
  "let",
  "match",
  "module",
  "namespace",
  "new",
  "package",
  "private",
  "protected",
  "public",
  "record",
  "return",
  "sealed",
  "static",
  "struct",
  "switch",
  "trait",
  "try",
  "type",
  "use",
  "using",
  "val",
  "var",
  "virtual",
  "when",
  "while",
]);

/** Provides lightweight highlighting when no Lezer grammar is installed. */
function genericHighlight(source: string, language: string) {
  let lineOffset = 0;
  return source.split("\n").map((text) => {
    const tokens: SyntaxToken[] = [];
    const pattern =
      language === "lua"
        ? /(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(?:\/\/.*|#.*|--.*)|(?:\b\d+(?:\.\d+)?\b)|(?:\$?[A-Za-z_][\w$]*)|(?:=>|->|::|:=|==|!=|<=|>=|&&|\|\||[-+*/%=&|!<>?:~^]+)/g
        : /(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(?:\/\/.*|#.*)|(?:\b\d+(?:\.\d+)?\b)|(?:\$?[A-Za-z_][\w$]*)|(?:=>|->|::|:=|==|!=|<=|>=|&&|\|\||[-+*/%=&|!<>?:~^]+)/g;
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      const from = match.index;
      const value = match[0];
      if (from > cursor) {
        tokens.push({
          text: text.slice(cursor, from),
          className: "",
          from: lineOffset + cursor,
          to: lineOffset + from,
        });
      }
      const className =
        value.startsWith("//") ||
        (language === "lua" && value.startsWith("--")) ||
        (value.startsWith("#") &&
          ["hcl", "makefile", "ruby", "shell"].includes(language))
          ? "tok-comment"
          : value.startsWith("#")
            ? "tok-meta"
            : /^["'`]/.test(value)
              ? "tok-string"
              : /^\d/.test(value)
                ? "tok-number"
                : genericKeywords.has(value)
                  ? "tok-keyword"
                  : /^[A-Z]/.test(value)
                    ? "tok-typeName"
                    : /^[A-Za-z_$]/.test(value)
                      ? "tok-variableName"
                      : "tok-operator";
      tokens.push({
        text: value,
        className,
        from: lineOffset + from,
        to: lineOffset + from + value.length,
      });
      cursor = from + value.length;
    }
    if (cursor < text.length) {
      tokens.push({
        text: text.slice(cursor),
        className: "",
        from: lineOffset + cursor,
        to: lineOffset + text.length,
      });
    }
    const line = { text, tokens };
    lineOffset += text.length + 1;
    return line;
  });
}

/** Converts source code into syntax-highlighted text spans. */
export function highlightSource(source: string, language: string) {
  const parser = parserFor(language);
  if (!parser) return genericHighlight(source, language);
  let currentLine: HighlightedLine = { text: "", tokens: [] };
  const lines: HighlightedLine[] = [currentLine];
  let offset = 0;

  highlightCode(
    source,
    parser.parse(source),
    classHighlighter,
    (text, className) => {
      currentLine.text += text;
      const previous = currentLine.tokens.at(-1);
      if (previous?.className === className) {
        previous.text += text;
        previous.to += text.length;
      } else if (text) {
        currentLine.tokens.push({
          text,
          className,
          from: offset,
          to: offset + text.length,
        });
      }
      offset += text.length;
    },
    () => {
      offset += 1;
      currentLine = { text: "", tokens: [] };
      lines.push(currentLine);
    },
  );

  return lines;
}
