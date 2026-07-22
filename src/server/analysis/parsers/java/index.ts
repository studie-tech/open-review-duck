import type {
  AnalyzedUnit,
  LanguageAdapter,
  SourceFile,
  UnitKind,
} from "../../types";
import { supportedExtensions } from "../../types";
import { makeUnit, type SourceRange } from "../shared";

interface JavaToken {
  value: string;
  from: number;
  to: number;
  kind: "identifier" | "literal" | "symbol";
}

interface JavaUnit extends Omit<AnalyzedUnit, "depth" | "reviewOrder"> {
  /** Fully-qualified declaration name used to connect type shells to members. */
  javaName: string;
  /** Fully-qualified name of the directly enclosing Java type. */
  owner?: string;
}

interface ParsedType {
  units: JavaUnit[];
  next: number;
  name: string;
  unit: JavaUnit;
}

const typeKeywords = new Set(["class", "interface", "enum", "record"]);
const modifiers = new Set([
  "abstract",
  "default",
  "final",
  "native",
  "non-sealed",
  "private",
  "protected",
  "public",
  "sealed",
  "static",
  "strictfp",
  "synchronized",
  "transient",
  "volatile",
]);
const javaKeywords = new Set([
  ...modifiers,
  "assert",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "continue",
  "do",
  "double",
  "else",
  "enum",
  "exports",
  "extends",
  "false",
  "finally",
  "float",
  "for",
  "goto",
  "if",
  "implements",
  "import",
  "instanceof",
  "int",
  "interface",
  "long",
  "module",
  "new",
  "null",
  "open",
  "opens",
  "package",
  "permits",
  "provides",
  "record",
  "requires",
  "return",
  "short",
  "super",
  "switch",
  "this",
  "throw",
  "throws",
  "to",
  "transitive",
  "true",
  "try",
  "uses",
  "var",
  "void",
  "when",
  "while",
  "with",
  "yield",
]);
const testAnnotations = new Set([
  "Test",
  "ParameterizedTest",
  "RepeatedTest",
  "TestFactory",
  "TestTemplate",
  "Theory",
]);
const hookAnnotations = new Set([
  "After",
  "AfterAll",
  "AfterClass",
  "AfterEach",
  "AfterGroups",
  "AfterMethod",
  "AfterSuite",
  "AfterTest",
  "Before",
  "BeforeAll",
  "BeforeClass",
  "BeforeEach",
  "BeforeGroups",
  "BeforeMethod",
  "BeforeSuite",
  "BeforeTest",
]);

