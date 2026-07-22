import type {
  AnalyzedUnit,
  LanguageAdapter,
  SourceFile,
  UnitKind,
} from "../../types";
import { supportedExtensions } from "../../types";
import { makeUnit, type SourceRange } from "../shared";

type ReviewUnit = Omit<AnalyzedUnit, "depth" | "reviewOrder">;

interface PhpToken {
  value: string;
  from: number;
  to: number;
  kind: "identifier" | "variable" | "literal" | "doc" | "symbol";
}

interface PhpUnit extends ReviewUnit {
  /** Qualified declaration name used only while resolving local dependencies. */
  phpName: string;
  /** Qualified name of the directly enclosing class, trait, interface, or enum. */
  owner?: string;
  /** Unresolved names referenced by the declaration. */
  rawDependencies: string[];
}

const typeKeywords = new Set(["class", "interface", "trait", "enum"]);
const visibility = new Set(["public", "protected", "private"]);
const memberModifiers = new Set([
  ...visibility,
  "abstract",
  "final",
  "readonly",
  "static",
  "var",
]);
const lifecycleNames = new Set([
  "setup",
  "teardown",
  "setupbeforeclass",
  "teardownafterclass",
  "assertpreconditions",
  "assertpostconditions",
  "onnotperformingassertions",
]);
const pestTests = new Set(["it", "test"]);
const pestSuites = new Set(["describe", "context"]);
const pestHooks = new Set([
  "beforeall",
  "beforeeach",
  "afterall",
  "aftereach",
  "dataset",
]);
const phpKeywords = new Set([
  "abstract",
  "and",
  "array",
  "as",
  "break",
  "callable",
  "case",
  "catch",
  "class",
  "clone",
  "const",
  "continue",
  "declare",
  "default",
  "do",
  "echo",
  "else",
  "elseif",
  "empty",
  "enddeclare",
  "endfor",
  "endforeach",
  "endif",
  "endswitch",
  "endwhile",
  "enum",
  "eval",
  "exit",
  "extends",
  "final",
  "finally",
  "fn",
  "for",
  "foreach",
  "function",
  "global",
  "goto",
  "if",
  "implements",
  "include",
  "include_once",
  "instanceof",
  "insteadof",
  "interface",
  "isset",
  "list",
  "match",
  "namespace",
  "new",
  "or",
  "print",
  "private",
  "protected",
  "public",
  "readonly",
  "require",
  "require_once",
  "return",
  "static",
  "switch",
  "throw",
  "trait",
  "try",
  "unset",
  "use",
  "var",
  "while",
  "xor",
  "yield",
]);

