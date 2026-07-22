import type {
  AnalyzedUnit,
  LanguageAdapter,
  SourceFile,
  UnitKind,
} from "../../types";
import { supportedExtensions } from "../../types";
import { isTestLikePath, makeUnit, type SourceRange } from "../shared";

const C_LANGUAGE = "c" as const;

interface Token {
  value: string;
  from: number;
  to: number;
}

interface Directive {
  from: number;
  to: number;
  source: string;
}

interface PendingUnit {
  unit: Omit<AnalyzedUnit, "depth" | "reviewOrder">;
  stableName: string;
  simpleNames: string[];
  references: string[];
  ownerType?: string;
}

const cKeywords = new Set([
  "_Alignas",
  "_Alignof",
  "_Atomic",
  "_Bool",
  "_Complex",
  "_Generic",
  "_Imaginary",
  "_Noreturn",
  "_Static_assert",
  "_Thread_local",
  "alignas",
  "alignof",
  "auto",
  "bool",
  "break",
  "case",
  "char",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "extern",
  "false",
  "float",
  "for",
  "goto",
  "if",
  "inline",
  "int",
  "long",
  "nullptr",
  "register",
  "restrict",
  "return",
  "short",
  "signed",
  "sizeof",
  "static",
  "static_assert",
  "struct",
  "switch",
  "thread_local",
  "true",
  "typedef",
  "typeof",
  "typeof_unqual",
  "union",
  "unsigned",
  "void",
  "volatile",
  "while",
]);

const controlCalls = new Set([
  "_Alignof",
  "_Generic",
  "_Static_assert",
  "alignof",
  "for",
  "if",
  "sizeof",
  "static_assert",
  "switch",
  "typeof",
  "typeof_unqual",
  "while",
]);

const lifecycleNames = new Set([
  "setUp",
  "tearDown",
  "suite_setup",
  "suite_teardown",
  "group_setup",
  "group_teardown",
  "test_setup",
  "test_teardown",
]);

/** Masks comments and literals while preserving every source offset. */
function maskCSource(source: string) {
  const masked = [...source];
  /** Blanks a masked span while retaining its newline offsets. */
  const blank = (from: number, to: number) => {
    for (let cursor = from; cursor < to; cursor += 1) {
      if (masked[cursor] !== "\n" && masked[cursor] !== "\r") {
        masked[cursor] = " ";
      }
    }
  };
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      const end = newline < 0 ? source.length : newline;
      blank(index, end);
      index = end;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      const end = close < 0 ? source.length : close + 2;
      blank(index, end);
      index = end;
      continue;
    }
    const literal = /^(?:u8|u|U|L)?(["'])/.exec(source.slice(index));
    if (literal) {
      const quote = literal[1];
      let end = index + literal[0].length;
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
    index += 1;
  }
  return masked.join("");
}

/** Returns logical preprocessor directives, preserving continuation lines. */
function preprocessorRanges(source: string) {
  const ranges: Directive[] = [];
  const masked = maskCSource(source);
  const lines = source.split(/(?<=\n)/);
  let offset = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const from = offset;
    offset += line.length;
    if (!/^\s*#/.test(masked.slice(from, from + line.length))) continue;
    let directive = line;
    let to = offset;
    while (/\\\s*(?:\r?\n)?$/.test(directive) && lineIndex + 1 < lines.length) {
      lineIndex += 1;
      const continuation = lines[lineIndex] ?? "";
      directive += continuation;
      offset += continuation.length;
      to = offset;
    }
    ranges.push({ from, to, source: directive });
  }
  return ranges;
}

/** Recognizes includes, pragmas, and an otherwise inert header guard. */
function isCContextOnly(source: string) {
  const masked = [...maskCSource(source)];
  const guardNames = new Set<string>();
  for (const directive of preprocessorRanges(source)) {
    const normalized = directive.source.replace(/\\\s*\r?\n/g, " ").trim();
    const guard =
      /^#\s*ifndef\s+([A-Za-z_]\w*)/.exec(normalized)?.[1] ??
      /^#\s*if\s*!\s*defined\s*\(?\s*([A-Za-z_]\w*)/.exec(normalized)?.[1];
    if (guard) guardNames.add(guard);
    const definition = /^#\s*define\s+([A-Za-z_]\w*)(?:\s+(\S+))?\s*$/.exec(
      normalized,
    );
    const contextual =
      /^#\s*(?:include|include_next|pragma|line)\b/.test(normalized) ||
      /^#\s*(?:if|ifdef|ifndef|elif|else|endif)\b/.test(normalized) ||
      Boolean(
        definition &&
          guardNames.has(definition[1] ?? "") &&
          (!definition[2] || definition[2] === "1"),
      );
    if (!contextual) continue;
    for (let index = directive.from; index < directive.to; index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
    }
  }
  return masked.join("").trim().length === 0;
}