/** Tokenizes Java while treating comments and literal bodies as opaque text. */
function tokenizeJava(source: string) {
  const tokens: JavaToken[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? "";
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 ? source.length : close + 2;
      continue;
    }
    if (source.startsWith('"""', index)) {
      const from = index;
      const close = source.indexOf('"""', index + 3);
      index = close < 0 ? source.length : close + 3;
      tokens.push({ value: "<literal>", from, to: index, kind: "literal" });
      continue;
    }
    if (character === '"' || character === "'") {
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
    const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(index))?.[0];
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
      /^(?:0[xX][\dA-Fa-f_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?)(?:[eE][+-]?[\d_]+)?[fFdDlL]?/.exec(
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
        ">>>=",
        "<<=",
        ">>=",
        "...",
        "::",
        "->",
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
        "%=",
        "&=",
        "|=",
        "^=",
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

/** Builds opening-token to closing-token indexes for structural delimiters. */
function delimiterPairs(tokens: readonly JavaToken[]) {
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
  tokens.forEach((token, index) => {
    const stack = stacks.get(token.value);
    if (stack) {
      stack.push(index);
      return;
    }
    const open = opening.get(token.value);
    if (!open) return;
    const start = stacks.get(open)?.pop();
    if (start !== undefined) {
      pairs.set(start, index);
      pairs.set(index, start);
    }
  });
  return pairs;
}

/** Consumes a Java annotation, including qualified names and argument lists. */
function skipAnnotation(
  tokens: readonly JavaToken[],
  pairs: ReadonlyMap<number, number>,
  index: number,
) {
  if (
    tokens[index]?.value !== "@" ||
    tokens[index + 1]?.value === "interface"
  ) {
    return index;
  }
  index += 1;
  if (tokens[index]?.kind === "identifier") {
    index += 1;
    while (
      tokens[index]?.value === "." &&
      tokens[index + 1]?.kind === "identifier"
    ) {
      index += 2;
    }
  }
  if (tokens[index]?.value === "(") index = (pairs.get(index) ?? index) + 1;
  return index;
}

/** Skips declaration annotations, modifiers, and leading generic parameters. */
function declarationHead(
  tokens: readonly JavaToken[],
  pairs: ReadonlyMap<number, number>,
  start: number,
) {
  let index = start;
  while (index < tokens.length) {
    if (
      tokens[index]?.value === "@" &&
      tokens[index + 1]?.value !== "interface"
    ) {
      index = skipAnnotation(tokens, pairs, index);
      continue;
    }
    const value = tokens[index]?.value ?? "";
    if (modifiers.has(value)) {
      index += 1;
      continue;
    }
    if (
      value === "non" &&
      tokens[index + 1]?.value === "-" &&
      tokens[index + 2]?.value === "sealed"
    ) {
      index += 3;
      continue;
    }
    break;
  }
  return index;
}

/** Identifies a Java type declaration at a prefix-free token position. */
function typeKeywordAt(tokens: readonly JavaToken[], index: number) {
  if (
    tokens[index]?.value === "@" &&
    tokens[index + 1]?.value === "interface"
  ) {
    return { keyword: "annotation", nameIndex: index + 2 } as const;
  }
  const keyword = tokens[index]?.value ?? "";
  if (!typeKeywords.has(keyword)) return undefined;
  return { keyword, nameIndex: index + 1 };
}

/** Counts visible branch points for review-effort ordering. */
function complexity(source: string) {
  const scrubbed = tokenizeJava(source)
    .map(({ value }) => value)
    .join(" ");
  return (
    1 +
    (scrubbed.match(/\b(?:if|for|while|case|catch|when)\b|&&|\|\||\?/g)
      ?.length ?? 0)
  );
}

/** Extracts identifier references without treating annotations or declarations as dependencies. */
function referenceNames(
  tokens: readonly JavaToken[],
  fromIndex: number,
  toIndex: number,
  ownNames: ReadonlySet<string>,
) {
  const found = new Set<string>();
  for (let index = fromIndex; index < toIndex; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "identifier") continue;
    if (javaKeywords.has(token.value) || ownNames.has(token.value)) continue;
    if (tokens[index - 1]?.value === "@") continue;
    if (tokens[index - 1]?.value === ".") continue;
    found.add(token.value);
  }
  return [...found];
}

/** Creates one Java review unit while retaining parser-only hierarchy metadata. */
function javaUnit(
  file: SourceFile,
  kind: UnitKind,
  name: string,
  range: SourceRange,
  dependencies: string[],
  stableName: string,
  owner?: string,
): JavaUnit {
  return {
    ...makeUnit(
      file,
      "java",
      kind,
      name,
      range,
      dependencies,
      complexity(file.content.slice(range.from, range.to)),
      stableName,
    ),
    javaName: stableName,
    owner,
  };
}

/** Returns the simple names of annotations in a declaration prefix. */
function annotationNames(
  tokens: readonly JavaToken[],
  fromIndex: number,
  toIndex: number,
) {
  const names = new Set<string>();
  for (let index = fromIndex; index < toIndex; index += 1) {
    if (tokens[index]?.value !== "@") continue;
    const pieces: string[] = [];
    index += 1;
    if (tokens[index]?.kind === "identifier") {
      pieces.push(tokens[index]?.value ?? "");
      index += 1;
      while (
        index < toIndex &&
        tokens[index]?.value === "." &&
        tokens[index + 1]?.kind === "identifier"
      ) {
        pieces.push(tokens[index + 1]?.value ?? "");
        index += 2;
      }
    }
    const name = pieces.at(-1);
    if (name) names.add(name);
  }
  return names;
}

/** Classifies Java test and lifecycle methods using framework annotations. */
function testKind(
  annotations: ReadonlySet<string>,
  owner: string,
  file: SourceFile,
  methodName: string,
): Extract<UnitKind, "test" | "test_hook"> | undefined {
  if ([...annotations].some((name) => testAnnotations.has(name))) return "test";
  if ([...annotations].some((name) => hookAnnotations.has(name))) {
    return "test_hook";
  }
  const testContext =
    /(?:^|\/)(?:test|tests)(?:\/|$)/i.test(file.path) ||
    /(?:Test|Tests|TestCase|Spec)$/.test(owner.split(".").at(-1) ?? "");
  if (testContext && /^(?:test|should)[A-Z_]/.test(methodName)) return "test";
  return undefined;
}

/** Locates the callable name immediately preceding its parameter list. */
function callableName(
  tokens: readonly JavaToken[],
  pairs: ReadonlyMap<number, number>,
  start: number,
  end: number,
) {
  for (let index = start; index < end; index += 1) {
    if (tokens[index]?.value === "=") return undefined;
    if (tokens[index]?.value !== "(") continue;
    const close = pairs.get(index);
    if (close === undefined || close > end) continue;
    const previous = tokens[index - 1];
    if (previous?.kind === "identifier" && tokens[index - 2]?.value !== "@") {
      return { name: previous.value, index: index - 1, parameters: index };
    }
    index = close;
  }
  return undefined;
}

/** Finds the direct semicolon or executable block ending a class member. */
function declarationEnd(
  tokens: readonly JavaToken[],
  pairs: ReadonlyMap<number, number>,
  start: number,
  limit: number,
) {
  let parens = 0;
  let brackets = 0;
  let sawAssignment = false;
  for (let index = start; index < limit; index += 1) {
    const value = tokens[index]?.value;
    if (value === "(") parens += 1;
    else if (value === ")") parens -= 1;
    else if (value === "[") brackets += 1;
    else if (value === "]") brackets -= 1;
    else if (value === "=" && parens === 0 && brackets === 0)
      sawAssignment = true;
    else if (value === ";" && parens === 0 && brackets === 0) {
      return { delimiter: "semicolon" as const, index };
    } else if (value === "{" && parens === 0 && brackets === 0) {
      if (sawAssignment) {
        index = pairs.get(index) ?? index;
        continue;
      }
      return { delimiter: "block" as const, index };
    }
  }
  return undefined;
}

/** Extracts directly declared field names from a declaration statement. */
function fieldNames(
  tokens: readonly JavaToken[],
  pairs: ReadonlyMap<number, number>,
  start: number,
  end: number,
) {
  let index = declarationHead(tokens, pairs, start);
  const candidates: string[] = [];
  let parens = 0;
  let brackets = 0;
  let angles = 0;
  for (; index < end; index += 1) {
    const token = tokens[index];
    const value = token?.value;
    if (value === "(") parens += 1;
    else if (value === ")") parens -= 1;
    else if (value === "[") brackets += 1;
    else if (value === "]") brackets -= 1;
    else if (value === "<") angles += 1;
    else if (/^>{1,3}$/.test(value ?? "") && angles > 0) {
      angles = Math.max(0, angles - (value?.length ?? 0));
    }
    if (
      parens ||
      brackets ||
      angles ||
      token?.kind !== "identifier" ||
      javaKeywords.has(token.value)
    ) {
      continue;
    }
    const next = tokens[index + 1]?.value;
    if (["=", ",", "[", ";"].includes(next ?? "")) candidates.push(token.value);
  }
  return [...new Set(candidates)];
}

/** Extracts enum entries as independent constant units. */
function parseEnumConstants(
  file: SourceFile,
  tokens: readonly JavaToken[],
  pairs: ReadonlyMap<number, number>,
  start: number,
  limit: number,
  owner: string,
) {
  const units: JavaUnit[] = [];
  let index = start;
  while (index < limit) {
    if (tokens[index]?.value === ";") return { units, next: index + 1 };
    const entryStart = index;
    index = declarationHead(tokens, pairs, index);
    const nameToken = tokens[index];
    if (nameToken?.kind !== "identifier" || modifiers.has(nameToken.value)) {
      return { units, next: entryStart };
    }
    const name = nameToken.value;
    index += 1;
    if (tokens[index]?.value === "(") index = (pairs.get(index) ?? index) + 1;
    if (tokens[index]?.value === "{") index = (pairs.get(index) ?? index) + 1;
    const boundary = tokens[index]?.value;
    if (boundary !== "," && boundary !== ";" && index !== limit) {
      return { units: [], next: start };
    }
    const to = tokens[index - 1]?.to ?? nameToken.to;
    units.push(
      javaUnit(
        file,
        "constant",
        `${owner}.${name}`,
        { from: tokens[entryStart]?.from ?? nameToken.from, to },
        referenceNames(tokens, entryStart, index, new Set([name])).map(
          (dependency) => `${file.path}:${dependency}`,
        ),
        `${owner}.${name}`,
        owner,
      ),
    );
    if (boundary === ";") return { units, next: index + 1 };
    if (boundary !== ",") return { units, next: index };
    index += 1;
  }
  return { units, next: index };
}

/** Extracts direct members of a Java type and recursively parses nested types. */
function parseMembers(
  file: SourceFile,
  tokens: readonly JavaToken[],
  pairs: ReadonlyMap<number, number>,
  start: number,
  limit: number,
  owner: string,
  simpleOwner: string,
  typeKind: string,
) {
  const units: JavaUnit[] = [];
  let index = start;
  if (typeKind === "enum") {
    const constants = parseEnumConstants(
      file,
      tokens,
      pairs,
      index,
      limit,
      owner,
    );
    units.push(...constants.units);
    index = constants.next;
  }
  let initializer = 0;
  while (index < limit) {
    while (tokens[index]?.value === ";") index += 1;
    if (index >= limit) break;
    const declarationStart = index;
    const head = declarationHead(tokens, pairs, index);
    const nestedKind = typeKeywordAt(tokens, head);
    if (nestedKind) {
      const nested = parseType(file, tokens, pairs, declarationStart, owner);
      if (nested) {
        units.push(...nested.units);
        index = nested.next;
        continue;
      }
    }
    const staticInitializer =
      tokens[index]?.value === "static" && tokens[index + 1]?.value === "{";
    const instanceInitializer = tokens[index]?.value === "{";
    if (staticInitializer || instanceInitializer) {
      const open = staticInitializer ? index + 1 : index;
      const close = pairs.get(open);
      if (close === undefined || close >= limit) break;
      const label = staticInitializer
        ? "Static initializer"
        : "Instance initializer";
      const stableName = `${owner}.<initializer:${staticInitializer ? "static" : "instance"}:${initializer}>`;
      units.push(
        javaUnit(
          file,
          "module",
          `${owner} ${label.toLowerCase()}`,
          {
            from: tokens[declarationStart]?.from ?? 0,
            to: tokens[close]?.to ?? 0,
          },
          referenceNames(tokens, declarationStart, close + 1, new Set()).map(
            (dependency) => `${file.path}:${dependency}`,
          ),
          stableName,
          owner,
        ),
      );
      initializer += 1;
      index = close + 1;
      continue;
    }
    const end = declarationEnd(tokens, pairs, declarationStart, limit);
    if (!end) break;
    const callable = callableName(tokens, pairs, head, end.index);
    if (callable) {
      const close =
        end.delimiter === "block" ? pairs.get(end.index) : end.index;
      if (close === undefined) break;
      const isConstructor = callable.name === simpleOwner;
      const annotations = annotationNames(
        tokens,
        declarationStart,
        callable.index,
      );
      const classified = testKind(annotations, owner, file, callable.name);
      const kind: UnitKind = classified ?? "method";
      const displayName = classified
        ? `${owner} › ${callable.name}`
        : isConstructor
          ? `${owner} constructor`
          : callable.name;
      const parameterClose = pairs.get(callable.parameters);
      const parameterSignature =
        parameterClose === undefined
          ? ""
          : tokens
              .slice(callable.parameters + 1, parameterClose)
              .map(({ value }) => value)
              .join("");
      const stableName = isConstructor
        ? `${owner}.<init>(${parameterSignature})`
        : `${owner}.${callable.name}(${parameterSignature})`;
      const own = new Set([callable.name]);
      const dependencies = referenceNames(
        tokens,
        declarationStart,
        close + 1,
        own,
      ).map((dependency) => `${file.path}:${dependency}`);
      units.push(
        javaUnit(
          file,
          kind,
          displayName,
          {
            from: tokens[declarationStart]?.from ?? 0,
            to: tokens[close]?.to ?? 0,
          },
          dependencies,
          stableName,
          owner,
        ),
      );
      index = close + 1;
      continue;
    }
    if (end.delimiter === "block" && tokens[head]?.value === simpleOwner) {
      const close = pairs.get(end.index);
      if (close === undefined) break;
      units.push(
        javaUnit(
          file,
          "method",
          `${owner} constructor`,
          {
            from: tokens[declarationStart]?.from ?? 0,
            to: tokens[close]?.to ?? 0,
          },
          referenceNames(
            tokens,
            declarationStart,
            close + 1,
            new Set([simpleOwner]),
          ).map((dependency) => `${file.path}:${dependency}`),
          `${owner}.<init>(compact)`,
          owner,
        ),
      );
      index = close + 1;
      continue;
    }
    if (end.delimiter === "block") {
      const close = pairs.get(end.index);
      if (close === undefined) break;
      index = close + 1;
      continue;
    }
    const names = fieldNames(tokens, pairs, declarationStart, end.index + 1);
    const first = names[0];
    if (first) {
      const declarationTokens = tokens.slice(declarationStart, end.index);
      const isConstant =
        ["interface", "annotation"].includes(typeKind) ||
        (declarationTokens.some(({ value }) => value === "final") &&
          declarationTokens.some(({ value }) => value === "static"));
      const qualified = names.map((name) => `${owner}.${name}`);
      const displayName = qualified.join(", ");
      units.push(
        javaUnit(
          file,
          isConstant ? "constant" : "variable",
          displayName,
          {
            from: tokens[declarationStart]?.from ?? 0,
            to: tokens[end.index]?.to ?? 0,
          },
          referenceNames(
            tokens,
            declarationStart,
            end.index + 1,
            new Set(names),
          ).map((dependency) => `${file.path}:${dependency}`),
          qualified.join(","),
          owner,
        ),
      );
    }
    index = end.index + 1;
  }
  return units;
}

/** Parses a Java type shell and its complete reviewable member hierarchy. */
function parseType(
  file: SourceFile,
  tokens: readonly JavaToken[],
  pairs: ReadonlyMap<number, number>,
  start: number,
  parent?: string,
): ParsedType | undefined {
  const head = declarationHead(tokens, pairs, start);
  const type = typeKeywordAt(tokens, head);
  if (!type) return undefined;
  const nameToken = tokens[type.nameIndex];
  if (nameToken?.kind !== "identifier") return undefined;
  let open = type.nameIndex + 1;
  let parens = 0;
  let brackets = 0;
  while (open < tokens.length) {
    const value = tokens[open]?.value;
    if (value === "(") parens += 1;
    else if (value === ")") parens -= 1;
    else if (value === "[") brackets += 1;
    else if (value === "]") brackets -= 1;
    else if (value === "{" && parens === 0 && brackets === 0) break;
    open += 1;
  }
  const close = pairs.get(open);
  if (tokens[open]?.value !== "{" || close === undefined) return undefined;
  const name = parent ? `${parent}.${nameToken.value}` : nameToken.value;
  const annotations = annotationNames(tokens, start, head);
  const isTestSuite =
    [...annotations].some((annotation) =>
      ["RunWith", "ExtendWith", "Listeners", "TestInstance", "Nested"].includes(
        annotation,
      ),
    ) ||
    [...annotations].some((annotation) => testAnnotations.has(annotation)) ||
    /(?:Test|Tests|TestCase|Spec)$/.test(nameToken.value);
  const members = parseMembers(
    file,
    tokens,
    pairs,
    open + 1,
    close,
    name,
    nameToken.value,
    type.keyword,
  );
  const directFields = members.filter(
    (unit) =>
      unit.owner === name &&
      (unit.kind === "constant" || unit.kind === "variable"),
  );
  for (const member of members) {
    if (
      member.owner !== name ||
      !["method", "test", "test_hook"].includes(member.kind)
    ) {
      continue;
    }
    for (const field of directFields) {
      const fieldNames = field.name
        .split(",")
        .map((fieldName) => fieldName.trim().split(".").at(-1) ?? "")
        .filter(Boolean);
      if (
        fieldNames.some((fieldName) =>
          new RegExp(
            `(?:\\b(?:this|${nameToken.value})\\s*\\.\\s*)?\\b${fieldName}\\b`,
          ).test(member.source),
        )
      ) {
        member.dependencies = [
          ...new Set([...member.dependencies, field.stableKey]),
        ];
      }
    }
  }
  const shellKind: UnitKind = isTestSuite ? "test_suite" : "class";
  const headerRange = {
    from: tokens[start]?.from ?? nameToken.from,
    to: tokens[open]?.to ?? nameToken.to,
  };
  const headerDependencies = referenceNames(
    tokens,
    start,
    open,
    new Set([nameToken.value]),
  ).map((dependency) => `${file.path}:${dependency}`);
  const directMembers = members.filter(({ owner }) => owner === name);
  const shell = javaUnit(
    file,
    shellKind,
    nameToken.value,
    headerRange,
    [
      ...new Set([
        ...headerDependencies,
        ...directMembers.map(({ stableKey }) => stableKey),
      ]),
    ],
    name,
    parent,
  );
  return { units: [...members, shell], next: close + 1, name, unit: shell };
}

/** Checks whether Java source contains only package/import context and comments. */
function isJavaContextOnly(source: string) {
  const tokens = tokenizeJava(source);
  let index = 0;
  while (index < tokens.length) {
    if (!["package", "import"].includes(tokens[index]?.value ?? "")) {
      return false;
    }
    while (index < tokens.length && tokens[index]?.value !== ";") index += 1;
    if (tokens[index]?.value !== ";") return false;
    index += 1;
  }
  return true;
}

export const javaAdapter: LanguageAdapter = {
  language: "java",
  extensions: supportedExtensions.java,
  isContextOnly: isJavaContextOnly,
  analyze(file) {
    const tokens = tokenizeJava(file.content);
    const pairs = delimiterPairs(tokens);
    const units: JavaUnit[] = [];
    let index = 0;
    while (index < tokens.length) {
      const value = tokens[index]?.value;
      if (value === "package" || value === "import") {
        while (index < tokens.length && tokens[index]?.value !== ";")
          index += 1;
        index += 1;
        continue;
      }
      const parsed = parseType(file, tokens, pairs, index);
      if (parsed) {
        units.push(...parsed.units);
        index = parsed.next;
        continue;
      }
      index += 1;
    }
    return units.map(({ javaName: _javaName, owner: _owner, ...unit }) => unit);
  },
};
