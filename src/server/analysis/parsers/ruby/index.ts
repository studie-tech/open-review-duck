import type {
  AnalyzedUnit,
  LanguageAdapter,
  SourceFile,
  UnitKind,
} from "../../types";
import { supportedExtensions, supportedFileNames } from "../../types";
import { makeUnit, type SourceRange } from "../shared";

export const rubyExtensions = supportedExtensions.ruby;
export const rubyFileNames = supportedFileNames.ruby;

interface RubyLine {
  from: number;
  to: number;
  text: string;
  structural: string;
}

interface RubyToken {
  value: string;
  from: number;
  to: number;
  line: number;
}

interface RubyDeclaration {
  type: "namespace" | "method" | "test_suite" | "test" | "test_hook";
  name: string;
  qualifiedName: string;
  owner?: string;
  classMethod?: boolean;
  header: SourceRange;
  review: SourceRange;
  full: SourceRange;
  references: string[];
  inheritance?: string;
}

interface PendingUnit {
  unit: Omit<AnalyzedUnit, "depth" | "reviewOrder">;
  qualifiedName: string;
  owner?: string;
  references: string[];
  shell?: boolean;
}

const rubyKeywords = new Set([
  "BEGIN",
  "END",
  "alias",
  "and",
  "begin",
  "break",
  "case",
  "class",
  "def",
  "defined?",
  "do",
  "else",
  "elsif",
  "end",
  "ensure",
  "false",
  "for",
  "if",
  "in",
  "module",
  "next",
  "nil",
  "not",
  "or",
  "redo",
  "rescue",
  "retry",
  "return",
  "self",
  "super",
  "then",
  "true",
  "undef",
  "unless",
  "until",
  "when",
  "while",
  "yield",
]);

const suiteCalls = new Set([
  "describe",
  "context",
  "feature",
  "shared_context",
  "shared_examples",
  "shared_examples_for",
]);
const exampleCalls = new Set(["example", "it", "scenario", "specify", "test"]);
const hookCalls = new Set([
  "after",
  "around",
  "before",
  "let",
  "let!",
  "setup",
  "subject",
  "subject!",
  "teardown",
]);