/** Tokenizes declaration syntax after removing preprocessor directives. */
function cTokens(source: string, directives: readonly Directive[]) {
  const masked = [...maskCSource(source)];
  for (const directive of directives) {
    for (let index = directive.from; index < directive.to; index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
    }
  }
  const tokens: Token[] = [];
  const expression =
    /\.\.\.|->|<<=|>>=|&&|\|\||==|!=|<=|>=|\+\+|--|<<|>>|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|[A-Za-z_]\w*|(?:0[xX][\dA-Fa-f]+|\d+(?:\.\d+)?(?:[eEpP][+-]?\d+)?)[A-Za-z_]*|[{}()[\];,=<>*&:+\-/%!?.|^~]/g;
  for (const match of masked.join("").matchAll(expression)) {
    if (match.index === undefined) continue;
    tokens.push({
      value: match[0],
      from: match.index,
      to: match.index + match[0].length,
    });
  }
  return tokens;
}

/** Maps balanced delimiter token indexes in both directions. */
function pairTokens(tokens: readonly Token[], open: string, close: string) {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value === open) stack.push(index);
    if (tokens[index]?.value === close) {
      const start = stack.pop();
      if (start !== undefined) {
        pairs.set(start, index);
        pairs.set(index, start);
      }
    }
  }
  return pairs;
}

/** Locates the start offset of the line containing a source position. */
function lineStart(source: string, offset: number) {
  return source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

/** Includes contiguous Doxygen and documentation comments with a declaration. */
function documentedStart(source: string, declarationStart: number) {
  const original = lineStart(source, declarationStart);
  let start = original;
  let cursor = original;
  while (cursor > 0) {
    const previousEnd = cursor - 1;
    const previousStart = source.lastIndexOf("\n", previousEnd - 1) + 1;
    const line = source.slice(previousStart, previousEnd + 1);
    if (/^\s*\/\/[!/]/.test(line)) {
      start = previousStart;
      cursor = previousStart;
      continue;
    }
    break;
  }
  if (start !== original) return start;
  const before = source.slice(0, original).replace(/[ \t\r\n]+$/, "");
  if (!before.endsWith("*/")) return original;
  const commentStart = before.lastIndexOf("/*");
  return commentStart >= 0 && /^\/\*[*!]/.test(before.slice(commentStart))
    ? commentStart
    : original;
}

/** Estimates review complexity from C control-flow constructs. */
function complexity(source: string) {
  const masked = maskCSource(source);
  return (
    1 +
    (masked.match(/\b(?:if|for|while|case)\b|&&|\|\||\?(?![?:])/g)?.length ?? 0)
  );
}

/** Collects non-keyword identifiers referenced inside a declaration. */
function identifierReferences(
  source: string,
  range: SourceRange,
  ownNames: readonly string[],
) {
  const own = new Set(ownNames);
  const found = new Set<string>();
  const masked = maskCSource(source.slice(range.from, range.to));
  for (const match of masked.matchAll(/\b[A-Za-z_]\w*\b/g)) {
    const value = match[0];
    if (!cKeywords.has(value) && !own.has(value)) found.add(value);
  }
  return [...found];
}

/** Splits a C expression only at unnested delimiter occurrences. */
function splitTopLevel(value: string, delimiter = ",") {
  const masked = maskCSource(value);
  const parts: Array<{ value: string; from: number; to: number }> = [];
  let start = 0;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "(") parens += 1;
    else if (char === ")") parens = Math.max(0, parens - 1);
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets = Math.max(0, brackets - 1);
    else if (char === "{") braces += 1;
    else if (char === "}") braces = Math.max(0, braces - 1);
    else if (
      char === delimiter &&
      parens === 0 &&
      brackets === 0 &&
      braces === 0
    ) {
      parts.push({ value: value.slice(start, index), from: start, to: index });
      start = index + 1;
    }
  }
  parts.push({ value: value.slice(start), from: start, to: value.length });
  return parts;
}

