import type {
  AnalyzedUnit,
  LanguageAdapter,
  SourceFile,
  UnitKind,
} from "../../types";
import { supportedExtensions } from "../../types";
import { makeUnit, type SourceRange } from "../shared";

type ReviewUnit = Omit<AnalyzedUnit, "depth" | "reviewOrder">;

interface LuaToken {
  value: string;
  from: number;
  to: number;
  kind: "word" | "string" | "number" | "symbol";
}

interface FunctionCandidate extends SourceRange {
  declarationFrom: number;
  tokenIndex: number;
  functionIndex: number;
  name: string;
  owner?: string;
  member?: string;
  separator?: "." | ":";
}

interface PendingUnit {
  unit: ReviewUnit;
  aliases: string[];
  references: string[];
  requires: string[];
  owner?: string;
}

interface RequireBinding {
  localName?: string;
  moduleName: string;
  from: number;
  to: number;
}

const bustedSuites = new Set(["describe", "context"]);
const bustedTests = new Set(["it", "test"]);
const bustedHooks = new Set([
  "before_each",
  "after_each",
  "before_all",
  "after_all",
  "setup",
  "teardown",
]);
const luaKeywords = new Set([
  "and",
  "break",
  "do",
  "else",
  "elseif",
  "end",
  "false",
  "for",
  "function",
  "goto",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "until",
  "while",
]);