/** Tokenizes PHP while keeping comments, strings, and heredoc bodies opaque. */
function tokenizePhp(source: string) {
  const tokens: PhpToken[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? "";
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    const tag = ["<?php", "<?=", "<?", "?>"].find((candidate) =>
      source.startsWith(candidate, index),
    );
    if (tag) {
      tokens.push({
        value: tag,
        from: index,
        to: index + tag.length,
        kind: "symbol",
      });
      index += tag.length;
      continue;
    }
    if (source.startsWith("//", index) || source.startsWith("#", index)) {
      if (source.startsWith("#[", index)) {
        tokens.push({ value: "#", from: index, to: index + 1, kind: "symbol" });
        index += 1;
        continue;
      }
      const newline = source.indexOf("\n", index + 1);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const from = index;
      const close = source.indexOf("*/", index + 2);
      index = close < 0 ? source.length : close + 2;
      if (source.startsWith("/**", from)) {
        tokens.push({ value: "<doc>", from, to: index, kind: "doc" });
      }
      continue;
    }
    if (source.startsWith("<<<", index)) {
      const openingEnd = source.indexOf("\n", index + 3);
      const opening = source.slice(
        index + 3,
        openingEnd < 0 ? source.length : openingEnd,
      );
      const label = /^\s*["']?([A-Za-z_]\w*)["']?\s*;?\s*$/.exec(opening)?.[1];
      if (label && openingEnd >= 0) {
        const closing = new RegExp(`^${label}(?=\\s*(?:[;,.\\)\\]}]|$))`, "m");
        const remainder = source.slice(openingEnd + 1);
        const match = closing.exec(remainder);
        const to = match
          ? openingEnd + 1 + match.index + match[0].length
          : source.length;
        tokens.push({ value: "<literal>", from: index, to, kind: "literal" });
        index = to;
        continue;
      }
    }
    if (character === '"' || character === "'" || character === "`") {
      const from = index;
      const quote = character;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        const current = source[index];
        index += 1;
        if (current === quote) break;
      }
      tokens.push({ value: "<literal>", from, to: index, kind: "literal" });
      continue;
    }
    const variable = /^\$[A-Za-z_]\w*/.exec(source.slice(index))?.[0];
    if (variable) {
      tokens.push({
        value: variable,
        from: index,
        to: index + variable.length,
        kind: "variable",
      });
      index += variable.length;
      continue;
    }
    const identifier = /^[A-Za-z_\x80-\xff][\w\x80-\xff]*/.exec(
      source.slice(index),
    )?.[0];
    if (identifier) {
      tokens.push({
        value: identifier,
        from: index,
        to: index + identifier.length,
        kind: "identifier",
      });
      index += identifier.length;
      continue;
    }
    const number =
      /^(?:0[xX][\dA-Fa-f_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?)/.exec(
        source.slice(index),
      )?.[0];
    if (number) {
      tokens.push({
        value: number,
        from: index,
        to: index + number.length,
        kind: "literal",
      });
      index += number.length;
      continue;
    }
    const symbol =
      [
        "?->",
        "??=",
        "<=>",
        "===",
        "!==",
        "<<=",
        ">>=",
        "**=",
        "...",
        "->",
        "::",
        "=>",
        "??",
        "?=",
        "==",
        "!=",
        "<=",
        ">=",
        "&&",
        "||",
        "++",
        "--",
        "+=",
        "-=",
        "*=",
        "/=",
        ".=",
        "%=",
        "**",
        "<<",
        ">>",
      ].find((candidate) => source.startsWith(candidate, index)) ?? character;
    tokens.push({
      value: symbol,
      from: index,
      to: index + symbol.length,
      kind: "symbol",
    });
    index += symbol.length;
  }
  return tokens;
}

/** Builds opening-token to closing-token indexes for PHP delimiters. */
function delimiterPairs(tokens: readonly PhpToken[]) {
  const pairs = new Map<number, number>();
  const stacks = new Map([
    ["(", [] as number[]],
    ["[", [] as number[]],
    ["{", [] as number[]],
  ]);
  const opening = new Map([
    [")", "("],
    ["]", "["],
    ["}", "{"],
  ]);
  tokens.forEach((token, tokenIndex) => {
    const stack = stacks.get(token.value);
    if (stack) {
      stack.push(tokenIndex);
      return;
    }
    const open = opening.get(token.value);
    if (!open) return;
    const start = stacks.get(open)?.pop();
    if (start !== undefined) {
      pairs.set(start, tokenIndex);
      pairs.set(tokenIndex, start);
    }
  });
  return pairs;
}

/** Skips documentation and one or more PHP 8 attribute groups. */
function declarationHead(
  tokens: readonly PhpToken[],
  pairs: ReadonlyMap<number, number>,
  start: number,
) {
  let index = start;
  while (index < tokens.length) {
    if (tokens[index]?.kind === "doc") {
      index += 1;
      continue;
    }
    if (tokens[index]?.value === "#" && tokens[index + 1]?.value === "[") {
      index = (pairs.get(index + 1) ?? index + 1) + 1;
      continue;
    }
    break;
  }
  return index;
}

/** Returns the source range beginning with attached docs and attributes. */
function declarationRange(
  tokens: readonly PhpToken[],
  start: number,
  end: number,
): SourceRange {
  return {
    from: tokens[start]?.from ?? 0,
    to: tokens[end]?.to ?? tokens[start]?.to ?? 0,
  };
}

/** Finds a direct token without walking into nested delimiter groups. */
function directToken(
  tokens: readonly PhpToken[],
  pairs: ReadonlyMap<number, number>,
  start: number,
  end: number,
  values: ReadonlySet<string>,
) {
  let index = start;
  while (index < end) {
    if (values.has(tokens[index]?.value ?? "")) return index;
    if (["(", "[", "{"].includes(tokens[index]?.value ?? "")) {
      index = (pairs.get(index) ?? index) + 1;
    } else {
      index += 1;
    }
  }
  return undefined;
}

/** Finds the semicolon ending a statement, skipping closures and literals. */
function statementEnd(
  tokens: readonly PhpToken[],
  pairs: ReadonlyMap<number, number>,
  start: number,
  limit = tokens.length,
) {
  const alternativeEnd = alternativeSyntaxEnd(tokens, pairs, start, limit);
  if (alternativeEnd !== undefined) return alternativeEnd;
  let index = start;
  while (index < limit) {
    if (tokens[index]?.value === ";") return index;
    if (["(", "[", "{"].includes(tokens[index]?.value ?? "")) {
      index = (pairs.get(index) ?? index) + 1;
    } else {
      index += 1;
    }
  }
  return Math.max(start, limit - 1);
}

/** Finds the end marker for PHP's colon-delimited control-flow syntax. */
function alternativeSyntaxEnd(
  tokens: readonly PhpToken[],
  pairs: ReadonlyMap<number, number>,
  start: number,
  limit: number,
) {
  const openingToClosing = new Map([
    ["if", "endif"],
    ["for", "endfor"],
    ["foreach", "endforeach"],
    ["while", "endwhile"],
    ["switch", "endswitch"],
    ["declare", "enddeclare"],
  ]);
  const opening = tokens[start]?.value.toLowerCase() ?? "";
  const closing = openingToClosing.get(opening);
  if (!closing) return undefined;
  const boundary = directToken(
    tokens,
    pairs,
    start + 1,
    limit,
    new Set([":", ";", "{"]),
  );
  if (boundary === undefined || tokens[boundary]?.value !== ":")
    return undefined;
  const stack = [closing];
  let index = boundary + 1;
  while (index < limit) {
    const value = tokens[index]?.value.toLowerCase() ?? "";
    const nestedClosing = openingToClosing.get(value);
    if (nestedClosing) {
      const nestedBoundary = directToken(
        tokens,
        pairs,
        index + 1,
        limit,
        new Set([":", ";", "{"]),
      );
      if (
        nestedBoundary !== undefined &&
        tokens[nestedBoundary]?.value === ":"
      ) {
        stack.push(nestedClosing);
      }
    } else if (value === stack.at(-1)) {
      stack.pop();
      if (!stack.length) {
        return tokens[index + 1]?.value === ";" ? index + 1 : index;
      }
    }
    if (["(", "[", "{"].includes(tokens[index]?.value ?? "")) {
      index = (pairs.get(index) ?? index) + 1;
    } else {
      index += 1;
    }
  }
  return undefined;
}

/** Extracts references while preserving PHP member and static-member identity. */
function referenceNames(
  tokens: readonly PhpToken[],
  start: number,
  end: number,
  ownNames: ReadonlySet<string>,
  owner?: string,
) {
  const references = new Set<string>();
  for (let index = start; index <= end; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (
      token.value === "$this" &&
      ["->", "?->"].includes(tokens[index + 1]?.value ?? "") &&
      tokens[index + 2]?.kind === "identifier" &&
      owner
    ) {
      const member = tokens[index + 2]?.value ?? "";
      references.add(
        tokens[index + 3]?.value === "("
          ? `${owner}.${member}`
          : `${owner}.$${member}`,
      );
      continue;
    }
    if (
      ["self", "static"].includes(token.value.toLowerCase()) &&
      tokens[index + 1]?.value === "::" &&
      ["identifier", "variable"].includes(tokens[index + 2]?.kind ?? "") &&
      owner
    ) {
      references.add(`${owner}.${tokens[index + 2]?.value}`);
      continue;
    }
    if (
      token.kind === "identifier" &&
      tokens[index + 1]?.value === "::" &&
      ["identifier", "variable"].includes(tokens[index + 2]?.kind ?? "")
    ) {
      references.add(`${token.value}.${tokens[index + 2]?.value}`);
      continue;
    }
    if (
      token.kind === "identifier" &&
      !phpKeywords.has(token.value.toLowerCase())
    ) {
      if (!ownNames.has(token.value)) references.add(token.value);
    }
    if (token.kind === "variable" && !ownNames.has(token.value)) {
      references.add(token.value);
    }
  }
  return [...references];
}

/** Creates a PHP unit with parser-private dependency metadata. */
function phpUnit(
  file: SourceFile,
  kind: UnitKind,
  name: string,
  range: SourceRange,
  phpName: string,
  rawDependencies: string[],
  owner?: string,
  complexity = 1,
): PhpUnit {
  return {
    ...makeUnit(
      file,
      "php",
      kind,
      name,
      range,
      rawDependencies.map((dependency) => `${file.path}:${dependency}`),
      complexity,
      phpName,
    ),
    phpName,
    owner,
    rawDependencies,
  };
}

/** Decodes a static PHP string for a test title without evaluating it. */
function literalLabel(source: string, token?: PhpToken) {
  if (token?.kind !== "literal") return undefined;
  const raw = source.slice(token.from, token.to);
  if (raw.length < 2 || !["'", '"'].includes(raw[0] ?? "")) return undefined;
  return raw
    .slice(1, -1)
    .replace(/\\([\\'"])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Returns a method's PHPUnit role from attributes, docs, path, and naming. */
function phpTestKind(
  file: SourceFile,
  tokens: readonly PhpToken[],
  start: number,
  functionIndex: number,
  name: string,
  testType: boolean,
  providerNames: ReadonlySet<string>,
) {
  const prefix = file.content
    .slice(tokens[start]?.from ?? 0, tokens[functionIndex]?.from ?? 0)
    .toLowerCase();
  const lower = name.toLowerCase();
  if (
    /#\[\s*(?:\\?[\w\\]+\\)?(?:test|testwith)\b/i.test(prefix) ||
    /@test\b/i.test(prefix) ||
    (testType && /^test/.test(lower))
  ) {
    return "test" as const;
  }
  if (
    lifecycleNames.has(lower) ||
    /#\[\s*(?:\\?[\w\\]+\\)?(?:before|after)\b/i.test(prefix) ||
    /@(?:before|after)\b/i.test(prefix) ||
    providerNames.has(lower) ||
    /^(?:provide|dataprovider)/.test(lower)
  ) {
    return "test_hook" as const;
  }
  return "method" as const;
}

interface ParsedType {
  units: PhpUnit[];
  next: number;
  name: string;
  shell: PhpUnit;
}

/** Splits constructor parameters at direct commas. */
function parameterSegments(
  tokens: readonly PhpToken[],
  pairs: ReadonlyMap<number, number>,
  open: number,
  close: number,
) {
  const segments: Array<[number, number]> = [];
  let start = open + 1;
  let index = start;
  while (index < close) {
    if (["(", "[", "{"].includes(tokens[index]?.value ?? "")) {
      index = (pairs.get(index) ?? index) + 1;
      continue;
    }
    if (tokens[index]?.value === ",") {
      if (index > start) segments.push([start, index - 1]);
      start = index + 1;
    }
    index += 1;
  }
  if (close > start) segments.push([start, close - 1]);
  return segments;
}

/** Parses one named PHP class, interface, trait, or enum. */
function parseType(
  file: SourceFile,
  tokens: readonly PhpToken[],
  pairs: ReadonlyMap<number, number>,
  start: number,
  limit = tokens.length,
  namespace = "",
): ParsedType | undefined {
  const head = declarationHead(tokens, pairs, start);
  let keyword = head;
  while (
    keyword < limit &&
    memberModifiers.has(tokens[keyword]?.value.toLowerCase() ?? "")
  ) {
    keyword += 1;
  }
  if (!typeKeywords.has(tokens[keyword]?.value.toLowerCase() ?? ""))
    return undefined;
  if (tokens[keyword - 1]?.value.toLowerCase() === "new") return undefined;
  const nameIndex = keyword + 1;
  if (tokens[nameIndex]?.kind !== "identifier") return undefined;
  const open = directToken(tokens, pairs, nameIndex + 1, limit, new Set(["{"]));
  if (open === undefined) return undefined;
  const close = pairs.get(open);
  if (close === undefined) return undefined;
  const simpleName = tokens[nameIndex]?.value ?? "anonymous";
  const phpName = namespace ? `${namespace}\\${simpleName}` : simpleName;
  const isTestType =
    /(?:^|[/\\])tests?(?:[/\\]|$)|(?:test|spec)\.php$/i.test(file.path) ||
    /(?:extends\s+[^\s{]*TestCase\b|#\[\s*Covers)/i.test(
      file.content.slice(tokens[start]?.from ?? 0, tokens[open]?.to ?? 0),
    );
  const providerNames = new Set(
    [
      ...file.content
        .slice(tokens[open]?.to ?? 0, tokens[close]?.from ?? 0)
        .matchAll(
          /(?:DataProvider|@dataProvider)\s*(?:\(|\s+)\s*['"]([^'"]+)['"]/gi,
        ),
    ].map((match) => (match[1] ?? "").toLowerCase()),
  );
  const members: PhpUnit[] = [];
  const typeReferences = referenceNames(
    tokens,
    keyword,
    open,
    new Set([simpleName]),
    phpName,
  );
  let index = open + 1;
  while (index < close) {
    if ([";", "<?php", "?>"].includes(tokens[index]?.value ?? "")) {
      index += 1;
      continue;
    }
    const memberStart = index;
    const memberHead = declarationHead(tokens, pairs, memberStart);
    let cursor = memberHead;
    while (memberModifiers.has(tokens[cursor]?.value.toLowerCase() ?? ""))
      cursor += 1;
    const value = tokens[cursor]?.value.toLowerCase();
    if (value === "use") {
      const end = statementEnd(tokens, pairs, cursor, close);
      typeReferences.push(
        ...referenceNames(tokens, cursor + 1, end, new Set(), phpName),
      );
      index = end + 1;
      continue;
    }
    if (value === "function") {
      let nameIndexCandidate = cursor + 1;
      if (tokens[nameIndexCandidate]?.value === "&") nameIndexCandidate += 1;
      const nameToken = tokens[nameIndexCandidate];
      if (nameToken?.kind !== "identifier") {
        index = statementEnd(tokens, pairs, memberStart, close) + 1;
        continue;
      }
      const parameterOpen = directToken(
        tokens,
        pairs,
        nameIndexCandidate + 1,
        close,
        new Set(["("]),
      );
      const parameterClose =
        parameterOpen === undefined ? undefined : pairs.get(parameterOpen);
      const bodyBoundary =
        parameterClose === undefined
          ? undefined
          : directToken(
              tokens,
              pairs,
              parameterClose + 1,
              close,
              new Set(["{", ";"]),
            );
      const bodyOpen =
        bodyBoundary !== undefined && tokens[bodyBoundary]?.value === "{"
          ? bodyBoundary
          : undefined;
      const declarationEnd =
        bodyOpen === undefined
          ? (bodyBoundary ??
            statementEnd(tokens, pairs, nameIndexCandidate, close))
          : (pairs.get(bodyOpen) ?? bodyOpen);
      const methodName = nameToken.value;
      const lowerName = methodName.toLowerCase();
      const qualified = `${phpName}.${methodName}`;
      const kind = phpTestKind(
        file,
        tokens,
        memberStart,
        cursor,
        methodName,
        isTestType,
        providerNames,
      );
      const displayName =
        kind === "test" || kind === "test_hook"
          ? `${simpleName} › ${methodName}`
          : lowerName === "__construct"
            ? `${simpleName} constructor`
            : lowerName === "__destruct"
              ? `${simpleName} destructor`
              : methodName;
      const own = new Set([methodName]);
      if (parameterOpen !== undefined && parameterClose !== undefined) {
        for (const [parameterStart, parameterEnd] of parameterSegments(
          tokens,
          pairs,
          parameterOpen,
          parameterClose,
        )) {
          const variable = tokens
            .slice(parameterStart, parameterEnd + 1)
            .reverse()
            .find((token) => token.kind === "variable");
          if (variable) own.add(variable.value);
          const promoted = tokens
            .slice(parameterStart, parameterEnd + 1)
            .some((token) => visibility.has(token.value.toLowerCase()));
          if (promoted && variable && lowerName === "__construct") {
            const propertyName = `${phpName}.${variable.value}`;
            members.push(
              phpUnit(
                file,
                "variable",
                `${simpleName}.${variable.value}`,
                {
                  from: tokens[parameterStart]?.from ?? variable.from,
                  to: tokens[parameterEnd]?.to ?? variable.to,
                },
                propertyName,
                referenceNames(
                  tokens,
                  parameterStart,
                  parameterEnd,
                  new Set([variable.value]),
                  phpName,
                ),
                phpName,
              ),
            );
          }
        }
      }
      const methodDependencies = referenceNames(
        tokens,
        cursor,
        declarationEnd,
        own,
        phpName,
      );
      if (kind === "test") {
        const prefix = file.content.slice(
          tokens[memberStart]?.from ?? 0,
          tokens[cursor]?.from ?? 0,
        );
        for (const match of prefix.matchAll(
          /(?:DataProvider|@dataProvider)\s*(?:\(|\s+)\s*['"]([^'"]+)['"]/gi,
        )) {
          if (match[1]) methodDependencies.push(`${phpName}.${match[1]}`);
        }
      }
      members.push(
        phpUnit(
          file,
          kind,
          displayName,
          declarationRange(tokens, memberStart, declarationEnd),
          qualified,
          methodDependencies,
          phpName,
          1 +
            (file.content
              .slice(tokens[cursor]?.from ?? 0, tokens[declarationEnd]?.to ?? 0)
              .match(/\b(?:if|for|foreach|while|case|catch|match)\b/g)
              ?.length ?? 0),
        ),
      );
      index = declarationEnd + 1;
      continue;
    }
    if (value === "case" && tokens[cursor + 1]?.kind === "identifier") {
      const end = statementEnd(tokens, pairs, cursor, close);
      const caseName = tokens[cursor + 1]?.value ?? "case";
      members.push(
        phpUnit(
          file,
          "constant",
          `${simpleName}.${caseName}`,
          declarationRange(tokens, memberStart, end),
          `${phpName}.${caseName}`,
          referenceNames(tokens, cursor, end, new Set([caseName]), phpName),
          phpName,
        ),
      );
      index = end + 1;
      continue;
    }
    const end = statementEnd(tokens, pairs, memberStart, close);
    const segment = tokens.slice(cursor, end + 1);
    const variables = segment.filter((token) => token.kind === "variable");
    const isConstant = value === "const";
    const constantNames = isConstant
      ? segment.filter(
          (token, tokenIndex) =>
            token.kind === "identifier" &&
            segment[tokenIndex + 1]?.value === "=",
        )
      : [];
    const declarations = isConstant ? constantNames : variables;
    if (declarations.length) {
      for (const declaration of declarations) {
        const propertyName = `${phpName}.${declaration.value}`;
        members.push(
          phpUnit(
            file,
            isConstant ? "constant" : "variable",
            `${simpleName}.${declaration.value}`,
            declarationRange(tokens, memberStart, end),
            propertyName,
            referenceNames(
              tokens,
              cursor,
              end,
              new Set(declarations.map(({ value: declared }) => declared)),
              phpName,
            ),
            phpName,
          ),
        );
      }
    }
    index = end + 1;
  }
  const shellKind: UnitKind = isTestType ? "test_suite" : "class";
  const directMembers = members.filter(({ owner }) => owner === phpName);
  const shell = phpUnit(
    file,
    shellKind,
    simpleName,
    declarationRange(tokens, start, open),
    phpName,
    [
      ...typeReferences,
      ...directMembers.map(({ phpName: memberName }) => memberName),
    ],
    namespace || undefined,
  );
  return { units: [...members, shell], next: close + 1, name: phpName, shell };
}

/** Parses a global named function or closure assigned to a stable variable. */
function parseGlobalFunction(
  file: SourceFile,
  tokens: readonly PhpToken[],
  pairs: ReadonlyMap<number, number>,
  start: number,
  limit: number,
  namespace: string,
) {
  const head = declarationHead(tokens, pairs, start);
  let functionIndex = head;
  let assignedName: string | undefined;
  if (tokens[head]?.kind === "variable" && tokens[head + 1]?.value === "=") {
    assignedName = tokens[head]?.value.slice(1);
    functionIndex = head + 2;
    if (tokens[functionIndex]?.value.toLowerCase() === "static") {
      functionIndex += 1;
    }
    if (
      !["function", "fn"].includes(
        tokens[functionIndex]?.value.toLowerCase() ?? "",
      )
    ) {
      return undefined;
    }
  }
  if (tokens[functionIndex]?.value.toLowerCase() !== "function") {
    if (tokens[functionIndex]?.value.toLowerCase() !== "fn" || !assignedName)
      return undefined;
  }
  let nameIndex = functionIndex + 1;
  if (tokens[nameIndex]?.value === "&") nameIndex += 1;
  const declaredName =
    assignedName ??
    (tokens[nameIndex]?.kind === "identifier"
      ? tokens[nameIndex]?.value
      : undefined);
  if (!declaredName) return undefined;
  const parameterOpen = directToken(
    tokens,
    pairs,
    nameIndex + 1,
    limit,
    new Set(["("]),
  );
  const parameterClose =
    parameterOpen === undefined ? undefined : pairs.get(parameterOpen);
  const bodyBoundary =
    parameterClose === undefined
      ? undefined
      : directToken(
          tokens,
          pairs,
          parameterClose + 1,
          limit,
          new Set(["{", ";", "=>"]),
        );
  let end = statementEnd(tokens, pairs, start, limit);
  if (bodyBoundary !== undefined && tokens[bodyBoundary]?.value === "{") {
    end = pairs.get(bodyBoundary) ?? bodyBoundary;
  }
  const phpName = namespace ? `${namespace}\\${declaredName}` : declaredName;
  return {
    unit: phpUnit(
      file,
      "function",
      declaredName,
      declarationRange(tokens, start, end),
      phpName,
      referenceNames(
        tokens,
        functionIndex,
        end,
        new Set([declaredName, `$${declaredName}`]),
      ),
      namespace || undefined,
    ),
    next: end + 1,
  };
}

/** Parses one Pest test, suite, lifecycle hook, or dataset declaration. */
function parsePest(
  file: SourceFile,
  tokens: readonly PhpToken[],
  pairs: ReadonlyMap<number, number>,
  start: number,
  limit: number,
  namespace: string,
  suite = "",
): { units: PhpUnit[]; next: number } | undefined {
  const head = declarationHead(tokens, pairs, start);
  const callee = tokens[head]?.value.toLowerCase() ?? "";
  if (![...pestTests, ...pestSuites, ...pestHooks].includes(callee))
    return undefined;
  if (tokens[head + 1]?.value !== "(") return undefined;
  const close = pairs.get(head + 1);
  if (close === undefined || close >= limit) return undefined;
  const end = statementEnd(tokens, pairs, head, limit);
  const labelToken = tokens
    .slice(head + 2, close)
    .find((token) => token.kind === "literal");
  const label = literalLabel(file.content, labelToken) ?? callee;
  const path = suite ? `${suite} › ${label}` : label;
  const stable = namespace ? `${namespace}\\pest:${path}` : `pest:${path}`;
  const closureKeyword = tokens
    .slice(head + 2, close)
    .findIndex((token) =>
      ["function", "fn"].includes(token.value.toLowerCase()),
    );
  const absoluteClosure =
    closureKeyword < 0 ? undefined : head + 2 + closureKeyword;
  const bodyOpen =
    absoluteClosure === undefined
      ? undefined
      : directToken(tokens, pairs, absoluteClosure, close, new Set(["{"]));
  const nested: PhpUnit[] = [];
  if (pestSuites.has(callee) && bodyOpen !== undefined) {
    const bodyClose = pairs.get(bodyOpen);
    if (bodyClose !== undefined) {
      let index = bodyOpen + 1;
      while (index < bodyClose) {
        const child = parsePest(
          file,
          tokens,
          pairs,
          index,
          bodyClose,
          namespace,
          path,
        );
        if (child) {
          nested.push(...child.units);
          index = child.next;
        } else {
          index += 1;
        }
      }
    }
  }
  const kind: UnitKind = pestSuites.has(callee)
    ? "test_suite"
    : pestHooks.has(callee)
      ? "test_hook"
      : "test";
  const rangeEnd =
    pestSuites.has(callee) && bodyOpen !== undefined ? bodyOpen : end;
  const unit = phpUnit(
    file,
    kind,
    path,
    declarationRange(tokens, start, rangeEnd),
    stable,
    [
      ...referenceNames(tokens, head, end, new Set([callee])),
      ...nested.map(({ phpName }) => phpName),
    ],
    suite || namespace || undefined,
  );
  return { units: [...nested, unit], next: end + 1 };
}

/** Returns a namespace name from the declaration immediately at `start`. */
function namespaceName(
  tokens: readonly PhpToken[],
  start: number,
  end: number,
) {
  return tokens
    .slice(start + 1, end)
    .filter(({ kind, value }) => kind === "identifier" || value === "\\")
    .map(({ value }) => value)
    .join("");
}

/** Parses declarations and meaningful executable setup in one namespace range. */
function parseScope(
  file: SourceFile,
  tokens: readonly PhpToken[],
  pairs: ReadonlyMap<number, number>,
  start: number,
  limit: number,
  namespace = "",
) {
  const units: PhpUnit[] = [];
  let index = start;
  while (index < limit) {
    const value = tokens[index]?.value.toLowerCase() ?? "";
    if (["<?php", "<?", "<?=", "?>", ";"].includes(value)) {
      index += 1;
      continue;
    }
    if (tokens[index]?.kind === "doc") {
      // The doc token belongs to the declaration that follows it.
    }
    const head = declarationHead(tokens, pairs, index);
    const headValue = tokens[head]?.value.toLowerCase() ?? "";
    if (headValue === "namespace") {
      const boundary = directToken(
        tokens,
        pairs,
        head + 1,
        limit,
        new Set([";", "{"]),
      );
      if (boundary === undefined) break;
      const childNamespace = namespaceName(tokens, head, boundary);
      if (tokens[boundary]?.value === "{") {
        const close = pairs.get(boundary);
        if (close === undefined) break;
        units.push(
          ...parseScope(
            file,
            tokens,
            pairs,
            boundary + 1,
            close,
            childNamespace,
          ),
        );
        index = close + 1;
      } else {
        namespace = childNamespace;
        index = boundary + 1;
      }
      continue;
    }
    if (["declare", "use"].includes(headValue)) {
      index = statementEnd(tokens, pairs, head, limit) + 1;
      continue;
    }
    const parsedType = parseType(file, tokens, pairs, index, limit, namespace);
    if (parsedType) {
      units.push(...parsedType.units);
      index = parsedType.next;
      continue;
    }
    const pest = parsePest(file, tokens, pairs, index, limit, namespace);
    if (pest) {
      units.push(...pest.units);
      index = pest.next;
      continue;
    }
    const globalFunction = parseGlobalFunction(
      file,
      tokens,
      pairs,
      index,
      limit,
      namespace,
    );
    if (globalFunction) {
      units.push(globalFunction.unit);
      index = globalFunction.next;
      continue;
    }
    if (headValue === "const") {
      const end = statementEnd(tokens, pairs, head, limit);
      const names = tokens
        .slice(head + 1, end)
        .filter(
          (token, tokenIndex, segment) =>
            token.kind === "identifier" &&
            segment[tokenIndex + 1]?.value === "=",
        );
      for (const name of names) {
        const phpName = namespace ? `${namespace}\\${name.value}` : name.value;
        units.push(
          phpUnit(
            file,
            "constant",
            name.value,
            declarationRange(tokens, index, end),
            phpName,
            referenceNames(
              tokens,
              head,
              end,
              new Set(names.map(({ value: own }) => own)),
            ),
            namespace || undefined,
          ),
        );
      }
      index = end + 1;
      continue;
    }
    // Required files are navigation context; other direct statements represent
    // meaningful bootstrapping and remain reviewable as compact setup units.
    const end = statementEnd(tokens, pairs, head, limit);
    if (
      ["require", "require_once", "include", "include_once"].includes(headValue)
    ) {
      index = end + 1;
      continue;
    }
    const setupName = namespace
      ? `${namespace} namespace setup`
      : "Module setup";
    const setupStable = namespace
      ? `${namespace}:setup:${tokens[index]?.from}`
      : `setup:${tokens[index]?.from}`;
    units.push(
      phpUnit(
        file,
        "module",
        setupName,
        declarationRange(tokens, index, end),
        setupStable,
        referenceNames(tokens, head, end, new Set()),
        namespace || undefined,
      ),
    );
    index = end + 1;
  }
  return units;
}

/** Resolves parser-local symbolic references and connects type shells to members. */
function resolveDependencies(units: PhpUnit[]) {
  const exact = new Map(
    units.map((unit) => [unit.phpName.toLowerCase(), unit]),
  );
  const simple = new Map<string, PhpUnit[]>();
  for (const unit of units) {
    const key = unit.phpName.split(/[\\.]/).at(-1)?.toLowerCase() ?? "";
    simple.set(key, [...(simple.get(key) ?? []), unit]);
  }
  return units.map(
    ({ phpName: _phpName, owner: _owner, rawDependencies, ...unit }) => {
      const dependencies = new Set<string>();
      for (const raw of rawDependencies) {
        const normalized = raw.replace(/^\\/, "").toLowerCase();
        const direct = exact.get(normalized);
        if (direct && direct.stableKey !== unit.stableKey) {
          dependencies.add(direct.stableKey);
          continue;
        }
        const ownerCandidate = _owner
          ? exact.get(`${_owner}.${raw}`.toLowerCase())
          : undefined;
        if (ownerCandidate && ownerCandidate.stableKey !== unit.stableKey) {
          dependencies.add(ownerCandidate.stableKey);
          continue;
        }
        const candidates = simple.get(normalized.replace(/^\$/, ""));
        if (
          candidates?.length === 1 &&
          candidates[0]?.stableKey !== unit.stableKey
        ) {
          dependencies.add(candidates[0]?.stableKey ?? "");
        }
      }
      return { ...unit, dependencies: [...dependencies] };
    },
  );
}

/** Checks whether PHP source contains only inert file/namespace/import context. */
function isPhpContextOnly(source: string) {
  const tokens = tokenizePhp(source);
  const pairs = delimiterPairs(tokens);
  const contextFile: SourceFile = { path: "context.php", content: source };
  return parseScope(contextFile, tokens, pairs, 0, tokens.length).length === 0;
}

export const phpAdapter: LanguageAdapter = {
  language: "php",
  extensions: supportedExtensions.php,
  isContextOnly: isPhpContextOnly,
  analyze(file) {
    const tokens = tokenizePhp(file.content);
    const pairs = delimiterPairs(tokens);
    return resolveDependencies(
      parseScope(file, tokens, pairs, 0, tokens.length),
    );
  },
};