/** Extracts the declared function name from a C declarator header. */
function functionName(header: string) {
  const masked = maskCSource(header)
    .replace(/__attribute__\s*\(\([\s\S]*?\)\)/g, " ")
    .replace(/__declspec\s*\([\s\S]*?\)/g, " ")
    .replace(/\[\[[\s\S]*?\]\]/g, " ");
  const candidates = [...masked.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)]
    .map((match) => match[1] ?? "")
    .filter((name) => !controlCalls.has(name) && !cKeywords.has(name));
  return candidates[0];
}

/** Extracts variable and function-pointer names from a declaration. */
function variableNames(statement: string) {
  const masked = maskCSource(statement).replace(/;\s*$/, "");
  const functionPointer = [
    ...masked.matchAll(/\(\s*\*\s*(?:const\s+)?([A-Za-z_]\w*)\s*\)/g),
  ].map((match) => match[1] ?? "");
  if (functionPointer.length) return functionPointer;
  return splitTopLevel(masked).flatMap(({ value }) => {
    const beforeInitializer = value.split("=", 1)[0] ?? value;
    const withoutBitWidth = beforeInitializer.replace(/:\s*\d+\s*$/, "");
    const match = /([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?$/.exec(
      withoutBitWidth.trim(),
    );
    return match?.[1] ? [match[1]] : [];
  });
}

/** Distinguishes data declarations from expression-like statements. */
function isPlausibleVariable(statement: string) {
  const compact = maskCSource(statement).trim();
  if (
    !compact ||
    /^(?:return|break|continue|goto|case|default|_Static_assert|static_assert)\b/.test(
      compact,
    )
  ) {
    return false;
  }
  if (/^typedef\b[\s\S]*\(\s*\*\s*[A-Za-z_]\w*\s*\)/.test(compact)) {
    return true;
  }
  if (/^\w+\s*\([^;]*\)\s*;?$/.test(compact)) return false;
  return /\b(?:typedef|extern|static|const|volatile|_Atomic|_Thread_local|register|auto|signed|unsigned|short|long|void|char|int|float|double|struct|union|enum|[A-Za-z_]\w*)\b[\s\S]*[A-Za-z_]\w*(?:\s*\[[^\]]*\])?(?:\s*=|\s*;)/.test(
    compact,
  );
}

/** Classifies declared data as mutable state or a constant. */
function variableKind(statement: string, names: readonly string[]): UnitKind {
  const masked = maskCSource(statement);
  const immutableObject =
    /\bconst\b/.test(masked) && !/\bconst\b[^=;]*[*&]/.test(masked);
  return immutableObject ||
    names.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name))
    ? "constant"
    : "variable";
}

/** Checks whether a repository path is a public-style C header. */
function isHeaderPath(path: string) {
  return /\.h$/i.test(path);
}

/** Checks whether a declaration has an attached documentation block. */
function isDocumented(source: string, offset: number) {
  return documentedStart(source, offset) < lineStart(source, offset);
}

/** Classifies C functions according to common test conventions. */
function testIdentity(name: string, header: string, path: string): UnitKind {
  const testFile = isTestLikePath(path);
  if (lifecycleNames.has(name) && testFile) return "test_hook";
  if (
    testFile &&
    (/^test(?:_|[A-Z])/.test(name) ||
      /\bvoid\s*\*\*\s*(?:state|context)\b/.test(header))
  ) {
    return "test";
  }
  return "function";
}

/** Parses a preprocessor definition into its review identity. */
function macroIdentity(source: string) {
  const normalized = source.replace(/\\\s*\r?\n/g, " ");
  const match =
    /^\s*#\s*define\s+([A-Za-z_]\w*)(\s*\([^\n]*?\))?\s*([\s\S]*)$/.exec(
      normalized,
    );
  if (!match?.[1]) return undefined;
  return {
    name: match[1],
    parameters: match[2],
    replacement: (match[3] ?? "").trim(),
  };
}

