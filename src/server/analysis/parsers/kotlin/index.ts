import type {
  AnalyzedUnit,
  LanguageAdapter,
  SourceFile,
  UnitKind,
} from "../../types";
import { supportedExtensions } from "../../types";
import { makeUnit, type SourceRange } from "../shared";

type ReviewUnit = Omit<AnalyzedUnit, "depth" | "reviewOrder">;

interface Token {
  value: string;
  from: number;
  to: number;
  kind: "identifier" | "literal" | "symbol";
}

interface Declaration extends SourceRange {
  declarationFrom: number;
  name: string;
  owner?: string;
  bodyFrom?: number;
  bodyTo?: number;
  type: "type" | "function" | "property" | "constructor" | "init";
  flavor?: string;
}

interface Pending {
  unit: ReviewUnit;
  aliases: string[];
  references: string[];
  owner?: string;
}

const testAnnotations = new Set([
  "Test",
  "ParameterizedTest",
  "RepeatedTest",
  "TestFactory",
  "TestTemplate",
]);
const hookAnnotations = new Set([
  "Before",
  "BeforeAll",
  "BeforeClass",
  "BeforeEach",
  "After",
  "AfterAll",
  "AfterClass",
  "AfterEach",
]);
const dslSuites = new Set([
  "context",
  "describe",
  "given",
  "when",
  "feature",
  "scenario",
]);
const dslTestCalls = new Set([
  "it",
  "test",
  "then",
  "should",
  "expect",
  "property",
]);
const dslHooks = new Set([
  "beforeTest",
  "afterTest",
  "beforeEach",
  "afterEach",
  "beforeSpec",
  "afterSpec",
  "beforeGroup",
  "afterGroup",
]);
const keywords = new Set([
  "as",
  "break",
  "by",
  "catch",
  "class",
  "companion",
  "const",
  "constructor",
  "continue",
  "data",
  "do",
  "else",
  "enum",
  "false",
  "finally",
  "for",
  "fun",
  "if",
  "import",
  "in",
  "init",
  "interface",
  "is",
  "null",
  "object",
  "package",
  "return",
  "sealed",
  "super",
  "this",
  "throw",
  "true",
  "try",
  "typealias",
  "typeof",
  "val",
  "var",
  "value",
  "when",
  "while",
]);

