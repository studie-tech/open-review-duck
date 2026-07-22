import type {
  AnalyzedUnit,
  LanguageAdapter,
  SourceFile,
  SupportedLanguage,
  UnitKind,
} from "../../types";
import { supportedExtensions } from "../../types";
import { isTestLikePath, makeUnit, type SourceRange } from "../shared";

const GO_LANGUAGE = "go" as SupportedLanguage;

interface Token {
  value: string;
  from: number;
  to: number;
}

interface PendingUnit {
  unit: Omit<AnalyzedUnit, "depth" | "reviewOrder">;
  stableName: string;
  simpleNames: string[];
  references: string[];
  directOwner?: string;
}

const goKeywords = new Set([
  "any",
  "bool",
  "break",
  "byte",
  "case",
  "chan",
  "comparable",
  "complex128",
  "complex64",
  "const",
  "continue",
  "default",
  "defer",
  "else",
  "error",
  "fallthrough",
  "false",
  "float32",
  "float64",
  "for",
  "func",
  "go",
  "goto",
  "if",
  "imag",
  "import",
  "init",
  "int",
  "int16",
  "int32",
  "int64",
  "int8",
  "interface",
  "len",
  "make",
  "map",
  "nil",
  "package",
  "panic",
  "print",
  "println",
  "range",
  "real",
  "recover",
  "return",
  "rune",
  "select",
  "string",
  "struct",
  "switch",
  "true",
  "type",
  "uint",
  "uint16",
  "uint32",
  "uint64",
  "uint8",
  "uintptr",
  "var",
]);

const testHooks = new Set([
  "SetupSuite",
  "TearDownSuite",
  "SetupTest",
  "TearDownTest",
  "BeforeTest",
  "AfterTest",
]);

/** Blanks a masked span while retaining its newline offsets. */
function blankRange(masked: string[], from: number, to: number) {
  for (let index = from; index < to; index += 1) {
    if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
  }
}

/** Masks comments and Go literals without changing offsets or line structure. */
function maskGoSource(source: string) {
  const masked = [...source];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      const end = newline < 0 ? source.length : newline;
      blankRange(masked, index, end);
      index = end;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      const end = close < 0 ? source.length : close + 2;
      blankRange(masked, index, end);
      index = end;
      continue;
    }
    if (source[index] === "`") {
      const close = source.indexOf("`", index + 1);
      const end = close < 0 ? source.length : close + 1;
      blankRange(masked, index, end);
      index = end;
      continue;
    }
    if (source[index] === '"' || source[index] === "'") {
      const quote = source[index];
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        end += 1;
        if (source[end - 1] === quote) break;
      }
      blankRange(masked, index, end);
      index = end;
      continue;
    }
    index += 1;
  }
  return masked.join("");
}