/** Locates a Lua long-bracket string or comment with arbitrary equals signs. */
function longBracketAt(source: string, from: number) {
  const opening = /^\[(=*)\[/.exec(source.slice(from));
  if (!opening) return undefined;
  const equals = opening[1] ?? "";
  const close = `]${equals}]`;
  const closing = source.indexOf(close, from + opening[0].length);
  return {
    from,
    to: closing < 0 ? source.length : closing + close.length,
    contentFrom: from + opening[0].length,
  };
}

/** Tokenizes Lua while keeping comments and every string form opaque. */
function tokenizeLua(source: string) {
  const tokens: LuaToken[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? "";
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (source.startsWith("--", index)) {
      const longComment = longBracketAt(source, index + 2);
      if (longComment) {
        index = longComment.to;
      } else {
        const newline = source.indexOf("\n", index + 2);
        index = newline < 0 ? source.length : newline + 1;
      }
      continue;
    }
    const longString = longBracketAt(source, index);
    if (longString) {
      tokens.push({
        value: source
          .slice(longString.contentFrom, longString.to)
          .replace(/\](?:=*)\]$/, ""),
        from: index,
        to: longString.to,
        kind: "string",
      });
      index = longString.to;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      const from = index;
      index += 1;
      let value = "";
      while (index < source.length) {
        if (source[index] === "\\") {
          value += source.slice(index, Math.min(source.length, index + 2));
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        value += source[index] ?? "";
        index += 1;
      }
      tokens.push({ value, from, to: index, kind: "string" });
      continue;
    }
    const identifier = /^[A-Za-z_][\w]*/.exec(source.slice(index))?.[0];
    if (identifier) {
      tokens.push({
        value: identifier,
        from: index,
        to: index + identifier.length,
        kind: "word",
      });
      index += identifier.length;
      continue;
    }
    const number = /^(?:0[xX][\dA-Fa-f]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      source.slice(index),
    )?.[0];
    if (number) {
      tokens.push({
        value: number,
        from: index,
        to: index + number.length,
        kind: "number",
      });
      index += number.length;
      continue;
    }
    const symbol = [
      "...",
      "::",
      "==",
      "~=",
      "<=",
      ">=",
      "//",
      "<<",
      ">>",
      "..",
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

/** Returns the source offset at which the containing line begins. */
function lineStart(source: string, offset: number) {
  return source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

/** Includes an immediately attached LuaDoc or ordinary line comment block. */
function documentedStart(source: string, declarationFrom: number) {
  let start = lineStart(source, declarationFrom);
  let cursor = start;
  while (cursor > 0) {
    const previousEnd = cursor - 1;
    const previousStart = lineStart(source, previousEnd);
    const line = source.slice(previousStart, previousEnd).replace(/\r$/, "");
    if (/^\s*--(?!\[)/.test(line)) {
      start = previousStart;
      cursor = previousStart;
      continue;
    }
    const longClose = /\](=*)\]\s*$/.exec(line);
    if (longClose) {
      const marker = `--[${longClose[1] ?? ""}[`;
      const commentStart = source.lastIndexOf(marker, previousEnd);
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

/** Finds a function's closing end while balancing nested Lua block forms. */
function functionEnd(tokens: readonly LuaToken[], functionIndex: number) {
  const stack: Array<{ type: string; awaitsDo?: boolean }> = [
    { type: "function" },
  ];
  for (let index = functionIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "word") continue;
    if (token.value === "function" || token.value === "if") {
      stack.push({ type: token.value });
    } else if (token.value === "for" || token.value === "while") {
      stack.push({ type: token.value, awaitsDo: true });
    } else if (token.value === "repeat") {
      stack.push({ type: "repeat" });
    } else if (token.value === "do") {
      const current = stack.at(-1);
      if (current?.awaitsDo) current.awaitsDo = false;
      else stack.push({ type: "do" });
    } else if (token.value === "until" && stack.at(-1)?.type === "repeat") {
      stack.pop();
    } else if (token.value === "end" && stack.at(-1)?.type !== "repeat") {
      stack.pop();
      if (stack.length === 0) return token.to;
    }
  }
  return tokens.at(-1)?.to ?? 0;
}

/** Parses a dotted or colon-qualified callable declaration path. */
function memberPath(tokens: readonly LuaToken[], from: number, to: number) {
  const segments: string[] = [];
  let separator: "." | ":" | undefined;
  for (let index = from; index < to; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.kind === "word") segments.push(token.value);
    else if (token.value === "." || token.value === ":")
      separator = token.value;
    else return undefined;
  }
  if (segments.length === 0) return undefined;
  return { segments, separator };
}

/** Extracts named Lua functions and closures without duplicating nested helpers. */
function declaredFunctions(source: string, tokens: readonly LuaToken[]) {
  const candidates: FunctionCandidate[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    let functionIndex: number | undefined;
    let nameFrom = index;
    let nameTo = index + 1;
    const declarationFrom = token.from;

    if (token.value === "local" && tokens[index + 1]?.value === "function") {
      functionIndex = index + 1;
      nameFrom = index + 2;
      nameTo = index + 3;
    } else if (token.value === "function") {
      functionIndex = index;
      nameFrom = index + 1;
      nameTo = tokens[nameFrom]?.kind === "word" ? nameFrom + 1 : nameFrom;
      while (
        [".", ":"].includes(tokens[nameTo]?.value ?? "") &&
        tokens[nameTo + 1]?.kind === "word"
      ) {
        nameTo += 2;
      }
    } else {
      let cursor = token.value === "local" ? index + 1 : index;
      const pathStart = cursor;
      if (tokens[cursor]?.kind !== "word") continue;
      cursor += 1;
      while (
        [".", ":"].includes(tokens[cursor]?.value ?? "") &&
        tokens[cursor + 1]?.kind === "word"
      ) {
        cursor += 2;
      }
      if (
        tokens[cursor]?.value === "=" &&
        tokens[cursor + 1]?.value === "function"
      ) {
        functionIndex = cursor + 1;
        nameFrom = pathStart;
        nameTo = cursor;
      }
    }
    if (functionIndex === undefined) continue;
    const path = memberPath(tokens, nameFrom, nameTo);
    if (!path) continue;
    const functionToken = tokens[functionIndex];
    if (!functionToken) continue;
    const to = functionEnd(tokens, functionIndex);
    const name = path.segments.join(path.separator ?? ".");
    const owner =
      path.segments.length > 1
        ? path.segments.slice(0, -1).join(".")
        : undefined;
    const member = path.segments.at(-1);
    candidates.push({
      from: documentedStart(source, declarationFrom),
      to,
      declarationFrom,
      tokenIndex: index,
      functionIndex,
      name,
      owner,
      member,
      separator: path.separator,
    });
    index = Math.max(index, nameTo - 1);
  }
  return candidates.filter(
    (candidate) =>
      !candidates.some(
        (parent) =>
          parent !== candidate &&
          parent.from < candidate.from &&
          parent.to >= candidate.to,
      ),
  );
}

/** Finds a balanced delimiter's matching token index. */
function matchingSymbol(
  tokens: readonly LuaToken[],
  openingIndex: number,
  opening: string,
  closing: string,
) {
  let depth = 0;
  for (let index = openingIndex; index < tokens.length; index += 1) {
    if (tokens[index]?.value === opening) depth += 1;
    if (tokens[index]?.value === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

/** Extracts require calls and their optional local binding names. */
function requireBindings(tokens: readonly LuaToken[]) {
  const bindings: RequireBinding[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    let cursor = index;
    let localName: string | undefined;
    if (tokens[cursor]?.value === "local") cursor += 1;
    if (
      tokens[cursor]?.kind === "word" &&
      tokens[cursor + 1]?.value === "=" &&
      tokens[cursor + 2]?.value === "require"
    ) {
      localName = tokens[cursor]?.value;
      cursor += 2;
    }
    if (tokens[cursor]?.value !== "require") continue;
    const opening = tokens[cursor + 1]?.value === "(" ? 1 : 0;
    const module = tokens[cursor + 1 + opening];
    if (module?.kind !== "string") continue;
    const endToken = tokens[cursor + 2 + opening + (opening ? 1 : 0)] ?? module;
    bindings.push({
      localName,
      moduleName: module.value,
      from: tokens[index]?.from ?? module.from,
      to: endToken.to,
    });
  }
  return bindings;
}

/** Checks whether tokens contain only require bindings and a module return. */
function isRequireSequence(tokens: readonly LuaToken[]) {
  if (tokens.length === 0) return true;
  let index = 0;
  while (index < tokens.length) {
    if (tokens[index]?.value === ";") {
      index += 1;
      continue;
    }
    if (
      tokens[index]?.value === "return" &&
      tokens[index + 1]?.kind === "word"
    ) {
      index += 2;
      continue;
    }
    if (tokens[index]?.value === "local") index += 1;
    if (
      tokens[index]?.kind === "word" &&
      tokens[index + 1]?.value === "=" &&
      tokens[index + 2]?.value === "require"
    ) {
      index += 2;
    }
    if (tokens[index]?.value !== "require") return false;
    index += 1;
    if (tokens[index]?.value === "(") index += 1;
    if (tokens[index]?.kind !== "string") return false;
    index += 1;
    if (tokens[index]?.value === ")") index += 1;
    if (tokens[index]?.value === ";") index += 1;
  }
  return true;
}

/** Recognizes comments, require bindings, and an inert returned-module tail. */
export function isContextOnly(source: string) {
  return isRequireSequence(tokenizeLua(source));
}

/** Extracts Busted suites, tests, and lifecycle callback ranges. */
function testCalls(source: string, tokens: readonly LuaToken[]) {
  const suites: Array<{ from: number; to: number; label: string }> = [];
  const tests: Array<{
    range: SourceRange;
    declarationFrom: number;
    label: string;
    role: "test" | "hook";
    functionIndex: number;
  }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const callee = tokens[index];
    if (callee?.kind !== "word") continue;
    const role = bustedSuites.has(callee.value)
      ? "suite"
      : bustedTests.has(callee.value)
        ? "test"
        : bustedHooks.has(callee.value)
          ? "hook"
          : undefined;
    if (!role || tokens[index + 1]?.value !== "(") continue;
    const labelToken = tokens[index + 2];
    let functionIndex: number | undefined;
    let label = callee.value.replaceAll("_", " ");
    if (labelToken?.kind === "string") {
      label = labelToken.value.replace(/\s+/g, " ").trim();
      functionIndex = tokens.findIndex(
        (token, candidate) =>
          candidate > index + 2 &&
          candidate < index + 9 &&
          token.value === "function",
      );
    } else {
      functionIndex =
        tokens[index + 2]?.value === "function" ? index + 2 : undefined;
    }
    if (functionIndex === undefined || functionIndex < 0) continue;
    const functionTo = functionEnd(tokens, functionIndex);
    let to = functionTo;
    let cursor = tokens.findIndex(
      (token, candidate) => candidate > functionIndex && token.to >= functionTo,
    );
    while (
      cursor + 1 < tokens.length &&
      [")", ";"].includes(tokens[cursor + 1]?.value ?? "")
    ) {
      cursor += 1;
      to = tokens[cursor]?.to ?? to;
    }
    if (role === "suite") suites.push({ from: callee.from, to, label });
    else {
      tests.push({
        range: { from: documentedStart(source, callee.from), to },
        declarationFrom: callee.from,
        label,
        role,
        functionIndex,
      });
    }
  }
  return tests.map((test) => ({
    ...test,
    suites: suites
      .filter(
        (suite) => suite.from < test.range.from && suite.to >= test.range.to,
      )
      .sort((left, right) => left.from - right.from)
      .map(({ label }) => label),
  }));
}

/** Extracts reviewable top-level values while excluding functions and tests. */
function topLevelAssignments(
  source: string,
  tokens: readonly LuaToken[],
  functions: readonly FunctionCandidate[],
  tests: ReturnType<typeof testCalls>,
) {
  const ranges: Array<{
    range: SourceRange;
    declarationFrom: number;
    name: string;
    table: boolean;
  }> = [];
  const occupied = [...functions, ...tests.map(({ range }) => range)];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      !token ||
      occupied.some(
        (range) => token.from >= range.from && token.from < range.to,
      )
    ) {
      continue;
    }
    let cursor = index;
    if (tokens[cursor]?.value === "local") cursor += 1;
    const nameToken = tokens[cursor];
    if (nameToken?.kind !== "word") continue;
    const names = [nameToken.value];
    cursor += 1;
    while (
      tokens[cursor]?.value === "." &&
      tokens[cursor + 1]?.kind === "word"
    ) {
      names.push(tokens[cursor + 1]?.value ?? "");
      cursor += 2;
    }
    if (tokens[cursor]?.value !== "=") continue;
    if (
      names.length > 1 ||
      tokens[cursor + 1]?.value === "function" ||
      tokens[cursor + 1]?.value === "require"
    ) {
      continue;
    }
    const value = tokens[cursor + 1];
    let to: number;
    const table = value?.value === "{";
    if (table) {
      const closing = matchingSymbol(tokens, cursor + 1, "{", "}");
      if (closing === undefined) continue;
      to = tokens[closing]?.to ?? value.to;
    } else {
      const newline = source.indexOf(
        "\n",
        value?.from ?? tokens[cursor]?.to ?? 0,
      );
      to = newline < 0 ? source.length : newline;
    }
    const declarationFrom =
      token.value === "local" ? token.from : nameToken.from;
    ranges.push({
      range: { from: documentedStart(source, declarationFrom), to },
      declarationFrom,
      name: names.join("."),
      table,
    });
    while (tokens[index + 1] && (tokens[index + 1]?.from ?? 0) < to) index += 1;
  }
  return ranges;
}

/** Collects callable and member references from executable Lua tokens. */
function expressionReferences(source: string) {
  const tokens = tokenizeLua(source);
  const references = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "word" || luaKeywords.has(token.value)) continue;
    const segments = [token.value];
    let cursor = index + 1;
    while (
      [".", ":"].includes(tokens[cursor]?.value ?? "") &&
      tokens[cursor + 1]?.kind === "word"
    ) {
      segments.push(tokens[cursor + 1]?.value ?? "");
      cursor += 2;
    }
    const qualified = segments.join(".");
    if (
      segments.length > 1 ||
      tokens[cursor]?.value === "(" ||
      tokens[index - 1]?.value === "return"
    ) {
      references.add(qualified);
    }
  }
  return [...references];
}

/** Estimates review complexity from Lua branching and loop constructs. */
function complexityOf(source: string) {
  const tokens = tokenizeLua(source);
  return Math.max(
    1,
    1 +
      tokens.filter(({ value }) =>
        ["if", "elseif", "for", "while", "repeat", "and", "or"].includes(value),
      ).length,
  );
}

/** Creates an unresolved Lua review unit for dependency linking. */
function luaUnit(
  file: SourceFile,
  kind: UnitKind,
  name: string,
  range: SourceRange,
  declarationFrom: number,
  aliases: string[],
  references: string[],
  requires: string[],
  stableName = name,
  owner?: string,
): PendingUnit {
  const unit = makeUnit(
    file,
    "lua",
    kind,
    name,
    range,
    [],
    complexityOf(file.content.slice(declarationFrom, range.to)),
    stableName,
  );
  return {
    unit: {
      ...unit,
      signature: file.content
        .slice(declarationFrom, range.to)
        .split("\n", 1)[0]
        ?.trim(),
    },
    aliases,
    references,
    requires,
    owner,
  };
}

/** Classifies conventional luaunit test-case methods and lifecycle hooks. */
function isLuaunitFunction(candidate: FunctionCandidate) {
  if (!candidate.owner || !/^Test[A-Za-z0-9_]*$/.test(candidate.owner))
    return undefined;
  const member = candidate.member ?? "";
  if (/^test[_A-Za-z0-9]*/i.test(member)) return "test" as const;
  if (
    ["setup", "teardown", "setupclass", "teardownclass"].includes(
      member.toLowerCase(),
    )
  ) {
    return "hook" as const;
  }
  return undefined;
}

/** Analyzes one Lua source file into logical dependency-aware review units. */
function analyzeLua(file: SourceFile) {
  if (isContextOnly(file.content)) return [];
  const tokens = tokenizeLua(file.content);
  const requires = requireBindings(tokens);
  const functions = declaredFunctions(file.content, tokens);
  const busted = testCalls(file.content, tokens);
  const assignments = topLevelAssignments(
    file.content,
    tokens,
    functions,
    busted,
  );
  const returnedModule = /\breturn\s+([A-Za-z_]\w*)\s*(?:;)?\s*$/.exec(
    file.content.replace(/--[^\n]*/g, ""),
  )?.[1];
  const owners = new Set(functions.map(({ owner }) => owner).filter(Boolean));
  const classOwners = new Set<string>();
  for (const owner of owners) {
    if (!owner) continue;
    if (
      new RegExp(
        `\\b${owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\.\\s*__index\\s*=`,
      ).test(file.content) ||
      new RegExp(
        `setmetatable\\s*\\(\\s*${owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      ).test(file.content)
    ) {
      classOwners.add(owner);
    }
  }

  const pending: PendingUnit[] = [];
  const bustedRanges = busted.map(({ range }) => range);
  for (const candidate of functions) {
    if (
      bustedRanges.some(
        (range) => candidate.from >= range.from && candidate.to <= range.to,
      )
    ) {
      continue;
    }
    const luaunit = isLuaunitFunction(candidate);
    const kind: UnitKind =
      luaunit === "test"
        ? "test"
        : luaunit === "hook"
          ? "test_hook"
          : candidate.owner
            ? "method"
            : "function";
    const displayName = luaunit
      ? `${candidate.owner} › ${candidate.member}`
      : candidate.name;
    const source = file.content.slice(candidate.from, candidate.to);
    const references = expressionReferences(source);
    if (candidate.owner) {
      for (const reference of [...references]) {
        if (reference.startsWith("self.")) {
          references.push(`${candidate.owner}.${reference.slice(5)}`);
        }
      }
    }
    pending.push(
      luaUnit(
        file,
        kind,
        displayName,
        candidate,
        candidate.declarationFrom,
        [candidate.name, candidate.name.replace(":", ".")],
        references,
        requires
          .filter(
            ({ localName }) =>
              localName && new RegExp(`\\b${localName}\\b`).test(source),
          )
          .map(({ moduleName }) => moduleName),
        `callable:${candidate.name.replace(":", ".")}`,
        candidate.owner,
      ),
    );
  }

  busted.forEach((test, index) => {
    const name = [...test.suites, test.label].join(" › ");
    const source = file.content.slice(test.range.from, test.range.to);
    pending.push(
      luaUnit(
        file,
        test.role === "test" ? "test" : "test_hook",
        name,
        test.range,
        test.declarationFrom,
        [],
        expressionReferences(source),
        requires
          .filter(
            ({ localName }) =>
              localName && new RegExp(`\\b${localName}\\b`).test(source),
          )
          .map(({ moduleName }) => moduleName),
        `${test.role}:${name || index + 1}`,
      ),
    );
  });

  for (const assignment of assignments) {
    const source = file.content.slice(
      assignment.range.from,
      assignment.range.to,
    );
    const ownerMethods = pending.filter(
      ({ owner }) => owner === assignment.name,
    );
    const moduleConcept = assignment.name === returnedModule;
    const classConcept = classOwners.has(assignment.name);
    const constant = /^[A-Z][A-Z0-9_]*$/.test(assignment.name);
    const kind: UnitKind = moduleConcept
      ? "module"
      : classConcept
        ? "class"
        : constant || assignment.table
          ? "constant"
          : "variable";
    const name = moduleConcept
      ? `Module ${assignment.name}`
      : classConcept
        ? `Class ${assignment.name}`
        : assignment.name;
    const unit = luaUnit(
      file,
      kind,
      name,
      assignment.range,
      assignment.declarationFrom,
      [assignment.name],
      expressionReferences(source),
      requires
        .filter(
          ({ localName }) =>
            localName && new RegExp(`\\b${localName}\\b`).test(source),
        )
        .map(({ moduleName }) => moduleName),
      `${moduleConcept ? "module" : classConcept ? "class" : "value"}:${assignment.name}`,
    );
    unit.references.push(
      ...ownerMethods.map(({ unit: method }) => method.stableKey),
    );
    pending.push(unit);
  }

  if (pending.length === 0) {
    pending.push(
      luaUnit(
        file,
        "module",
        "Lua module statements",
        { from: 0, to: file.content.length },
        0,
        [],
        expressionReferences(file.content),
        requires.map(({ moduleName }) => moduleName),
        "module-statements",
      ),
    );
  }

  const aliases = new Map<string, string>();
  for (const candidate of pending) {
    for (const alias of candidate.aliases)
      aliases.set(alias, candidate.unit.stableKey);
  }
  return pending
    .sort((left, right) => left.unit.startLine - right.unit.startLine)
    .map(({ unit, aliases: own, references, requires: usedRequires }) => ({
      ...unit,
      dependencies: [
        ...new Set([
          ...references
            .filter((reference) => !own.includes(reference))
            .map((reference) => aliases.get(reference) ?? reference)
            .filter((reference) => reference !== unit.name),
          ...usedRequires.map((moduleName) => `lua-require:${moduleName}`),
        ]),
      ],
    }));
}

export const luaAdapter: LanguageAdapter = {
  language: "lua",
  extensions: supportedExtensions.lua,
  isContextOnly,
  analyze: analyzeLua,
};

export const luaParserInternals = {
  tokenizeLua,
  functionEnd,
};