/** Tokenizes Kotlin with comments, templates, chars, and raw strings opaque. */
function tokenizeKotlin(source: string) {
  const tokens: Token[] = [];
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
      let depth = 1;
      let cursor = index + 2;
      while (cursor < source.length && depth > 0) {
        if (source.startsWith("/*", cursor)) {
          depth += 1;
          cursor += 2;
        } else if (source.startsWith("*/", cursor)) {
          depth -= 1;
          cursor += 2;
        } else cursor += 1;
      }
      index = cursor;
      continue;
    }
    if (source.startsWith('"""', index)) {
      const from = index;
      const close = source.indexOf('"""', index + 3);
      index = close < 0 ? source.length : close + 3;
      tokens.push({ value: "<raw-string>", from, to: index, kind: "literal" });
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
        index += 1;
        if (source[index - 1] === quote) break;
      }
      tokens.push({ value: "<literal>", from, to: index, kind: "literal" });
      continue;
    }
    const escapedIdentifier = /^`([^`]+)`/.exec(source.slice(index));
    if (escapedIdentifier) {
      tokens.push({
        value: escapedIdentifier[1] ?? escapedIdentifier[0],
        from: index,
        to: index + escapedIdentifier[0].length,
        kind: "identifier",
      });
      index += escapedIdentifier[0].length;
      continue;
    }
    const identifier = /^[A-Za-z_][\w$]*/.exec(source.slice(index))?.[0];
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
      /^(?:0[xX][\dA-Fa-f_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?)(?:[eE][+-]?[\d_]+)?[fFuUlL]*/.exec(
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
    const symbol = [
      "===",
      "!==",
      "::",
      "->",
      "?.",
      "?:",
      "!!",
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
      "..",
      "..<",
    ].find((candidate) => source.startsWith(candidate, index));
    tokens.push({
      value: symbol ?? character,
      from: index,
      to: index + (symbol?.length ?? 1),
      kind: "symbol",
    });
    index += symbol?.length ?? 1;
  }
  return tokens;
}

/** Builds balanced delimiter pairs for Kotlin structural tokens. */
function delimiterPairs(tokens: readonly Token[]) {
  const pairs = new Map<number, number>();
  const stacks = new Map<string, number[]>([
    ["(", []],
    ["[", []],
    ["{", []],
    ["<", []],
  ]);
  const opening = new Map([
    [")", "("],
    ["]", "["],
    ["}", "}"],
    [">", "<"],
  ]);
  // Curly braces are paired explicitly because their closing token maps to itself.
  tokens.forEach((token, index) => {
    if (token.value === "{") {
      stacks.get("{")?.push(index);
      return;
    }
    if (token.value === "}") {
      const from = stacks.get("{")?.pop();
      if (from !== undefined) pairs.set(from, index);
      return;
    }
    const stack = stacks.get(token.value);
    if (stack) stack.push(index);
    else {
      const open = opening.get(token.value);
      const from = open ? stacks.get(open)?.pop() : undefined;
      if (from !== undefined) pairs.set(from, index);
    }
  });
  return pairs;
}

/** Returns the source offset at which the containing line begins. */
function lineStart(source: string, offset: number) {
  return source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

/** Returns the source offset at which the containing line ends. */
function lineEnd(source: string, offset: number) {
  const newline = source.indexOf("\n", offset);
  return newline < 0 ? source.length : newline;
}

/** Includes attached KDoc, comments, and annotations with a declaration. */
function documentedStart(source: string, declarationFrom: number) {
  let start = lineStart(source, declarationFrom);
  let cursor = start;
  while (cursor > 0) {
    const previousEnd = cursor - 1;
    const previousStart = lineStart(source, previousEnd);
    const line = source.slice(previousStart, previousEnd).replace(/\r$/, "");
    if (/^\s*(?:@|\/\/)/.test(line)) {
      start = previousStart;
      cursor = previousStart;
      continue;
    }
    if (/\*\/\s*$/.test(line)) {
      const commentStart = source.lastIndexOf("/*", previousEnd);
      if (
        commentStart >= 0 &&
        !/\n\s*\n/.test(source.slice(commentStart, cursor))
      ) {
        start = lineStart(source, commentStart);
      }
    }
    break;
  }
  return start;
}

/** Recognizes package/import declarations and comments as contextual preamble. */
export function isContextOnly(source: string) {
  const tokens = tokenizeKotlin(source);
  let index = 0;
  while (index < tokens.length) {
    const head = tokens[index]?.value;
    if (head !== "package" && head !== "import") return false;
    index += 1;
    while (index < tokens.length) {
      const token = tokens[index];
      if (!token) break;
      if (token.value === ";") {
        index += 1;
        break;
      }
      const nextHead = token.value;
      if (
        (nextHead === "package" || nextHead === "import") &&
        token.from === lineStart(source, token.from)
      ) {
        break;
      }
      index += 1;
      if (
        index < tokens.length &&
        tokens[index] &&
        lineStart(source, tokens[index]?.from ?? 0) >
          lineStart(source, token.from)
      ) {
        break;
      }
    }
  }
  return true;
}

/** Extracts declaration annotation names, including use-site annotations. */
function annotationNames(
  source: string,
  from: number,
  declarationFrom: number,
) {
  return [
    ...source
      .slice(from, declarationFrom)
      .matchAll(/@(?:\w+:)?([A-Za-z_]\w*)/g),
  ].map((match) => match[1] ?? "");
}

/** Finds the nearest containing Kotlin type for a declaration range. */
function ownerOf(declaration: SourceRange, types: readonly Declaration[]) {
  return types
    .filter(
      (type) =>
        type.bodyFrom !== undefined &&
        type.bodyTo !== undefined &&
        type.bodyFrom < declaration.from &&
        type.bodyTo >= declaration.to,
    )
    .sort(
      (left, right) =>
        (left.bodyTo ?? 0) -
        (left.bodyFrom ?? 0) -
        ((right.bodyTo ?? 0) - (right.bodyFrom ?? 0)),
    )[0];
}

/** Extracts Kotlin type declarations and their nested ownership hierarchy. */
function typeDeclarations(
  source: string,
  tokens: readonly Token[],
  pairs: ReadonlyMap<number, number>,
) {
  const types: Declaration[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const previous = tokens[index - 1]?.value;
    const typeKeyword =
      token.value === "class" ||
      token.value === "interface" ||
      token.value === "object" ||
      token.value === "typealias";
    if (!typeKeyword) continue;
    if (token.value === "object" && tokens[index + 1]?.value === ":") continue;
    let nameToken = tokens[index + 1];
    let flavor = token.value;
    if (token.value === "object" && previous === "companion") {
      flavor = "companion object";
      if (nameToken?.kind !== "identifier") {
        nameToken = {
          value: "Companion",
          from: token.to,
          to: token.to,
          kind: "identifier",
        };
      }
    }
    if (nameToken?.kind !== "identifier") continue;
    if (previous === "enum") flavor = "enum class";
    else if (previous === "data") flavor = "data class";
    else if (previous === "sealed") flavor = `sealed ${token.value}`;
    else if (previous === "value") flavor = "value class";

    const declarationFrom =
      tokens[index - 1] &&
      ["companion", "enum", "data", "sealed", "value", "annotation"].includes(
        previous ?? "",
      )
        ? (tokens[index - 1]?.from ?? token.from)
        : token.from;
    if (token.value === "typealias") {
      const to = lineEnd(source, token.from);
      types.push({
        from: documentedStart(source, declarationFrom),
        to,
        declarationFrom,
        name: nameToken.value,
        type: "type",
        flavor,
      });
      continue;
    }
    let openingIndex: number | undefined;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const candidate = tokens[cursor];
      if (!candidate || candidate.from > lineEnd(source, token.from) + 2_000)
        break;
      if (candidate.value === "{") {
        openingIndex = cursor;
        break;
      }
      if (candidate.value === ";") break;
    }
    const closingIndex =
      openingIndex === undefined ? undefined : pairs.get(openingIndex);
    const to =
      closingIndex === undefined
        ? lineEnd(source, token.from)
        : (tokens[closingIndex]?.to ?? source.length);
    types.push({
      from: documentedStart(source, declarationFrom),
      to,
      declarationFrom,
      name: nameToken.value,
      bodyFrom:
        openingIndex === undefined ? undefined : tokens[openingIndex]?.from,
      bodyTo: closingIndex === undefined ? undefined : tokens[closingIndex]?.to,
      type: "type",
      flavor,
    });
  }
  for (const type of types) {
    const owner = ownerOf(type, types);
    if (owner) type.owner = [owner.owner, owner.name].filter(Boolean).join(".");
  }
  return types;
}

/** Extracts functions and extensions while excluding nested local helpers. */
function functionDeclarations(
  source: string,
  tokens: readonly Token[],
  pairs: ReadonlyMap<number, number>,
  types: readonly Declaration[],
) {
  const functions: Declaration[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.value !== "fun" || tokens[index + 1]?.value === "interface")
      continue;
    let openingIndex: number | undefined;
    let angle = 0;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const candidate = tokens[cursor];
      if (!candidate) break;
      if (candidate.value === "<") angle += 1;
      if (candidate.value === ">") angle = Math.max(0, angle - 1);
      if (candidate.value === "(" && angle === 0) {
        openingIndex = cursor;
        break;
      }
      if (["{", "=", ";"].includes(candidate.value)) break;
    }
    if (openingIndex === undefined) continue;
    const header = source.slice(token.to, tokens[openingIndex]?.from).trim();
    const match =
      /((?:[A-Za-z_][\w?<>., ]*\.)?)(`[^`]+`|[A-Za-z_]\w*)\s*$/.exec(header);
    if (!match) continue;
    const receiver = match[1]?.trim().replace(/\.$/, "").replace(/\s+/g, "");
    const simple = (match[2] ?? "anonymous").replaceAll("`", "");
    const parameterClose = pairs.get(openingIndex);
    if (parameterClose === undefined) continue;
    let cursor = parameterClose + 1;
    let bodyOpening: number | undefined;
    let expressionBody = false;
    while (cursor < tokens.length) {
      const candidate = tokens[cursor];
      if (!candidate) break;
      if (candidate.value === "{") {
        bodyOpening = cursor;
        break;
      }
      if (candidate.value === "=") {
        expressionBody = true;
        break;
      }
      if (
        candidate.value === ";" ||
        candidate.from > lineEnd(source, token.from) + 2_000
      )
        break;
      cursor += 1;
    }
    const bodyClose =
      bodyOpening === undefined ? undefined : pairs.get(bodyOpening);
    const to =
      bodyClose !== undefined
        ? (tokens[bodyClose]?.to ?? source.length)
        : expressionBody
          ? lineEnd(source, tokens[cursor]?.to ?? token.to)
          : lineEnd(source, tokens[parameterClose]?.to ?? token.to);
    const raw: Declaration = {
      from: documentedStart(source, token.from),
      to,
      declarationFrom: token.from,
      name: receiver ? `${receiver}.${simple}` : simple,
      type: "function",
      flavor: receiver ? "extension" : undefined,
    };
    const owner = ownerOf(raw, types);
    raw.owner = owner
      ? [owner.owner, owner.name].filter(Boolean).join(".")
      : undefined;
    if (
      functions.some((parent) => parent.from < raw.from && parent.to >= raw.to)
    ) {
      continue;
    }
    functions.push(raw);
  }
  return functions;
}