/** Lexes Go and applies the language's automatic-semicolon rules. */
function goTokens(source: string) {
  const tokens: Token[] = [];
  /** Checks whether a token triggers Go's automatic semicolon rule. */
  const canTerminate = (value: string) =>
    /^[A-Za-z_]\w*$/.test(value) ||
    /^(?:literal|number)$/.test(value) ||
    [")", "]", "}", "++", "--"].includes(value) ||
    ["break", "continue", "fallthrough", "return"].includes(value);
  let previousValue: string | undefined;
  let index = 0;
  /** Appends one token and records it for semicolon inference. */
  const push = (value: string, from: number, to: number) => {
    tokens.push({ value, from, to });
    if (value !== ";") previousValue = value;
  };
  /** Inserts a synthetic semicolon when a source newline requires one. */
  const newline = (offset: number) => {
    if (
      previousValue &&
      canTerminate(previousValue) &&
      tokens.at(-1)?.value !== ";"
    ) {
      tokens.push({ value: ";", from: offset, to: offset });
    }
  };
  while (index < source.length) {
    const character = source[index] ?? "";
    if (character === "\n") {
      newline(index);
      index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      const end = close < 0 ? source.length : close + 2;
      const internalNewline = source.indexOf("\n", index + 2);
      if (internalNewline >= 0 && internalNewline < end)
        newline(internalNewline);
      index = end;
      continue;
    }
    if (character === "`" || character === '"' || character === "'") {
      const quote = character;
      const from = index;
      index += 1;
      while (index < source.length) {
        if (quote !== "`" && source[index] === "\\") {
          index += 2;
          continue;
        }
        index += 1;
        if (source[index - 1] === quote) break;
      }
      push("literal", from, index);
      continue;
    }
    const identifier = /^[A-Za-z_]\w*/.exec(source.slice(index));
    if (identifier) {
      push(identifier[0], index, index + identifier[0].length);
      index += identifier[0].length;
      continue;
    }
    const number =
      /^(?:0[xX][\dA-Fa-f]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d*)?(?:[eEpP][+-]?\d+)?)[A-Za-z_]*/.exec(
        source.slice(index),
      );
    if (number) {
      push("number", index, index + number[0].length);
      index += number[0].length;
      continue;
    }
    const operator = [
      "...",
      "<<=",
      ">>=",
      "&^=",
      ":=",
      "<-",
      "++",
      "--",
      "==",
      "!=",
      "<=",
      ">=",
      "&&",
      "||",
      "<<",
      ">>",
      "&^",
      "+=",
      "-=",
      "*=",
      "/=",
      "%=",
      "&=",
      "|=",
      "^=",
    ].find((candidate) => source.startsWith(candidate, index));
    if (operator) {
      push(operator, index, index + operator.length);
      index += operator.length;
      continue;
    }
    if ("{}()[];,=<>*&:+-/%!?.|^~".includes(character))
      push(character, index, index + 1);
    index += 1;
  }
  newline(source.length);
  return tokens;
}

/** Maps balanced delimiter token indexes in both directions. */
function paired(tokens: readonly Token[], open: string, close: string) {
  const result = new Map<number, number>();
  const stack: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value === open) stack.push(index);
    if (tokens[index]?.value === close) {
      const start = stack.pop();
      if (start !== undefined) {
        result.set(start, index);
        result.set(index, start);
      }
    }
  }
  return result;
}

/** Locates the start offset of the line containing a source position. */
function lineStart(source: string, offset: number) {
  return source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

/** Includes the contiguous Go doc-comment block above a declaration. */
function documentedStart(source: string, declarationStart: number) {
  const original = lineStart(source, declarationStart);
  let start = original;
  let cursor = original;
  while (cursor > 0) {
    const previousEnd = cursor - 1;
    const previousStart = source.lastIndexOf("\n", previousEnd - 1) + 1;
    if (/^\s*\/\//.test(source.slice(previousStart, previousEnd + 1))) {
      start = previousStart;
      cursor = previousStart;
      continue;
    }
    break;
  }
  if (start !== original) return start;
  const before = source.slice(0, original).replace(/[ \t\r\n]+$/, "");
  if (!before.endsWith("*/")) return original;
  const comment = before.lastIndexOf("/*");
  return comment >= 0 ? lineStart(source, comment) : original;
}

/** Estimates review complexity from Go control-flow constructs. */
function complexity(source: string) {
  const masked = maskGoSource(source);
  return (
    1 +
    (masked.match(/\b(?:if|for|range|select|case|go|defer)\b|&&|\|\||\?(?!\?)/g)
      ?.length ?? 0)
  );
}

/** Collects non-keyword identifiers referenced by a Go declaration. */
function references(
  source: string,
  range: SourceRange,
  ownNames: readonly string[],
) {
  const own = new Set(ownNames);
  const found = new Set<string>();
  const masked = maskGoSource(source.slice(range.from, range.to));
  for (const match of masked.matchAll(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?\b/g)) {
    const value = match[0];
    const simple = value.split(".").at(-1) ?? value;
    if (
      !goKeywords.has(value) &&
      !goKeywords.has(simple) &&
      !own.has(value) &&
      !own.has(simple)
    )
      found.add(value);
  }
  return [...found];
}

/** Resolves the base type owned by a method receiver. */
function receiverBase(header: string) {
  const receiver = /\bfunc\s*\(([^)]*)\)/.exec(maskGoSource(header))?.[1];
  if (!receiver) return undefined;
  const withoutName = receiver.trim().replace(/^[A-Za-z_]\w*\s+/, "");
  return /\*?\s*([A-Za-z_]\w*)/.exec(withoutName)?.[1];
}