/** Replaces Ruby literals and comments with spaces while preserving offsets. */
function maskRubySource(source: string) {
  const masked = [...source];
  /** Blanks a literal range without moving newline offsets. */
  const blank = (from: number, to: number) => {
    for (let index = from; index < to; index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
    }
  };
  /** Returns the matching delimiter for a percent literal. */
  const pairedDelimiter = (opening: string) =>
    ({ "(": ")", "[": "]", "{": "}", "<": ">" })[opening] ?? opening;
  /** Reads the word directly preceding a possible regular expression. */
  const previousWord = (offset: number) =>
    source.slice(0, offset).match(/([A-Za-z_]\w*[!?=]?)\s*$/)?.[1];
  /** Distinguishes a regular-expression opener from division. */
  const regexStartsExpression = (offset: number) => {
    const before = source.slice(0, offset);
    const significant = before.match(/\S(?=\s*$)/)?.[0];
    if (!significant || /[=([{,:;!&|?~+\-*%^<>]/.test(significant)) return true;
    return new Set([
      "and",
      "case",
      "do",
      "elsif",
      "if",
      "in",
      "not",
      "or",
      "rescue",
      "return",
      "then",
      "unless",
      "until",
      "when",
      "while",
      "yield",
    ]).has(previousWord(offset) ?? "");
  };

  let index = 0;
  while (index < source.length) {
    const lineStart = index === 0 || source[index - 1] === "\n";
    if (lineStart && source.startsWith("=begin", index)) {
      const close = source.slice(index).search(/^=end\b.*$/m);
      const to =
        close < 0 ? source.length : source.indexOf("\n", index + close) + 1;
      blank(index, to > 0 ? to : source.length);
      index = to > 0 ? to : source.length;
      continue;
    }
    const character = source[index] ?? "";
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "#") {
      const newline = source.indexOf("\n", index + 1);
      const to = newline < 0 ? source.length : newline;
      blank(index, to);
      index = to;
      continue;
    }
    if (["'", '"', "`"].includes(character)) {
      const quote = character;
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        end += 1;
        if (source[end - 1] === quote) break;
      }
      blank(index, Math.min(end, source.length));
      index = end;
      continue;
    }
    if (character === "%" && /[qQwWiIrxXs({[<]/.test(source[index + 1] ?? "")) {
      let delimiterIndex = index + 1;
      if (/[qQwWiIrxXs]/.test(source[delimiterIndex] ?? ""))
        delimiterIndex += 1;
      const opening = source[delimiterIndex] ?? "";
      if (opening && !/[A-Za-z0-9\s]/.test(opening)) {
        const closing = pairedDelimiter(opening);
        const paired = closing !== opening;
        let depth = 1;
        let end = delimiterIndex + 1;
        while (end < source.length && depth > 0) {
          if (source[end] === "\\") {
            end += 2;
            continue;
          }
          if (paired && source[end] === opening) depth += 1;
          if (source[end] === closing) depth -= 1;
          end += 1;
        }
        while (/[a-z]/i.test(source[end] ?? "")) end += 1;
        blank(index, end);
        index = end;
        continue;
      }
    }
    if (character === "/" && regexStartsExpression(index)) {
      let end = index + 1;
      let inCharacterClass = false;
      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === "[") inCharacterClass = true;
        if (source[end] === "]") inCharacterClass = false;
        end += 1;
        if (source[end - 1] === "/" && !inCharacterClass) break;
      }
      while (/[a-z]/i.test(source[end] ?? "")) end += 1;
      blank(index, end);
      index = end;
      continue;
    }
    if (source.startsWith("<<", index)) {
      const linePrefix = source.slice(
        source.lastIndexOf("\n", index - 1) + 1,
        index,
      );
      if (/\bclass\s*$/.test(linePrefix)) {
        index += 2;
        continue;
      }
      const match = /^<<[-~]?\s*(['"`]?)([A-Za-z_]\w*)\1/.exec(
        source.slice(index),
      );
      if (match) {
        const newline = source.indexOf("\n", index + match[0].length);
        if (newline >= 0) {
          let cursor = newline + 1;
          const delimiter = match[2] ?? "";
          while (cursor < source.length) {
            const next = source.indexOf("\n", cursor);
            const to = next < 0 ? source.length : next + 1;
            const candidate = source
              .slice(cursor, next < 0 ? source.length : next)
              .trim();
            blank(cursor, to);
            cursor = to;
            if (candidate === delimiter) break;
          }
          index += match[0].length;
          continue;
        }
      }
    }
    index += 1;
  }
  return masked.join("");
}

/** Splits original and masked Ruby source into aligned lines. */
function sourceLines(source: string, structural: string) {
  const lines: RubyLine[] = [];
  let offset = 0;
  for (const text of source.split(/(?<=\n)/)) {
    const from = offset;
    const to = from + text.length;
    lines.push({ from, to, text, structural: structural.slice(from, to) });
    offset = to;
  }
  return lines;
}

/** Tokenizes only structural Ruby syntax retained by the masker. */
function tokenizeRuby(lines: RubyLine[]) {
  const tokens: RubyToken[] = [];
  const tokenPattern =
    /::|&\.|=>|===|<=>|==|!=|<=|>=|=~|!~|\*\*|<<|>>|\[\]=?|[A-Za-z_]\w*[!?=]?|@@?[A-Za-z_]\w*|\$[A-Za-z_]\w*|\d+(?:\.\d+)?|[{}()[\];,.=:+\-*/><>|&^~]/g;
  lines.forEach((line, lineIndex) => {
    tokenPattern.lastIndex = 0;
    for (const match of line.structural.matchAll(tokenPattern)) {
      const from = line.from + (match.index ?? 0);
      tokens.push({
        value: match[0],
        from,
        to: from + match[0].length,
        line: lineIndex,
      });
    }
  });
  return tokens;
}

/** Pairs Ruby keyword blocks and structural braces. */
function blockPairs(tokens: RubyToken[], lines: RubyLine[]) {
  const pairs = new Map<number, number>();
  const stack: Array<{ index: number; type: string }> = [];
  const openingKeywords = new Set([
    "begin",
    "case",
    "class",
    "def",
    "for",
    "module",
  ]);
  const conditionalKeywords = new Set(["if", "unless", "until", "while"]);
  const expressionPredecessors = new Set([
    "(",
    "[",
    "{",
    ",",
    ";",
    "=",
    "=>",
    "and",
    "do",
    "else",
    "elsif",
    "ensure",
    "in",
    "or",
    "rescue",
    "return",
    "then",
    "when",
  ]);
  /** Checks whether a def token starts an endless method. */
  const endlessDefinition = (token: RubyToken) => {
    const line = lines[token.line]?.structural.trim() ?? "";
    return /^def\s+(?:(?:self|[A-Z]\w*(?:::[A-Z]\w*)*)\.)?(?:[A-Za-z_]\w*[!?=]?|\[\]=?|[-+*/%<>=~`|&^]+)(?:\s*\([^)]*\))?\s+=\s*\S/.test(
      line,
    );
  };

  tokens.forEach((token, index) => {
    if (["{", "(", "["].includes(token.value)) {
      stack.push({ index, type: token.value });
      return;
    }
    if (["}", ")", "]"].includes(token.value)) {
      const expected = { "}": "{", ")": "(", "]": "[" }[token.value];
      for (let cursor = stack.length - 1; cursor >= 0; cursor -= 1) {
        if (stack[cursor]?.type !== expected) continue;
        const opener = stack.splice(cursor, 1)[0];
        if (opener) {
          pairs.set(opener.index, index);
          pairs.set(index, opener.index);
        }
        break;
      }
      return;
    }
    if (token.value === "end") {
      for (let cursor = stack.length - 1; cursor >= 0; cursor -= 1) {
        if (["{", "(", "["].includes(stack[cursor]?.type ?? "")) continue;
        const opener = stack.splice(cursor, 1)[0];
        if (opener) {
          pairs.set(opener.index, index);
          pairs.set(index, opener.index);
        }
        break;
      }
      return;
    }
    if (openingKeywords.has(token.value)) {
      if (token.value !== "def" || !endlessDefinition(token)) {
        stack.push({ index, type: token.value });
      }
      return;
    }
    if (conditionalKeywords.has(token.value)) {
      const previous = tokens[index - 1];
      const firstOnLine = !previous || previous.line !== token.line;
      if (firstOnLine || expressionPredecessors.has(previous?.value ?? "")) {
        stack.push({ index, type: token.value });
      }
      return;
    }
    if (token.value === "do") {
      const lineTokens = tokens
        .slice(0, index)
        .filter((candidate) => candidate.line === token.line);
      const alreadyOpenedLoop = lineTokens.some((candidate) =>
        new Set(["for", "until", "while"]).has(candidate.value),
      );
      if (!alreadyOpenedLoop) stack.push({ index, type: "do" });
    }
  });
  return pairs;
}

/** Converts an inclusive Ruby line span to source offsets. */
function lineRange(lines: RubyLine[], start: number, end: number): SourceRange {
  return {
    from: lines[start]?.from ?? 0,
    to: lines[end]?.to ?? lines.at(-1)?.to ?? 0,
  };
}

/** Includes attached YARD comments while excluding magic comments. */
function documentedStart(lines: RubyLine[], declarationLine: number) {
  let start = declarationLine;
  for (let index = declarationLine - 1; index >= 0; index -= 1) {
    const text = lines[index]?.text.replace(/\r?\n$/, "") ?? "";
    if (
      /^\s*#/.test(text) &&
      !/^\s*#\s*(?:frozen_string_literal|encoding|coding)\s*:/.test(text)
    ) {
      start = index;
      continue;
    }
    break;
  }
  return start;
}

/** Resolves a block opener to its complete source-line range. */
function closingRange(
  tokens: RubyToken[],
  pairs: ReadonlyMap<number, number>,
  lines: RubyLine[],
  openerIndex: number | undefined,
  fallbackLine: number,
) {
  if (openerIndex === undefined)
    return lineRange(lines, fallbackLine, fallbackLine);
  const closingIndex = pairs.get(openerIndex);
  const closing = closingIndex === undefined ? undefined : tokens[closingIndex];
  return lineRange(lines, fallbackLine, closing?.line ?? fallbackLine);
}

/** Finds the first requested structural token on a line. */
function firstTokenOnLine(tokens: RubyToken[], line: number, value?: string) {
  return tokens.findIndex(
    (token) =>
      token.line === line && (value === undefined || token.value === value),
  );
}

/** Finds a paired do or brace block opener on a line. */
function blockTokenOnLine(
  tokens: RubyToken[],
  pairs: ReadonlyMap<number, number>,
  line: number,
) {
  return tokens.findIndex(
    (token, index) =>
      token.line === line &&
      ["do", "{"].includes(token.value) &&
      pairs.has(index),
  );
}

/** Extracts a readable static label from a Ruby DSL call. */
function staticRubyLabel(text: string) {
  const trimmed = text.trim();
  const quoted = /(?:^|[,(\s])(["'])(.*?)(?<!\\)\1/.exec(trimmed)?.[2];
  if (quoted)
    return quoted
      .replace(/\\([\\'"])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  const argument = trimmed
    .replace(/^\s*(?:RSpec\.)?\w+[!?]?\s*(?:\()?/, "")
    .replace(/\)?\s*(?:do|\{).*$/, "")
    .replace(/,\s*[^,]+$/, "")
    .trim();
  return argument || "anonymous";
}

/** Estimates Ruby review complexity from branching constructs. */
function complexityOf(source: string) {
  return Math.max(
    1,
    1 +
      (source.match(
        /\b(?:and|case|elsif|ensure|for|if|or|rescue|unless|until|when|while)\b|&&|\|\|/g,
      )?.length ?? 0),
  );
}

/** Collects possible same-file declaration references. */
function referenceNames(source: string) {
  const structural = maskRubySource(source);
  const found = new Set<string>();
  for (const match of structural.matchAll(
    /(?<![:@$.])\b[A-Za-z_]\w*[!?]?\b|\b[A-Z]\w*(?:::[A-Z]\w*)*\b/g,
  )) {
    const name = match[0];
    if (!rubyKeywords.has(name)) found.add(name);
  }
  return [...found];
}

/** Finds the innermost accepted declaration containing an offset. */
function scopeContaining(
  declarations: RubyDeclaration[],
  offset: number,
  accepted: ReadonlySet<RubyDeclaration["type"]>,
) {
  return declarations
    .filter(
      (declaration) =>
        accepted.has(declaration.type) &&
        declaration.full.from < offset &&
        offset < declaration.full.to,
    )
    .sort((left, right) => right.full.from - left.full.from)[0];
}

/** Qualifies a Ruby namespace without duplicating explicit paths. */
function qualifyNamespace(owner: string | undefined, name: string) {
  if (!owner || name.includes("::")) return name;
  return `${owner}::${name}`;
}

/** Recognizes Ruby require, load, and autoload context lines. */
function importLine(structural: string) {
  return /^\s*(?:(?:require|require_relative|load)\s*(?:\(?\s*)[^\n]+|autoload\s+:[A-Za-z_]\w*\s*,\s*[^\n]+)\s*$/.test(
    structural.replace(/;\s*$/, ""),
  );
}

/** True when Ruby source contains only inert preamble and load declarations. */
export function isContextOnly(source: string) {
  const structural = maskRubySource(source);
  return sourceLines(source, structural).every((line) => {
    const original = line.text.trim();
    const code = line.structural.trim();
    return (
      !code ||
      original.startsWith("#!") ||
      /^#\s*(?:frozen_string_literal|encoding|coding)\s*:/.test(original) ||
      importLine(line.structural)
    );
  });
}

/** Parses namespace, method, refinement, and test declarations. */
function parseDeclarations(
  file: SourceFile,
  lines: RubyLine[],
  tokens: RubyToken[],
  pairs: ReadonlyMap<number, number>,
) {
  const declarations: RubyDeclaration[] = [];

  // Namespace declarations are collected first so nested members can be qualified.
  lines.forEach((line, lineIndex) => {
    const code = line.structural.replace(/\r?\n$/, "");
    const namespace =
      /^\s*(class|module)\s+((?:[A-Z]\w*::)*[A-Z]\w*|<<\s*self)\b(?:\s*<\s*((?:[A-Z]\w*::)*[A-Z]\w*))?/.exec(
        code,
      );
    const refinement = /^\s*refine\s+((?:[A-Z]\w*::)*[A-Z]\w*)\s+do\b/.exec(
      code,
    );
    if (!namespace && !refinement) return;
    const keyword = namespace?.[1] ?? "refine";
    const rawName =
      namespace?.[2] ?? `Refinement(${refinement?.[1] ?? "anonymous"})`;
    const openerIndex =
      keyword === "refine"
        ? blockTokenOnLine(tokens, pairs, lineIndex)
        : firstTokenOnLine(tokens, lineIndex, keyword);
    const full = closingRange(
      tokens,
      pairs,
      lines,
      openerIndex >= 0 ? openerIndex : undefined,
      lineIndex,
    );
    const parent = scopeContaining(
      declarations,
      line.from,
      new Set(["namespace", "test_suite"]),
    );
    const singleton = rawName.replace(/\s+/g, "") === "<<self";
    const owner = parent?.qualifiedName;
    const qualifiedName = singleton
      ? `${owner ?? "Object"}::singleton`
      : qualifyNamespace(owner, rawName);
    const start = documentedStart(lines, lineIndex);
    const testSuite =
      !singleton &&
      (/(?:Test|Spec)$/.test(rawName) ||
        /(?:Minitest::Test|Test::Unit::TestCase)/.test(namespace?.[3] ?? ""));
    declarations.push({
      type: testSuite ? "test_suite" : "namespace",
      name: singleton ? `${owner ?? "Object"} singleton` : rawName,
      qualifiedName,
      owner,
      classMethod: singleton,
      header: lineRange(lines, start, lineIndex),
      review: lineRange(lines, start, lineIndex),
      full,
      references: namespace?.[3] ? [namespace[3]] : [],
      inheritance: namespace?.[3],
    });
  });

  // RSpec-style suites and examples are real hierarchy nodes, not generic setup.
  lines.forEach((line, lineIndex) => {
    const code = line.structural.replace(/\r?\n$/, "");
    const call = /^\s*(?:RSpec\.)?([A-Za-z_]\w*[!?]?)\b/.exec(code)?.[1];
    if (
      !call ||
      (!suiteCalls.has(call) && !exampleCalls.has(call) && !hookCalls.has(call))
    )
      return;
    const openerIndex = blockTokenOnLine(tokens, pairs, lineIndex);
    if (openerIndex < 0) return;
    const full = closingRange(tokens, pairs, lines, openerIndex, lineIndex);
    const parent = scopeContaining(
      declarations,
      line.from,
      new Set(["namespace", "test_suite"]),
    );
    const label = hookCalls.has(call) ? call : staticRubyLabel(line.text);
    const owner = parent?.qualifiedName;
    const displayOwner = parent?.name;
    const type = suiteCalls.has(call)
      ? "test_suite"
      : hookCalls.has(call)
        ? "test_hook"
        : "test";
    const qualifiedName = `${owner ?? "RSpec"}::${type}:${label}`;
    const start = documentedStart(lines, lineIndex);
    declarations.push({
      type,
      name: displayOwner ? `${displayOwner} › ${label}` : label,
      qualifiedName,
      owner,
      header: lineRange(lines, start, lineIndex),
      review:
        type === "test_suite"
          ? lineRange(lines, start, lineIndex)
          : { from: lines[start]?.from ?? line.from, to: full.to },
      full,
      references: referenceNames(file.content.slice(line.from, full.to)),
    });
  });

  // Methods are parsed after namespace and RSpec ranges are known.
  lines.forEach((line, lineIndex) => {
    const code = line.structural.replace(/\r?\n$/, "");
    const match =
      /^\s*def\s+(?:(self|(?:[A-Z]\w*::)*[A-Z]\w*)\.)?([A-Za-z_]\w*[!?=]?|\[\]=?|[-+*/%<>=~`|&^]+)/.exec(
        code,
      );
    if (!match) return;
    const openerIndex = firstTokenOnLine(tokens, lineIndex, "def");
    const full = closingRange(
      tokens,
      pairs,
      lines,
      openerIndex >= 0 ? openerIndex : undefined,
      lineIndex,
    );
    const namespace = scopeContaining(
      declarations,
      line.from,
      new Set(["namespace", "test_suite"]),
    );
    const rspec = scopeContaining(
      declarations,
      line.from,
      new Set(["test_suite"]),
    );
    const rawName = match[2] ?? "anonymous";
    const owner = namespace?.qualifiedName;
    const singletonOwner = namespace?.qualifiedName.endsWith("::singleton");
    const realOwner = singletonOwner ? namespace?.owner : owner;
    const classMethod = Boolean(match[1] || singletonOwner);
    const inTest = Boolean(
      rspec ||
        namespace?.type === "test_suite" ||
        /(?:^|\/)(?:test|spec)(?:\/|_)/i.test(file.path),
    );
    const type =
      inTest && /^test_/.test(rawName)
        ? "test"
        : inTest &&
            new Set([
              "setup",
              "teardown",
              "before_setup",
              "after_teardown",
            ]).has(rawName)
          ? "test_hook"
          : "method";
    const stableOwner = realOwner ?? "Object";
    const qualifiedName = `${stableOwner}::${classMethod ? "self." : ""}${rawName}`;
    const display =
      type === "test" || type === "test_hook"
        ? `${namespace?.name ?? "Ruby tests"} › ${rawName}`
        : realOwner
          ? `${realOwner}${classMethod ? "." : "#"}${rawName}`
          : rawName;
    const start = documentedStart(lines, lineIndex);
    declarations.push({
      type,
      name: display,
      qualifiedName,
      owner: namespace?.qualifiedName,
      classMethod,
      header: lineRange(lines, start, lineIndex),
      review: { from: lines[start]?.from ?? line.from, to: full.to },
      full,
      references: referenceNames(file.content.slice(line.from, full.to)),
    });
  });

  return declarations.sort(
    (left, right) =>
      left.full.from - right.full.from || right.full.to - left.full.to,
  );
}

/** Checks whether an offset belongs to an executable declaration body. */
function declarationOccupied(declarations: RubyDeclaration[], offset: number) {
  return declarations.some(
    (declaration) =>
      declaration.type !== "namespace" &&
      declaration.type !== "test_suite" &&
      declaration.full.from <= offset &&
      offset < declaration.full.to,
  );
}

/** Extends a Ruby assignment through paired blocks and continuations. */
function assignmentEnd(
  lineIndex: number,
  lines: RubyLine[],
  tokens: RubyToken[],
  pairs: ReadonlyMap<number, number>,
) {
  const tokensOnLine = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => token.line === lineIndex);
  let endLine = lineIndex;
  for (const { index } of tokensOnLine) {
    const closing = pairs.get(index);
    if (closing !== undefined)
      endLine = Math.max(endLine, tokens[closing]?.line ?? lineIndex);
  }
  while (
    endLine + 1 < lines.length &&
    /(?:\\|[,=+\-*/|&.]|\b(?:and|or))\s*$/.test(
      lines[endLine]?.structural.trimEnd() ?? "",
    )
  ) {
    endLine += 1;
  }
  return endLine;
}

/** Recognizes safe named method, alias, attribute, and delegation macros. */
function macroDefinition(line: RubyLine) {
  const code = line.structural.trim();
  const original = line.text.trim();
  const define =
    /^(define_method|define_singleton_method)\s*(?:\(\s*)?([:"'])([A-Za-z_]\w*[!?=]?)/.exec(
      original,
    );
  if (define)
    return {
      label: define[3] ?? "anonymous",
      classMethod: define[1] === "define_singleton_method",
    };
  const alias =
    /^(?:alias_method\s*(?:\(\s*)?|alias\s+)(?::|["']?)([A-Za-z_]\w*[!?=]?)/.exec(
      original,
    );
  if (alias) return { label: `alias ${alias[1]}`, classMethod: false };
  const delegate = /^(?:delegate|def_delegator|def_delegators)\b/.test(code);
  if (delegate) {
    const definitionPart = original.startsWith("delegate")
      ? (original.split(/\bto\s*:/, 1)[0] ?? original)
      : original;
    const names = [...definitionPart.matchAll(/:([A-Za-z_]\w*[!?=]?)/g)].map(
      (match) => match[1],
    );
    const relevant = original.startsWith("delegate")
      ? names.filter((name) => name !== "to")
      : names.slice(1);
    if (relevant.length > 0)
      return { label: `delegates ${relevant.join(", ")}`, classMethod: false };
  }
  const attributes =
    /^(?:attr|attr_reader|attr_writer|attr_accessor|mattr_reader|mattr_writer|mattr_accessor|cattr_reader|cattr_writer|cattr_accessor)\b/.test(
      code,
    );
  if (attributes) {
    const names = [...original.matchAll(/:([A-Za-z_]\w*[!?=]?)/g)].map(
      (match) => match[1],
    );
    if (names.length > 0)
      return { label: `attributes ${names.join(", ")}`, classMethod: false };
  }
  return undefined;
}

/** Converts parsed declarations and remaining setup into pending units. */
function buildPendingUnits(
  file: SourceFile,
  lines: RubyLine[],
  tokens: RubyToken[],
  pairs: ReadonlyMap<number, number>,
  declarations: RubyDeclaration[],
) {
  const pending: PendingUnit[] = [];
  const occupied: SourceRange[] = [];
  /** Reserves a source range for a semantic unit. */
  const mark = (range: SourceRange) => occupied.push(range);
  /** Checks whether a source range overlaps an existing unit. */
  const isOccupied = (from: number, to = from + 1) =>
    occupied.some((range) => range.from < to && from < range.to);

  for (const declaration of declarations) {
    const kind: UnitKind =
      declaration.type === "namespace"
        ? "class"
        : declaration.type === "method"
          ? "method"
          : declaration.type;
    const source = file.content.slice(
      declaration.review.from,
      declaration.review.to,
    );
    const unit = makeUnit(
      file,
      "ruby",
      kind,
      declaration.name,
      declaration.review,
      [],
      complexityOf(source),
      declaration.qualifiedName,
    );
    pending.push({
      unit: {
        ...unit,
        signature: file.content
          .slice(declaration.header.from, declaration.header.to)
          .trim()
          .split("\n")
          .at(-1),
      },
      qualifiedName: declaration.qualifiedName,
      owner: declaration.owner,
      references: declaration.references,
      shell:
        declaration.type === "namespace" || declaration.type === "test_suite",
    });
    if (declaration.type !== "namespace" && declaration.type !== "test_suite") {
      mark(declaration.full);
    }
  }

  lines.forEach((line, lineIndex) => {
    if (isOccupied(line.from) || declarationOccupied(declarations, line.from))
      return;
    const code = line.structural.trim();
    if (!code || importLine(line.structural)) {
      if (importLine(line.structural))
        mark(lineRange(lines, lineIndex, lineIndex));
      return;
    }
    const namespace = scopeContaining(
      declarations,
      line.from,
      new Set(["namespace", "test_suite"]),
    );
    const insideMethod = declarations.some(
      (declaration) =>
        ["method", "test", "test_hook"].includes(declaration.type) &&
        declaration.full.from < line.from &&
        line.from < declaration.full.to,
    );
    if (insideMethod) return;

    const macro = macroDefinition(line);
    if (macro) {
      const endLine = assignmentEnd(lineIndex, lines, tokens, pairs);
      const start = documentedStart(lines, lineIndex);
      const range = lineRange(lines, start, endLine);
      const owner = namespace?.qualifiedName;
      const qualifiedName = `${owner ?? "Object"}::${macro.classMethod ? "self." : ""}${macro.label}`;
      pending.push({
        unit: makeUnit(
          file,
          "ruby",
          "method",
          owner ? `${owner}#${macro.label}` : macro.label,
          range,
          [],
          complexityOf(file.content.slice(range.from, range.to)),
          qualifiedName,
        ),
        qualifiedName,
        owner,
        references: referenceNames(file.content.slice(line.from, range.to)),
      });
      mark(range);
      return;
    }

    const assignment =
      /^\s*([A-Z]\w*|@@?[A-Za-z_]\w*|[a-z_]\w*)\s*(?:\|\|=|&&=|=)(?!=|>)/.exec(
        line.structural,
      );
    if (!assignment) return;
    const rawName = assignment[1] ?? "anonymous";
    const endLine = assignmentEnd(lineIndex, lines, tokens, pairs);
    const start = documentedStart(lines, lineIndex);
    const range = lineRange(lines, start, endLine);
    const owner = namespace?.qualifiedName;
    const name = owner ? `${owner}::${rawName}` : rawName;
    const kind: UnitKind = /^[A-Z]/.test(rawName) ? "constant" : "variable";
    pending.push({
      unit: makeUnit(
        file,
        "ruby",
        kind,
        name,
        range,
        [],
        complexityOf(file.content.slice(range.from, range.to)),
        name,
      ),
      qualifiedName: name,
      owner,
      references: referenceNames(file.content.slice(line.from, range.to)),
    });
    mark(range);
  });

  let scopedSetupIndex = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line || isOccupied(line.from) || !line.structural.trim()) continue;
    const namespace = scopeContaining(
      declarations,
      line.from,
      new Set(["namespace", "test_suite"]),
    );
    if (!namespace) continue;
    const startsDeclaration = declarations.some(
      (declaration) => declaration.full.from === line.from,
    );
    if (
      startsDeclaration ||
      /^\s*end\b/.test(line.structural) ||
      importLine(line.structural)
    ) {
      continue;
    }
    let endLine = assignmentEnd(lineIndex, lines, tokens, pairs);
    while (endLine + 1 < lines.length) {
      const next = lines[endLine + 1];
      if (
        !next ||
        isOccupied(next.from) ||
        !next.structural.trim() ||
        /^\s*end\b/.test(next.structural) ||
        importLine(next.structural)
      ) {
        break;
      }
      const nextNamespace = scopeContaining(
        declarations,
        next.from,
        new Set(["namespace", "test_suite"]),
      );
      if (
        nextNamespace !== namespace ||
        declarations.some((declaration) => declaration.full.from === next.from)
      ) {
        break;
      }
      endLine = assignmentEnd(endLine + 1, lines, tokens, pairs);
    }
    const start = documentedStart(lines, lineIndex);
    const range = lineRange(lines, start, endLine);
    const heading = [
      ...file.content.slice(range.from, line.from).matchAll(/^\s*#\s*(.+)$/gm),
    ]
      .at(-1)?.[1]
      ?.trim();
    const testSetup = namespace.type === "test_suite";
    const name =
      heading ||
      (testSetup
        ? `${namespace.name} › Test setup`
        : `${namespace.name} class setup`);
    const qualifiedName = `${namespace.qualifiedName}::setup:${scopedSetupIndex}:${name}`;
    pending.push({
      unit: makeUnit(
        file,
        "ruby",
        testSetup ? "test_hook" : "module",
        name,
        range,
        [],
        complexityOf(file.content.slice(range.from, range.to)),
        qualifiedName,
      ),
      qualifiedName,
      owner: namespace.qualifiedName,
      references: referenceNames(file.content.slice(line.from, range.to)),
    });
    mark(range);
    scopedSetupIndex += 1;
    lineIndex = endLine;
  }

  // Shells expose only their headers for review, but their complete bodies are
  // excluded from generic setup after direct members have been extracted.
  for (const declaration of declarations) {
    if (declaration.type === "namespace" || declaration.type === "test_suite") {
      mark(declaration.full);
    }
  }

  // Remaining top-level statements are coherent setup phases. Namespace bodies are
  // already occupied wholesale, so only executable file-scope work reaches here.
  let setupIndex = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line || isOccupied(line.from) || !line.structural.trim()) continue;
    if (line.text.trim().startsWith("#!") || line.text.trim().startsWith("#"))
      continue;
    let endLine = assignmentEnd(lineIndex, lines, tokens, pairs);
    while (
      endLine + 1 < lines.length &&
      !isOccupied(lines[endLine + 1]?.from ?? 0) &&
      lines[endLine + 1]?.structural.trim() &&
      !importLine(lines[endLine + 1]?.structural ?? "")
    ) {
      endLine = assignmentEnd(endLine + 1, lines, tokens, pairs);
    }
    const start = documentedStart(lines, lineIndex);
    const range = lineRange(lines, start, endLine);
    const heading = [
      ...file.content.slice(range.from, line.from).matchAll(/^\s*#\s*(.+)$/gm),
    ]
      .at(-1)?.[1]
      ?.trim();
    const name =
      heading ||
      (setupIndex === 0 ? "Ruby setup" : `Ruby setup ${setupIndex + 1}`);
    pending.push({
      unit: makeUnit(
        file,
        "ruby",
        "module",
        name,
        range,
        [],
        complexityOf(file.content.slice(range.from, range.to)),
        `setup:${setupIndex}:${name}`,
      ),
      qualifiedName: `setup:${setupIndex}:${name}`,
      references: referenceNames(file.content.slice(line.from, range.to)),
    });
    mark(range);
    setupIndex += 1;
    lineIndex = endLine;
  }
  return pending;
}

/** Resolves Ruby references and direct shell membership to stable keys. */
function connectDependencies(pending: PendingUnit[]) {
  const exact = new Map(
    pending.map((item) => [item.qualifiedName, item.unit.stableKey]),
  );
  const bySimple = new Map<string, string[]>();
  for (const item of pending) {
    const simple =
      item.qualifiedName
        .split("::")
        .at(-1)
        ?.replace(/^self\./, "") ?? item.qualifiedName;
    bySimple.set(simple, [
      ...(bySimple.get(simple) ?? []),
      item.unit.stableKey,
    ]);
  }
  /** Resolves a reference from the nearest lexical namespace. */
  const resolve = (reference: string, owner?: string) => {
    for (
      let scope = owner;
      scope;
      scope = scope.includes("::")
        ? scope.slice(0, scope.lastIndexOf("::"))
        : ""
    ) {
      const local =
        exact.get(`${scope}::${reference}`) ??
        exact.get(`${scope}::self.${reference}`);
      if (local) return local;
    }
    const direct = exact.get(reference);
    if (direct) return direct;
    const candidates = bySimple.get(reference);
    return candidates?.length === 1 ? candidates[0] : undefined;
  };
  return pending
    .map((item) => {
      const memberDependencies = item.shell
        ? pending
            .filter((candidate) => candidate.owner === item.qualifiedName)
            .map((candidate) => candidate.unit.stableKey)
        : [];
      const inferred = item.references
        .map((reference) => resolve(reference, item.owner))
        .filter(
          (key): key is string => Boolean(key) && key !== item.unit.stableKey,
        );
      return {
        ...item.unit,
        dependencies: [
          ...new Set([
            ...item.unit.dependencies,
            ...memberDependencies,
            ...inferred,
          ]),
        ],
      };
    })
    .sort(
      (left, right) =>
        left.startLine - right.startLine || left.endLine - right.endLine,
    );
}

/** Extracts semantic Ruby review units without treating imports as work. */
function analyzeRuby(file: SourceFile) {
  if (!file.content.trim() || isContextOnly(file.content)) return [];
  const structural = maskRubySource(file.content);
  const lines = sourceLines(file.content, structural);
  const tokens = tokenizeRuby(lines);
  const pairs = blockPairs(tokens, lines);
  const declarations = parseDeclarations(file, lines, tokens, pairs);
  return connectDependencies(
    buildPendingUnits(file, lines, tokens, pairs, declarations),
  );
}

export const rubyAdapter: LanguageAdapter = {
  language: "ruby",
  extensions: rubyExtensions,
  fileNames: rubyFileNames,
  matches: ({ content }) => /^#![^\n]*\bruby(?:\s|$)/.test(content),
  isContextOnly,
  analyze: analyzeRuby,
};

export const rubyParserInternals = {
  maskRubySource,
};