/** Extracts top-level and member properties, constants, delegates, and lambdas. */
function propertyDeclarations(
  source: string,
  tokens: readonly Token[],
  pairs: ReadonlyMap<number, number>,
  types: readonly Declaration[],
  functions: readonly Declaration[],
) {
  const properties: Declaration[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || !["val", "var"].includes(token.value)) continue;
    if (functions.some((fn) => fn.from < token.from && fn.to >= token.to))
      continue;
    let cursor = index + 1;
    let name: string;
    if (tokens[cursor]?.value === "(") {
      const close = pairs.get(cursor);
      if (close === undefined) continue;
      name = `destructured@${source.slice(0, token.from).split("\n").length}`;
      cursor = close + 1;
    } else {
      const candidate = tokens[cursor];
      if (candidate?.kind !== "identifier") continue;
      name = candidate.value;
    }
    let to = lineEnd(source, token.from);
    let lambda = false;
    for (
      let scan = cursor;
      scan < tokens.length && (tokens[scan]?.from ?? source.length) <= to;
      scan += 1
    ) {
      if (tokens[scan]?.value === "{") {
        const close = pairs.get(scan);
        if (close !== undefined) {
          to = tokens[close]?.to ?? to;
          lambda = source.slice(tokens[scan]?.from, to).includes("->");
        }
        break;
      }
      if (tokens[scan]?.value === ";") break;
    }
    const raw: Declaration = {
      from: documentedStart(source, token.from),
      to,
      declarationFrom: token.from,
      name,
      type: "property",
      flavor: [
        tokens[index - 1]?.value === "const" ? "const" : "",
        lambda ? "lambda" : "",
      ]
        .filter(Boolean)
        .join(" "),
    };
    if (
      types.some(
        (type) =>
          type.from < token.from &&
          type.bodyFrom !== undefined &&
          token.from < type.bodyFrom,
      )
    ) {
      continue;
    }
    const owner = ownerOf(raw, types);
    raw.owner = owner
      ? [owner.owner, owner.name].filter(Boolean).join(".")
      : undefined;
    properties.push(raw);
  }
  return properties;
}