/** Extracts a free-function or receiver-method name from its header. */
function functionName(header: string) {
  const masked = maskGoSource(header);
  if (!/^\s*func\b/.test(masked)) return undefined;
  const receiverEnd = /\bfunc\s*\([^)]*\)\s*/.exec(masked);
  if (receiverEnd)
    return /^([A-Za-z_]\w*)/.exec(
      masked.slice((receiverEnd.index ?? 0) + receiverEnd[0].length),
    )?.[1];
  return /\bfunc\s+([A-Za-z_]\w*)/.exec(masked)?.[1];
}

/** Classifies functions using Go and testify test conventions. */
function functionKind(
  name: string,
  receiver: string | undefined,
  path: string,
): UnitKind {
  const tests = /_test\.go$/i.test(path) || isTestLikePath(path);
  if (tests && receiver && /Suite$/.test(receiver) && testHooks.has(name))
    return "test_hook";
  if (tests && !receiver && /^(?:setup|teardown)/i.test(name))
    return "test_hook";
  if (
    tests &&
    /^(?:Test|Benchmark|Fuzz)[A-Z0-9_]|^Example(?:[A-Z0-9_]|$)|^TestMain$/.test(
      name,
    )
  )
    return "test";
  if (
    tests &&
    receiver &&
    /Suite$/.test(receiver) &&
    /^Test[A-Z0-9_]/.test(name)
  )
    return "test";
  return receiver ? "method" : "function";
}

/** Recognizes package and import declarations without implementation. */
function isGoContextOnly(source: string) {
  let remaining = maskGoSource(source);
  let previous = "";
  while (remaining !== previous) {
    previous = remaining;
    remaining = remaining
      .replace(/^\s*package\s+[A-Za-z_]\w*\s*;?\s*/, "")
      .replace(
        /^\s*import\s+(?:\([^)]*\)|(?:[._A-Za-z]\w*\s+)?\s*)\s*;?\s*/,
        "",
      );
  }
  return remaining.trim().length === 0;
}

/** Extracts all names declared by one const or var specification. */
function namesFromSpec(spec: string) {
  const masked = maskGoSource(spec).trim();
  const beforeType = masked.split(/:=|=/, 1)[0] ?? masked;
  const declared =
    /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+/.exec(beforeType)?.[1] ??
    beforeType;
  return declared
    .split(",")
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_]\w*$/.test(name));
}