/** Builds semantically focused C units from a balanced lexical scan. */
function analyzeC(file: SourceFile) {
  const source = file.content;
  const directives = preprocessorRanges(source);
  const tokens = cTokens(source, directives);
  const braces = pairTokens(tokens, "{", "}");
  const pending: PendingUnit[] = [];
  const headerGuardNames = new Set(
    directives.flatMap(({ source: directive }) => {
      const normalized = directive.replace(/\\\s*\r?\n/g, " ");
      const name =
        /^\s*#\s*ifndef\s+([A-Za-z_]\w*)/.exec(normalized)?.[1] ??
        /^\s*#\s*if\s*!\s*defined\s*\(?\s*([A-Za-z_]\w*)/.exec(normalized)?.[1];
      return name ? [name] : [];
    }),
  );

  /** Adds a pending C unit with documentation and references attached. */
  const addUnit = (
    kind: UnitKind,
    name: string,
    stableName: string,
    range: SourceRange,
    ownNames: string[],
    ownerType?: string,
  ) => {
    const reviewRange = {
      from: documentedStart(source, range.from),
      to: range.to,
    };
    const references = identifierReferences(source, reviewRange, ownNames);
    pending.push({
      unit: makeUnit(
        file,
        C_LANGUAGE,
        kind,
        name,
        reviewRange,
        references.map((reference) => `${file.path}:${reference}`),
        complexity(source.slice(reviewRange.from, reviewRange.to)),
        stableName,
      ),
      stableName,
      simpleNames: ownNames,
      references,
      ownerType,
    });
  };

  /** Resolves the typedef alias following an aggregate body. */
  const typeAliasAfter = (closeIndex: number, endIndex: number) => {
    const tailFrom = tokens[closeIndex]?.to ?? 0;
    const tailTo = tokens[endIndex]?.from ?? tailFrom;
    const tail = source.slice(tailFrom, tailTo);
    return variableNames(`${tail};`).at(-1);
  };

  /** Emits fields or variants owned directly by an aggregate type. */
  const addAggregateMembers = (
    owner: string,
    openIndex: number,
    closeIndex: number,
    aggregateKind: "struct" | "union" | "enum",
  ) => {
    const bodyFrom = tokens[openIndex]?.to ?? 0;
    const bodyTo = tokens[closeIndex]?.from ?? bodyFrom;
    const body = source.slice(bodyFrom, bodyTo);
    if (aggregateKind === "enum") {
      for (const part of splitTopLevel(body)) {
        const match = /^\s*([A-Za-z_]\w*)/.exec(maskCSource(part.value));
        const member = match?.[1];
        if (!member) continue;
        const leading = part.value.search(/\S/);
        const trailing = part.value.match(/\s*$/)?.[0].length ?? 0;
        const from = bodyFrom + part.from + Math.max(0, leading);
        const to = bodyFrom + part.to - trailing;
        addUnit(
          "constant",
          `${owner}.${member}`,
          `${owner}.${member}`,
          { from, to },
          [member],
          owner,
        );
      }
      return;
    }
    let segmentStart = bodyFrom;
    let parens = 0;
    let brackets = 0;
    let nestedBraces = 0;
    for (let index = openIndex + 1; index < closeIndex; index += 1) {
      const token = tokens[index];
      if (!token) continue;
      if (token.value === "(") parens += 1;
      else if (token.value === ")") parens = Math.max(0, parens - 1);
      else if (token.value === "[") brackets += 1;
      else if (token.value === "]") brackets = Math.max(0, brackets - 1);
      else if (token.value === "{") nestedBraces += 1;
      else if (token.value === "}")
        nestedBraces = Math.max(0, nestedBraces - 1);
      else if (
        token.value === ";" &&
        parens === 0 &&
        brackets === 0 &&
        nestedBraces === 0
      ) {
        const statement = source.slice(segmentStart, token.to);
        const names = variableNames(statement);
        for (const member of names) {
          addUnit(
            variableKind(statement, [member]),
            `${owner}.${member}`,
            `${owner}.${member}`,
            { from: segmentStart, to: token.to },
            [member],
            owner,
          );
        }
        segmentStart = token.to;
      }
    }
  };

  let index = 0;
  while (index < tokens.length) {
    while (tokens[index]?.value === ";") index += 1;
    const startIndex = index;
    const start = tokens[startIndex];
    if (!start) break;
    let cursor = startIndex;
    let parens = 0;
    let brackets = 0;
    let boundary: number | undefined;
    while (cursor < tokens.length) {
      const value = tokens[cursor]?.value;
      if (value === "(") parens += 1;
      else if (value === ")") parens = Math.max(0, parens - 1);
      else if (value === "[") brackets += 1;
      else if (value === "]") brackets = Math.max(0, brackets - 1);
      else if (
        (value === ";" || value === "{") &&
        parens === 0 &&
        brackets === 0
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
    const maskedHeader = maskCSource(header);

    if (boundaryToken.value === "{") {
      const close = braces.get(boundary);
      if (close === undefined) break;
      let endIndex = close;
      while (
        tokens[endIndex + 1]?.value !== ";" &&
        endIndex + 1 < tokens.length
      ) {
        const next = tokens[endIndex + 1]?.value;
        if (next === "{" || next === "}") break;
        if (next === "(") break;
        endIndex += 1;
      }
      if (tokens[endIndex + 1]?.value === ";") endIndex += 1;
      const typeMatch =
        /^\s*(typedef\s+)?(struct|union|enum)\s*([A-Za-z_]\w*)?\s*(?:__attribute__\s*\(\([\s\S]*\)\)\s*)?$/.exec(
          maskedHeader,
        );
      if (typeMatch) {
        const alias = typeAliasAfter(close, endIndex);
        const tag = typeMatch[3];
        const typeName = alias ?? tag ?? `<anonymous ${typeMatch[2]}>`;
        const shellRange = {
          from: start.from,
          to: boundaryToken.to,
        };
        addUnit("class", typeName, typeName, shellRange, [
          typeName,
          ...(tag ? [tag] : []),
        ]);
        addAggregateMembers(
          typeName,
          boundary,
          close,
          typeMatch[2] as "struct" | "union" | "enum",
        );
        index = endIndex + 1;
        continue;
      }

      const criterion = /^\s*(Test|Theory)\s*\(([^,()]+),\s*([^,()]+)/.exec(
        maskedHeader,
      );
      const check = /^\s*START_TEST\s*\(\s*([A-Za-z_]\w*)\s*\)/.exec(
        maskedHeader,
      );
      const name = criterion
        ? `${criterion[2]?.trim()} › ${criterion[3]?.trim()}`
        : (check?.[1] ?? functionName(header));
      if (name) {
        const end = tokens[close]?.to ?? boundaryToken.to;
        const kind: UnitKind =
          criterion || check ? "test" : testIdentity(name, header, file.path);
        addUnit(
          kind,
          name,
          kind === "test" ? `test:${name}` : name,
          { from: start.from, to: end },
          [name],
        );
        index = close + 1;
        if (check && tokens[index]?.value === "END_TEST") index += 1;
        if (tokens[index]?.value === ";") index += 1;
        continue;
      }

      const names = variableNames(
        `${header}${source.slice(boundaryToken.from, tokens[endIndex]?.to ?? boundaryToken.to)}`,
      );
      if (names.length) {
        const statementEnd = tokens[endIndex]?.to ?? boundaryToken.to;
        const statement = source.slice(start.from, statementEnd);
        addUnit(
          variableKind(statement, names),
          names.join(", "),
          names.join(","),
          { from: start.from, to: statementEnd },
          names,
        );
      }
      index = endIndex + 1;
      continue;
    }

    const end = boundaryToken.to;
    const statement = source.slice(start.from, end);
    if (
      /^\s*(?:struct|union|enum)\s+[A-Za-z_]\w*\s*;\s*$/.test(
        maskCSource(statement),
      )
    ) {
      index = boundary + 1;
      continue;
    }
    const declarationName = functionName(statement);
    if (declarationName) {
      // K&R definitions put parameter declarations between the signature and
      // body. Continue only while those declarations cannot be a new function.
      let oldStyleCursor = boundary + 1;
      let oldStyleBody: number | undefined;
      let sawParameterDeclaration = false;
      const oldStyleCandidate = /\)\s+[A-Za-z_]\w*[\s\S]*;\s*$/.test(
        maskCSource(statement),
      );
      while (oldStyleCandidate && oldStyleCursor < tokens.length) {
        const value = tokens[oldStyleCursor]?.value;
        if (value === "{") {
          oldStyleBody = oldStyleCursor;
          break;
        }
        if (value === "(") break;
        if (value === ";") sawParameterDeclaration = true;
        if (value === "}") break;
        oldStyleCursor += 1;
      }
      if (sawParameterDeclaration && oldStyleBody !== undefined) {
        const close = braces.get(oldStyleBody);
        if (close !== undefined) {
          const kind = testIdentity(declarationName, header, file.path);
          addUnit(
            kind,
            declarationName,
            kind === "test" ? `test:${declarationName}` : declarationName,
            { from: start.from, to: tokens[close]?.to ?? end },
            [declarationName],
          );
          index = close + 1;
          continue;
        }
      }
      const importantPrototype =
        isHeaderPath(file.path) ||
        isDocumented(source, start.from) ||
        /\bextern\b/.test(maskedHeader);
      if (importantPrototype) {
        addUnit(
          "function",
          declarationName,
          `prototype:${declarationName}`,
          { from: start.from, to: end },
          [declarationName],
        );
      }
      index = boundary + 1;
      continue;
    }
    const typeAlias = /^\s*typedef\b/.test(maskedHeader)
      ? variableNames(statement)
      : [];
    const names = typeAlias.length ? typeAlias : variableNames(statement);
    if (names.length && isPlausibleVariable(statement)) {
      const kind = typeAlias.length
        ? "variable"
        : variableKind(statement, names);
      addUnit(
        kind,
        names.join(", "),
        names.join(","),
        { from: start.from, to: end },
        names,
      );
    }
    index = boundary + 1;
  }

  for (const directive of directives) {
    const macro = macroIdentity(directive.source);
    if (!macro) continue;
    const guardLike =
      !macro.parameters &&
      (!macro.replacement || macro.replacement === "1") &&
      (headerGuardNames.has(macro.name) ||
        /(?:_H|_INCLUDED|_GUARD)$/.test(macro.name));
    if (guardLike) continue;
    addUnit(
      macro.parameters ? "function" : "constant",
      macro.name,
      `macro:${macro.name}`,
      { from: directive.from, to: directive.to },
      [macro.name],
    );
  }

  const byStableName = new Map<string, PendingUnit[]>();
  const bySimpleName = new Map<string, PendingUnit[]>();
  for (const candidate of pending) {
    byStableName.set(candidate.stableName, [
      ...(byStableName.get(candidate.stableName) ?? []),
      candidate,
    ]);
    for (const name of candidate.simpleNames) {
      bySimpleName.set(name, [...(bySimpleName.get(name) ?? []), candidate]);
    }
  }
  return pending.map((candidate) => {
    const dependencies = new Set<string>();
    for (const reference of candidate.references) {
      const matches =
        byStableName.get(reference) ?? bySimpleName.get(reference);
      const definitions = matches?.filter(
        ({ stableName }) => !stableName.startsWith("prototype:"),
      );
      const dependency =
        definitions?.length === 1
          ? definitions[0]
          : matches?.length === 1
            ? matches[0]
            : undefined;
      if (dependency && dependency !== candidate)
        dependencies.add(dependency.unit.stableKey);
    }
    if (candidate.unit.kind === "class") {
      for (const member of pending) {
        if (member.ownerType === candidate.stableName)
          dependencies.add(member.unit.stableKey);
      }
    }
    return { ...candidate.unit, dependencies: [...dependencies] };
  });
}

/** C parser that favors declarations and data relationships meaningful in review. */
export const cAdapter: LanguageAdapter = {
  language: C_LANGUAGE,
  extensions: supportedExtensions.c,
  isContextOnly: isCContextOnly,
  analyze: analyzeC,
};

export const cParserInternals = {
  analyzeC,
  isCContextOnly,
  maskCSource,
  preprocessorRanges,
};