/** Extracts independently reviewable secondary constructors and init blocks. */
function constructorAndInitDeclarations(
  source: string,
  tokens: readonly Token[],
  pairs: ReadonlyMap<number, number>,
  types: readonly Declaration[],
) {
  const declarations: Declaration[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || !["constructor", "init"].includes(token.value)) continue;
    const probe = { from: token.from, to: token.to };
    const owner = ownerOf(probe, types);
    if (!owner) continue;
    const opening = tokens.findIndex(
      (candidate, cursor) =>
        cursor > index && cursor < index + 80 && candidate.value === "{",
    );
    const closing = opening < 0 ? undefined : pairs.get(opening);
    const to =
      closing === undefined
        ? lineEnd(source, token.from)
        : (tokens[closing]?.to ?? source.length);
    declarations.push({
      from: documentedStart(source, token.from),
      to,
      declarationFrom: token.from,
      name: token.value,
      owner: [owner.owner, owner.name].filter(Boolean).join("."),
      type: token.value === "init" ? "init" : "constructor",
    });
  }
  return declarations;
}

/** Collects same-file callable, property, and qualified references. */
function expressionReferences(source: string) {
  const tokens = tokenizeKotlin(source);
  const found = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "identifier" || keywords.has(token.value)) continue;
    const segments = [token.value];
    let cursor = index + 1;
    while (
      [".", "?."].includes(tokens[cursor]?.value ?? "") &&
      tokens[cursor + 1]?.kind === "identifier"
    ) {
      segments.push(tokens[cursor + 1]?.value ?? "");
      cursor += 2;
    }
    if (
      segments.length > 1 ||
      tokens[cursor]?.value === "(" ||
      /^[A-Z_][A-Z0-9_]*$/.test(token.value)
    ) {
      found.add(segments.join("."));
    }
  }
  return [...found];
}