/** Builds declaration-level units following Go package and receiver semantics. */
function analyzeGo(file: SourceFile) {
  const source = file.content;
  const tokens = goTokens(source);
  const braces = paired(tokens, "{", "}");
  const parens = paired(tokens, "(", ")");
  const pending: PendingUnit[] = [];
  let initIndex = 0;

  /** Adds a pending Go unit with documentation and references attached. */
  const addUnit = (
    kind: UnitKind,
    displayName: string,
    stableName: string,
    range: SourceRange,
    ownNames: string[],
    directOwner?: string,
  ) => {
    const reviewRange = {
      from: documentedStart(source, range.from),
      to: range.to,
    };
    const unitReferences = references(source, reviewRange, ownNames);
    pending.push({
      unit: makeUnit(
        file,
        GO_LANGUAGE,
        kind,
        displayName,
        reviewRange,
        unitReferences.map((name) => `${file.path}:${name}`),
        complexity(source.slice(reviewRange.from, reviewRange.to)),
        stableName,
      ),
      stableName,
      simpleNames: ownNames,
      references: unitReferences,
      directOwner,
    });
  };

  /** Splits a grouped declaration or type body into logical specs. */
  const specRanges = (open: number, close: number) => {
    const result: SourceRange[] = [];
    let start = tokens[open]?.to ?? 0;
    let nestedParens = 0;
    let nestedBrackets = 0;
    let nestedBraces = 0;
    for (let index = open + 1; index < close; index += 1) {
      const token = tokens[index];
      if (!token) continue;
      if (token.value === "(") nestedParens += 1;
      else if (token.value === ")")
        nestedParens = Math.max(0, nestedParens - 1);
      else if (token.value === "[") nestedBrackets += 1;
      else if (token.value === "]")
        nestedBrackets = Math.max(0, nestedBrackets - 1);
      else if (token.value === "{") nestedBraces += 1;
      else if (token.value === "}")
        nestedBraces = Math.max(0, nestedBraces - 1);
      else if (
        token.value === ";" &&
        nestedParens === 0 &&
        nestedBrackets === 0 &&
        nestedBraces === 0
      ) {
        if (source.slice(start, token.from).trim())
          result.push({ from: start, to: token.from });
        start = token.to;
      }
    }
    const end = tokens[close]?.from ?? start;
    if (source.slice(start, end).trim()) result.push({ from: start, to: end });
    return result;
  };

  /** Emits struct fields or interface members owned by a type. */
  const addFields = (
    owner: string,
    open: number,
    close: number,
    interfaceType: boolean,
  ) => {
    let constraintIndex = 0;
    for (const range of specRanges(open, close)) {
      const text = source.slice(range.from, range.to);
      const compact = maskGoSource(text).replace(/\s+/g, " ").trim();
      if (!compact) continue;
      if (interfaceType) {
        const method = /^([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/.exec(
          compact,
        )?.[1];
        if (method) {
          addUnit(
            "method",
            `${owner}.${method}`,
            `${owner}.${method}`,
            range,
            [method],
            owner,
          );
        } else {
          const embedded = /(?:^|\|\s*~?)([A-Za-z_]\w*)/.exec(compact)?.[1];
          const name = embedded ?? `constraint ${constraintIndex + 1}`;
          addUnit(
            "variable",
            `${owner}.${name}`,
            `${owner}.constraint:${constraintIndex}`,
            range,
            embedded ? [embedded] : [],
            owner,
          );
          constraintIndex += 1;
        }
        continue;
      }
      const beforeTag = text.replace(/`[\s\S]*`\s*$/, "");
      const first = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+/.exec(
        maskGoSource(beforeTag),
      )?.[1];
      const names = first
        ? first.split(",").map((name) => name.trim())
        : [
            /(?:\*|\[\])?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*$/.exec(
              maskGoSource(beforeTag).trim(),
            )?.[1] ?? "embedded",
          ];
      for (const name of names)
        addUnit(
          "variable",
          `${owner}.${name}`,
          `${owner}.${name}`,
          range,
          [name],
          owner,
        );
    }
  };

  /** Emits independently named function literals inside a parent function. */
  const addNamedLiterals = (body: SourceRange, parent: string) => {
    const text = source.slice(body.from, body.to);
    const masked = maskGoSource(text);
    const pattern =
      /\b(?:var\s+([A-Za-z_]\w*)(?:\s+[^=;\n]+)?\s*=|([A-Za-z_]\w*)\s*:=)\s*func\s*\(/g;
    for (const match of masked.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const name = match[1] ?? match[2];
      if (!name) continue;
      const absolute = body.from + match.index;
      let literalParens = 0;
      let sawFunction = false;
      const open = tokens.findIndex((token) => {
        if (token.from < absolute || token.to > body.to) return false;
        if (token.value === "func") sawFunction = true;
        if (!sawFunction) return false;
        if (token.value === "(") literalParens += 1;
        else if (token.value === ")")
          literalParens = Math.max(0, literalParens - 1);
        return token.value === "{" && literalParens === 0;
      });
      const close = open >= 0 ? braces.get(open) : undefined;
      if (close === undefined) continue;
      addUnit(
        "function",
        `${parent}.${name}`,
        `${parent}.literal:${name}`,
        { from: absolute, to: tokens[close]?.to ?? body.to },
        [name],
        parent,
      );
    }
  };

  let index = 0;
  while (index < tokens.length) {
    while (tokens[index]?.value === ";") index += 1;
    const start = tokens[index];
    if (!start) break;
    let cursor = index;
    let depthParens = 0;
    let depthBrackets = 0;
    let boundary: number | undefined;
    while (cursor < tokens.length) {
      const value = tokens[cursor]?.value;
      if (value === "(") depthParens += 1;
      else if (value === ")") depthParens = Math.max(0, depthParens - 1);
      else if (value === "[") depthBrackets += 1;
      else if (value === "]") depthBrackets = Math.max(0, depthBrackets - 1);
      else if (
        (value === ";" || value === "{") &&
        depthParens === 0 &&
        depthBrackets === 0
      ) {
        boundary = cursor;
        break;
      }
      cursor += 1;
    }
    if (boundary === undefined) break;
    const boundaryToken = tokens[boundary];
    if (!boundaryToken) break;
    const header = source.slice(start.from, boundaryToken.from);
    const compact = maskGoSource(header).replace(/\s+/g, " ").trim();

    if (/^(?:package|import)\b/.test(compact)) {
      if (boundaryToken.value === "{") {
        const close = braces.get(boundary);
        index = close === undefined ? boundary + 1 : close + 1;
      } else index = boundary + 1;
      continue;
    }

    if (boundaryToken.value === "{") {
      const close = braces.get(boundary);
      if (close === undefined) break;
      const end = tokens[close]?.to ?? boundaryToken.to;
      const typeMatch =
        /^type\s+([A-Za-z_]\w*)(?:\s*\[[^\]]*\])?\s+(struct|interface)\s*$/.exec(
          compact,
        );
      if (typeMatch?.[1] && typeMatch[2]) {
        const name = typeMatch[1];
        addUnit(
          "class",
          name,
          name,
          { from: start.from, to: boundaryToken.to },
          [name],
        );
        addFields(name, boundary, close, typeMatch[2] === "interface");
        index = close + 1;
        continue;
      }
      const definedType = /^type\s+([A-Za-z_]\w*)/.exec(compact)?.[1];
      if (definedType) {
        addUnit(
          "class",
          definedType,
          definedType,
          { from: start.from, to: end },
          [definedType],
        );
        index = close + 1;
        continue;
      }
      const name = functionName(header);
      if (name) {
        const receiver = receiverBase(header);
        const display = receiver ? `${receiver}.${name}` : name;
        const stable =
          name === "init" && !receiver ? `init:${initIndex++}` : display;
        const kind = functionKind(name, receiver, file.path);
        addUnit(
          kind,
          display,
          kind === "test" ? `test:${stable}` : stable,
          { from: start.from, to: end },
          [name],
          receiver,
        );
        addNamedLiterals(
          { from: boundaryToken.to, to: tokens[close]?.from ?? end },
          stable,
        );
        index = close + 1;
        continue;
      }
      const binding = /^(?:var|const)\s+([A-Za-z_]\w*)/.exec(compact);
      if (binding?.[1]) {
        const bindingName = binding[1];
        const functionLiteral = /\bfunc\s*\(/.test(compact);
        let declarationClose = close;
        let tail = close + 1;
        while (tail < tokens.length && tokens[tail]?.value !== ";") {
          if (tokens[tail]?.value === "{") {
            const tailClose = braces.get(tail);
            if (tailClose === undefined) break;
            declarationClose = tailClose;
            tail = tailClose + 1;
            continue;
          }
          tail += 1;
        }
        addUnit(
          functionLiteral
            ? "function"
            : /^const\b/.test(compact)
              ? "constant"
              : "variable",
          bindingName,
          bindingName,
          { from: start.from, to: tokens[declarationClose]?.to ?? end },
          [bindingName],
        );
        index = declarationClose + 1;
      } else {
        index = close + 1;
      }
      if (tokens[index]?.value === ";") index += 1;
      continue;
    }

    const end = boundaryToken.from;
    const statement = source.slice(start.from, end);
    const grouped = /^(const|var|type)\s*\(/.exec(compact)?.[1];
    if (grouped) {
      const open = tokens.findIndex(
        (token, tokenIndex) =>
          tokenIndex >= index && tokenIndex < boundary && token.value === "(",
      );
      const close = open >= 0 ? parens.get(open) : undefined;
      if (open >= 0 && close !== undefined) {
        const specs = specRanges(open, close);
        const implicitConstGroup =
          grouped === "const" &&
          specs.some((range) => {
            const text = maskGoSource(source.slice(range.from, range.to));
            return /\biota\b/.test(text) || !/[=:]/.test(text);
          });
        if (implicitConstGroup) {
          const names = specs.flatMap((range) =>
            namesFromSpec(source.slice(range.from, range.to)),
          );
          const first = names[0] ?? "constants";
          addUnit(
            "constant",
            `${first} constants`,
            `const-group:${names.join(",")}`,
            { from: start.from, to: tokens[close]?.to ?? end },
            names,
          );
        } else {
          for (const range of specs) {
            const text = source.slice(range.from, range.to);
            if (grouped === "type") {
              const typeName = /^\s*([A-Za-z_]\w*)/.exec(
                maskGoSource(text),
              )?.[1];
              if (typeName) {
                const openBrace = tokens.findIndex(
                  (token) =>
                    token.from >= range.from &&
                    token.to <= range.to &&
                    token.value === "{",
                );
                const closeBrace =
                  openBrace >= 0 ? braces.get(openBrace) : undefined;
                const aggregate = /\b(struct|interface)\s*\{/.exec(
                  maskGoSource(text),
                )?.[1];
                if (
                  aggregate &&
                  openBrace >= 0 &&
                  closeBrace !== undefined &&
                  (tokens[closeBrace]?.to ?? 0) <= range.to
                ) {
                  addUnit(
                    "class",
                    typeName,
                    typeName,
                    { from: range.from, to: tokens[openBrace]?.to ?? range.to },
                    [typeName],
                  );
                  addFields(
                    typeName,
                    openBrace,
                    closeBrace,
                    aggregate === "interface",
                  );
                } else {
                  addUnit("class", typeName, typeName, range, [typeName]);
                }
              }
            } else {
              const names = namesFromSpec(text);
              if (names.length)
                addUnit(
                  grouped === "const" ? "constant" : "variable",
                  names.join(", "),
                  names.join(","),
                  range,
                  names,
                );
            }
          }
        }
      }
      index = boundary + 1;
      continue;
    }
    const typeName = /^type\s+([A-Za-z_]\w*)/.exec(compact)?.[1];
    if (typeName) {
      addUnit("class", typeName, typeName, { from: start.from, to: end }, [
        typeName,
      ]);
      index = boundary + 1;
      continue;
    }
    const bindingKind = /^(const|var)\b/.exec(compact)?.[1];
    if (bindingKind) {
      const names = namesFromSpec(
        statement.replace(/^\s*(?:const|var)\s+/, ""),
      );
      if (names.length)
        addUnit(
          bindingKind === "const" ? "constant" : "variable",
          names.join(", "),
          names.join(","),
          { from: start.from, to: end },
          names,
        );
    }
    index = boundary + 1;
  }

  const byStable = new Map<string, PendingUnit[]>();
  const bySimple = new Map<string, PendingUnit[]>();
  for (const candidate of pending) {
    byStable.set(candidate.stableName, [
      ...(byStable.get(candidate.stableName) ?? []),
      candidate,
    ]);
    for (const name of candidate.simpleNames)
      bySimple.set(name, [...(bySimple.get(name) ?? []), candidate]);
  }
  return pending.map((candidate) => {
    const dependencies = new Set<string>();
    for (const reference of candidate.references) {
      const simple = reference.split(".").at(-1) ?? reference;
      const matches = byStable.get(reference) ?? bySimple.get(simple) ?? [];
      const dependency = matches.length === 1 ? matches[0] : undefined;
      if (dependency && dependency !== candidate)
        dependencies.add(dependency.unit.stableKey);
    }
    if (candidate.unit.kind === "class") {
      for (const member of pending)
        if (member.directOwner === candidate.stableName)
          dependencies.add(member.unit.stableKey);
    }
    return { ...candidate.unit, dependencies: [...dependencies] };
  });
}

/** Go parser that emits package-level concepts and receiver-aware methods. */
export const goAdapter: LanguageAdapter = {
  language: GO_LANGUAGE,
  extensions: supportedExtensions.go,
  isContextOnly: isGoContextOnly,
  analyze: analyzeGo,
};

export const goParserInternals = {
  analyzeGo,
  goTokens,
  isGoContextOnly,
  maskGoSource,
};