/** Estimates review complexity from Kotlin branching and control constructs. */
function complexityOf(source: string) {
  const tokens = tokenizeKotlin(source);
  return Math.max(
    1,
    1 +
      tokens.filter(({ value }) =>
        ["if", "when", "for", "while", "catch", "&&", "||", "?:"].includes(
          value,
        ),
      ).length,
  );
}

/** Creates an unresolved Kotlin review unit for dependency linking. */
function kotlinUnit(
  file: SourceFile,
  kind: UnitKind,
  name: string,
  declaration: Declaration,
  aliases: string[],
  stableName: string,
  owner?: string,
): Pending {
  const unit = makeUnit(
    file,
    "kotlin",
    kind,
    name,
    declaration,
    [],
    complexityOf(
      file.content.slice(declaration.declarationFrom, declaration.to),
    ),
    stableName,
  );
  return {
    unit: {
      ...unit,
      signature: file.content
        .slice(declaration.declarationFrom, declaration.to)
        .split(/[\n{=]/, 1)[0]
        ?.trim(),
    },
    aliases,
    references: expressionReferences(
      file.content.slice(declaration.from, declaration.to),
    ),
    owner,
  };
}

/** Extracts Kotest and Spek-style nested DSL tests and lifecycle hooks. */
function dslTests(
  source: string,
  tokens: readonly Token[],
  pairs: ReadonlyMap<number, number>,
  types: readonly Declaration[],
) {
  const suites: Array<{ from: number; to: number; label: string }> = [];
  const units: Array<{
    declaration: Declaration;
    kind: "test" | "hook";
    suites: string[];
  }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const role = dslSuites.has(token.value)
      ? "suite"
      : dslTestCalls.has(token.value)
        ? "test"
        : dslHooks.has(token.value)
          ? "hook"
          : undefined;
    let labelToken: Token | undefined;
    let opening: number | undefined;
    if (role && tokens[index + 1]?.value === "(") {
      const close = pairs.get(index + 1);
      labelToken =
        tokens[index + 2]?.kind === "literal" ? tokens[index + 2] : undefined;
      opening =
        close === undefined
          ? undefined
          : tokens[close + 1]?.value === "{"
            ? close + 1
            : undefined;
    } else if (role === "hook" && tokens[index + 1]?.value === "{") {
      opening = index + 1;
    } else if (token.kind === "literal" && tokens[index + 1]?.value === "{") {
      const owner = ownerOf(token, types);
      if (owner && /(?:Test|Spec)$/.test(owner.name)) {
        labelToken = token;
        opening = index + 1;
      }
    }
    if (opening === undefined) continue;
    const close = pairs.get(opening);
    if (close === undefined) continue;
    const label = labelToken
      ? source
          .slice(labelToken.from, labelToken.to)
          .replace(/^"+|"+$/g, "")
          .replace(/\s+/g, " ")
          .trim()
      : token.value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    if (role === "suite")
      suites.push({
        from: token.from,
        to: tokens[close]?.to ?? source.length,
        label,
      });
    else {
      const declaration: Declaration = {
        from: documentedStart(source, token.from),
        to: tokens[close]?.to ?? source.length,
        declarationFrom: token.from,
        name: label,
        type: "function",
      };
      units.push({
        declaration,
        kind: role === "hook" ? "hook" : "test",
        suites: [],
      });
    }
  }
  for (const candidate of units) {
    candidate.suites = suites
      .filter(
        (suite) =>
          suite.from < candidate.declaration.from &&
          suite.to >= candidate.declaration.to,
      )
      .sort((left, right) => left.from - right.from)
      .map(({ label }) => label);
  }
  return units;
}

/** Analyzes one Kotlin file into logical dependency-aware review units. */
function analyzeKotlin(file: SourceFile) {
  if (isContextOnly(file.content)) return [];
  const tokens = tokenizeKotlin(file.content);
  const pairs = delimiterPairs(tokens);
  const types = typeDeclarations(file.content, tokens, pairs);
  const functions = functionDeclarations(file.content, tokens, pairs, types);
  const properties = propertyDeclarations(
    file.content,
    tokens,
    pairs,
    types,
    functions,
  );
  const lifecycle = constructorAndInitDeclarations(
    file.content,
    tokens,
    pairs,
    types,
  );
  const dsl = dslTests(file.content, tokens, pairs, types);
  const pending: Pending[] = [];

  for (const type of types) {
    const qualified = [type.owner, type.name].filter(Boolean).join(".");
    const annotations = annotationNames(
      file.content,
      type.from,
      type.declarationFrom,
    );
    const testSuite =
      /(?:Test|Tests|Spec)$/.test(type.name) || annotations.includes("RunWith");
    const shell: Declaration = {
      ...type,
      to: type.bodyFrom === undefined ? type.to : type.bodyFrom + 1,
    };
    pending.push(
      kotlinUnit(
        file,
        testSuite ? "test_suite" : "class",
        qualified,
        shell,
        [qualified, type.name],
        `type:${qualified}`,
        type.owner,
      ),
    );
  }

  for (const fn of functions) {
    const annotations = annotationNames(
      file.content,
      fn.from,
      fn.declarationFrom,
    );
    const test = annotations.some((annotation) =>
      testAnnotations.has(annotation),
    );
    const hook = annotations.some((annotation) =>
      hookAnnotations.has(annotation),
    );
    const qualified = [fn.owner, fn.name].filter(Boolean).join(".");
    const display =
      test || hook ? `${fn.owner ?? "Tests"} › ${fn.name}` : qualified;
    pending.push(
      kotlinUnit(
        file,
        test ? "test" : hook ? "test_hook" : fn.owner ? "method" : "function",
        display,
        fn,
        [qualified, fn.name],
        `callable:${qualified}`,
        fn.owner,
      ),
    );
  }

  const initCounts = new Map<string, number>();
  for (const member of lifecycle) {
    const owner = member.owner ?? "Type";
    const occurrence = (initCounts.get(`${owner}:${member.type}`) ?? 0) + 1;
    initCounts.set(`${owner}:${member.type}`, occurrence);
    const label =
      member.type === "constructor"
        ? `${owner} constructor`
        : `${owner} init block${occurrence > 1 ? ` ${occurrence}` : ""}`;
    pending.push(
      kotlinUnit(
        file,
        "method",
        label,
        member,
        [label],
        `${member.type}:${owner}:${occurrence}`,
        owner,
      ),
    );
  }

  for (const property of properties) {
    const qualified = [property.owner, property.name].filter(Boolean).join(".");
    const kind: UnitKind = property.flavor?.includes("lambda")
      ? "function"
      : property.flavor?.includes("const") ||
          /^[A-Z][A-Z0-9_]*$/.test(property.name)
        ? "constant"
        : "variable";
    pending.push(
      kotlinUnit(
        file,
        kind,
        qualified,
        property,
        [qualified, property.name],
        `property:${qualified}`,
        property.owner,
      ),
    );
  }

  dsl.forEach((test, index) => {
    const owner = ownerOf(test.declaration, types);
    const name = [
      ...(owner ? [owner.name] : []),
      ...test.suites,
      test.declaration.name,
    ].join(" › ");
    pending.push(
      kotlinUnit(
        file,
        test.kind === "test" ? "test" : "test_hook",
        name,
        test.declaration,
        [],
        `dsl:${name || index + 1}`,
      ),
    );
  });

  const aliases = new Map<string, string>();
  for (const candidate of pending) {
    for (const alias of candidate.aliases)
      aliases.set(alias, candidate.unit.stableKey);
  }
  for (const shell of pending.filter(
    ({ unit }) => unit.kind === "class" || unit.kind === "test_suite",
  )) {
    const shellAlias = shell.aliases[0];
    shell.references.push(
      ...pending
        .filter(({ owner }) => owner === shellAlias)
        .map(({ unit }) => unit.stableKey),
    );
  }
  if (pending.length === 0) {
    const declaration: Declaration = {
      from: 0,
      to: file.content.length,
      declarationFrom: 0,
      name: "Kotlin statements",
      type: "property",
    };
    pending.push(
      kotlinUnit(
        file,
        "module",
        "Kotlin module statements",
        declaration,
        [],
        "module-statements",
      ),
    );
  }
  return pending
    .sort((left, right) => left.unit.startLine - right.unit.startLine)
    .map(({ unit, aliases: own, references }) => ({
      ...unit,
      dependencies: [
        ...new Set(
          references
            .filter((reference) => !own.includes(reference))
            .map((reference) => aliases.get(reference) ?? reference),
        ),
      ],
    }));
}

export const kotlinAdapter: LanguageAdapter = {
  language: "kotlin",
  extensions: supportedExtensions.kotlin,
  isContextOnly,
  analyze: analyzeKotlin,
};

export const kotlinParserInternals = { tokenizeKotlin };
