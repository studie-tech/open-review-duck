import type {
  AnalyzedUnit,
  LanguageAdapter,
  SourceFile,
  UnitKind,
} from "../../types";
import { supportedExtensions } from "../../types";
import { isTestLikePath, makeUnit, type SourceRange } from "../shared";

const CPP_LANGUAGE = "cpp" as const;

interface Token {
  value: string;
  from: number;
  to: number;
}

interface Scope {
  names: string[];
  kind: "file" | "namespace" | "class";
  className?: string;
  testFixture?: boolean;
}

interface PendingUnit {
  unit: Omit<AnalyzedUnit, "depth" | "reviewOrder">;
  stableName: string;
  simpleName: string;
  scopeName: string;
  references: string[];
  directClass?: string;
}

const cppKeywords = new Set([
  "alignas",
  "alignof",
  "and",
  "and_eq",
  "asm",
  "auto",
  "bitand",
  "bitor",
  "bool",
  "break",
  "case",
  "catch",
  "char",
  "char8_t",
  "char16_t",
  "char32_t",
  "class",
  "compl",
  "concept",
  "const",
  "consteval",
  "constexpr",
  "constinit",
  "const_cast",
  "continue",
  "co_await",
  "co_return",
  "co_yield",
  "decltype",
  "default",
  "delete",
  "do",
  "double",
  "dynamic_cast",
  "else",
  "enum",
  "explicit",
  "export",
  "extern",
  "false",
  "final",
  "float",
  "for",
  "friend",
  "goto",
  "if",
  "inline",
  "int",
  "long",
  "mutable",
  "namespace",
  "new",
  "noexcept",
  "not",
  "not_eq",
  "nullptr",
  "operator",
  "or",
  "or_eq",
  "override",
  "private",
  "protected",
  "public",
  "register",
  "reinterpret_cast",
  "requires",
  "return",
  "short",
  "signed",
  "sizeof",
  "static",
  "static_assert",
  "static_cast",
  "struct",
  "switch",
  "template",
  "this",
  "thread_local",
  "throw",
  "true",
  "try",
  "typedef",
  "typeid",
  "typename",
  "union",
  "unsigned",
  "using",
  "virtual",
  "void",
  "volatile",
  "wchar_t",
  "while",
  "xor",
  "xor_eq",
]);

const controlLikeCalls = new Set([
  "alignas",
  "catch",
  "decltype",
  "for",
  "if",
  "noexcept",
  "requires",
  "sizeof",
  "static_assert",
  "switch",
  "typeid",
  "while",
]);

const googleTestMacros = new Set([
  "TEST",
  "TEST_F",
  "TEST_P",
  "TYPED_TEST",
  "TYPED_TEST_P",
]);

const catchTestMacros = new Set([
  "METHOD_AS_TEST_CASE",
  "REGISTER_TEST_CASE",
  "SCENARIO_METHOD",
  "TEST_CASE",
  "TEMPLATE_TEST_CASE",
  "TEMPLATE_TEST_CASE_METHOD",
  "TEMPLATE_PRODUCT_TEST_CASE",
  "TEMPLATE_PRODUCT_TEST_CASE_METHOD",
  "TEMPLATE_PRODUCT_TEST_CASE_SIG",
  "TEMPLATE_LIST_TEST_CASE",
  "TEMPLATE_LIST_TEST_CASE_METHOD",
  "SCENARIO",
  "TEMPLATE_TEST_CASE_SIG",
]);

const testSetupMacros = new Set([
  "INSTANTIATE_TEST_SUITE_P",
  "INSTANTIATE_TYPED_TEST_SUITE_P",
  "REGISTER_TYPED_TEST_SUITE_P",
  "TYPED_TEST_SUITE",
  "TYPED_TEST_SUITE_P",
]);

const testHookNames = new Set([
  "SetUp",
  "TearDown",
  "SetUpTestSuite",
  "TearDownTestSuite",
  "SetUpTestCase",
  "TearDownTestCase",
]);

/** Replaces comments and literal contents while preserving offsets and newlines. */
function maskCppSource(source: string) {
  const masked = [...source];
  /** Blanks a masked span while retaining its newline offsets. */
  const blank = (from: number, to: number) => {
    for (let index = from; index < to; index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
    }
  };
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      const to = end < 0 ? source.length : end;
      blank(index, to);
      index = to;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      const to = end < 0 ? source.length : end + 2;
      blank(index, to);
      index = to;
      continue;
    }
    const rawPrefix = /^(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\(/.exec(
      source.slice(index),
    );
    if (rawPrefix) {
      const delimiter = rawPrefix[1] ?? "";
      const terminator = `)${delimiter}"`;
      const end = source.indexOf(terminator, index + rawPrefix[0].length);
      const to = end < 0 ? source.length : end + terminator.length;
      blank(index, to);
      index = to;
      continue;
    }
    const literalPrefix = /^(?:u8|u|U|L)?(["'])/.exec(source.slice(index));
    if (literalPrefix) {
      const quote = literalPrefix[1];
      let end = index + literalPrefix[0].length;
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

/** Finds complete preprocessor directives, including backslash continuations. */
function preprocessorRanges(source: string) {
  const ranges: Array<{ from: number; to: number; source: string }> = [];
  const maskedSource = maskCppSource(source);
  let offset = 0;
  const lines = source.split(/(?<=\n)/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const from = offset;
    offset += line.length;
    if (!/^\s*#/.test(maskedSource.slice(from, from + line.length))) continue;
    let directive = line;
    let to = offset;
    while (/\\\s*(?:\r?\n)?$/.test(directive) && index + 1 < lines.length) {
      index += 1;
      const continuation = lines[index] ?? "";
      directive += continuation;
      offset += continuation.length;
      to = offset;
    }
    ranges.push({ from, to, source: directive });
  }
  return ranges;
}

/** Recognizes include/module directives and inert header guards as context. */
function isCppContextOnly(source: string) {
  const masked = [...maskCppSource(source)];
  for (const directive of preprocessorRanges(source)) {
    const normalized = directive.source.replace(/\\\s*\r?\n/g, " ").trim();
    const contextDirective =
      /^#\s*(?:include|include_next|import)\b/.test(normalized) ||
      /^#\s*pragma\s+once\b/.test(normalized) ||
      /^#\s*(?:if|ifdef|ifndef|elif|else|endif)\b/.test(normalized) ||
      /^#\s*define\s+[A-Za-z_]\w*(?:\s+1)?\s*$/.test(normalized);
    if (!contextDirective) continue;
    for (let index = directive.from; index < directive.to; index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
    }
  }
  return (
    masked
      .join("")
      .replace(
        /^\s*(?:(?:export\s+)?module(?:\s+[A-Za-z_]\w*(?:[.:][A-Za-z_]\w*)*)?|import\s+(?:<[^>]+>|"[^"]+"|[A-Za-z_]\w*(?:[.:][A-Za-z_]\w*)*))\s*;\s*$/gm,
        "",
      )
      .trim().length === 0
  );
}

/** Produces declaration tokens while excluding preprocessor directives. */
function cppTokens(
  source: string,
  directives: ReturnType<typeof preprocessorRanges>,
) {
  const masked = [...maskCppSource(source)];
  for (const directive of directives) {
    for (let index = directive.from; index < directive.to; index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
    }
  }
  const code = masked.join("");
  const tokens: Token[] = [];
  const expression =
    /::|->\*|->|<=>|<<=|>>=|\[\[|\]\]|&&|\|\||==|!=|<=|>=|\+\+|--|<<|>>|[A-Za-z_]\w*|\d+(?:\.\d+)?|[{}()[\];,=<>~*&:+\-/%!?.|^]/g;
  for (const match of code.matchAll(expression)) {
    const from = match.index;
    if (from === undefined) continue;
    tokens.push({ value: match[0], from, to: from + match[0].length });
  }
  return tokens;
}

/** Locates the start offset of the line containing a source position. */
function lineStart(source: string, offset: number) {
  return source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

/** Includes contiguous Doxygen comments in the visible declaration range. */
function documentedStart(source: string, declarationStart: number) {
  let start = lineStart(source, declarationStart);
  let cursor = start;
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
  if (start !== lineStart(source, declarationStart)) return start;
  const before = source.slice(0, start).replace(/[ \t\r\n]+$/, "");
  if (!before.endsWith("*/")) return start;
  const commentStart = before.lastIndexOf("/*");
  if (commentStart >= 0 && /^\/\*[*!]/.test(before.slice(commentStart))) {
    return commentStart;
  }
  return start;
}

/** Maps balanced brace token indexes in both directions. */
function bracePairs(tokens: readonly Token[]) {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value === "{") stack.push(index);
    if (tokens[index]?.value === "}") {
      const open = stack.pop();
      if (open !== undefined) {
        pairs.set(open, index);
        pairs.set(index, open);
      }
    }
  }
  return pairs;
}

/** Renders a namespace and class scope as a qualified C++ name. */
function scopeName(scope: Scope) {
  return scope.names.join("::");
}

/** Qualifies a declaration name unless it is already qualified. */
function qualify(scope: Scope, name: string) {
  if (name.includes("::")) return name.replace(/^::/, "");
  const prefix = scopeName(scope);
  return prefix ? `${prefix}::${name}` : name;
}

/** Collects non-keyword identifiers referenced by a declaration. */
function identifierReferences(
  source: string,
  range: SourceRange,
  ownNames: readonly string[],
) {
  const code = maskCppSource(source.slice(range.from, range.to));
  const own = new Set(
    ownNames.flatMap((name) => [name, name.split("::").at(-1) ?? name]),
  );
  const found = new Set<string>();
  const expression = /\b[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*\b/g;
  for (const match of code.matchAll(expression)) {
    const name = match[0];
    if (!cppKeywords.has(name) && !own.has(name)) found.add(name);
  }
  return [...found];
}

/** Estimates review complexity from C++ control-flow constructs. */
function complexity(source: string) {
  const code = maskCppSource(source);
  return (
    1 +
    (code.match(/\b(?:if|for|while|case|catch|co_await)\b|&&|\|\||\?(?![?:])/g)
      ?.length ?? 0)
  );
}

/** Decodes a static ordinary or raw string into a display label. */
function staticStringLabel(value: string) {
  const literal =
    /(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\(([\s\S]*?)\)\1"|(?:u8|u|U|L)?"((?:\\.|[^"\\])*)"/.exec(
      value,
    );
  return (literal?.[2] ?? literal?.[3])
    ?.replace(/\\([\\"])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

interface FunctionIdentity {
  name: string;
  displayName: string;
  kind: Extract<UnitKind, "function" | "method" | "test" | "test_hook">;
}

/** Recognizes functions, special members, operators, and common C++ test macros. */
function functionIdentity(
  header: string,
  scope: Scope,
): FunctionIdentity | undefined {
  const compact = maskCppSource(header).replace(/\s+/g, " ").trim();
  const originalCompact = header.replace(/\s+/g, " ").trim();
  const macroMatch =
    /^\s*([A-Z][A-Z0-9_]*)\s*\(([\s\S]*)\)\s*(?:const\b[^{}]*)?$/.exec(
      originalCompact,
    );
  if (macroMatch && googleTestMacros.has(macroMatch[1] ?? "")) {
    const args = (macroMatch[2] ?? "").split(",").map((value) => value.trim());
    const name = `${args[0] || "Test"} › ${args[1] || "case"}`;
    return { name, displayName: name, kind: "test" };
  }
  if (macroMatch && catchTestMacros.has(macroMatch[1] ?? "")) {
    const label =
      staticStringLabel(macroMatch[2] ?? "") ?? macroMatch[1] ?? "Test case";
    return { name: label, displayName: label, kind: "test" };
  }
  if (macroMatch && testSetupMacros.has(macroMatch[1] ?? "")) {
    const macro = macroMatch[1] ?? "Test";
    return {
      name: `${macro.replaceAll("_", " ").toLowerCase()} setup`,
      displayName: `${macro.replaceAll("_", " ").toLowerCase()} setup`,
      kind: "test_hook",
    };
  }
  const operator =
    /((?:[A-Za-z_]\w*::)*operator\s*(?:\(\)|\[\]|""\s*[A-Za-z_]\w*|new(?:\s*\[\s*\])?|delete(?:\s*\[\s*\])?|[^\s(]+))\s*\(/
      .exec(compact)?.[1]
      ?.replace(/\s+/g, "");
  const destructor = /((?:[A-Za-z_]\w*::)*~[A-Za-z_]\w*)\s*\(/.exec(
    compact,
  )?.[1];
  const normalCandidates = [
    ...compact.matchAll(/((?:[A-Za-z_]\w*::)*[A-Za-z_]\w*)\s*\(/g),
  ]
    .map((match) => match[1] ?? "")
    .filter((name) => {
      const simple = name.split("::").at(-1) ?? name;
      return !controlLikeCalls.has(simple) && !cppKeywords.has(simple);
    });
  const name = operator ?? destructor ?? normalCandidates[0];
  if (!name) return undefined;
  const simpleName = name.split("::").at(-1) ?? name;
  if (
    /^[A-Z][A-Z0-9_]*$/.test(simpleName) &&
    new RegExp(`^${simpleName}\\s*\\(`).test(compact)
  ) {
    return undefined;
  }
  const directClass = scope.kind === "class" ? scope.className : undefined;
  const kind =
    testHookNames.has(simpleName) && directClass && scope.testFixture
      ? "test_hook"
      : directClass || name.includes("::")
        ? "method"
        : "function";
  const displayName =
    directClass && !name.includes("::") ? `${directClass}::${name}` : name;
  return { name, displayName, kind };
}

/** Identifies the outer type introduced by a declaration header. */
function typeDeclarationIdentity(header: string) {
  const candidates = [
    ...header.matchAll(
      /\b(?:(enum)\s+(?:class\s+|struct\s+)?([A-Za-z_]\w*)|(class|struct|union)\s+([A-Za-z_]\w*))/g,
    ),
  ];
  let angleDepth = 0;
  let cursor = 0;
  for (const candidate of candidates) {
    const position = candidate.index ?? 0;
    for (; cursor < position; cursor += 1) {
      if (header[cursor] === "<") angleDepth += 1;
      else if (header[cursor] === ">") angleDepth = Math.max(0, angleDepth - 1);
    }
    if (angleDepth === 0) {
      return {
        keyword: candidate[1] ?? candidate[3],
        name: candidate[2] ?? candidate[4],
      };
    }
  }
  const anonymous = /\b(enum|struct|union)\s*$/.exec(header);
  return anonymous ? { keyword: anonymous[1], name: undefined } : undefined;
}

/** Extracts the declared name of an alias or concept statement. */
function aliasIdentity(statement: string) {
  const namespaceName = /\bnamespace\s+([A-Za-z_]\w*)\s*=/.exec(statement)?.[1];
  if (namespaceName) return namespaceName;
  const usingName = /\busing\s+([A-Za-z_]\w*)\s*=/.exec(statement)?.[1];
  if (usingName) return usingName;
  const conceptName = /\bconcept\s+([A-Za-z_]\w*)\s*=/.exec(statement)?.[1];
  if (conceptName) return conceptName;
  if (/\btypedef\b/.test(statement)) {
    return statement.match(/([A-Za-z_]\w*)\s*;\s*$/)?.[1];
  }
  return undefined;
}

/** Extracts variable and function-pointer names from a declaration. */
function variableNames(statement: string) {
  const withoutInitializer = statement.split(/[={]/, 1)[0] ?? statement;
  const functionPointer = /\(\s*[*&]\s*([A-Za-z_]\w*)\s*\)/.exec(
    withoutInitializer,
  )?.[1];
  if (functionPointer) return [functionPointer];
  const segments: string[] = [];
  let start = 0;
  let angle = 0;
  let parens = 0;
  let brackets = 0;
  for (let index = 0; index < withoutInitializer.length; index += 1) {
    const char = withoutInitializer[index];
    if (char === "<") angle += 1;
    else if (char === ">") angle = Math.max(0, angle - 1);
    else if (char === "(") parens += 1;
    else if (char === ")") parens = Math.max(0, parens - 1);
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets = Math.max(0, brackets - 1);
    else if (char === "," && angle === 0 && parens === 0 && brackets === 0) {
      segments.push(withoutInitializer.slice(start, index));
      start = index + 1;
    }
  }
  segments.push(withoutInitializer.slice(start));
  return segments.flatMap((segment) => {
    const last = /([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?$/.exec(
      segment.trim(),
    )?.[1];
    return last ? [last] : [];
  });
}

/** Distinguishes data declarations from expression-like statements. */
function isPlausibleVariable(statement: string) {
  const compact = statement.trim();
  if (
    !compact ||
    /^\s*(?:return|break|continue|goto|throw|static_assert|using\s+namespace|friend|export|import|module)\b/.test(
      compact,
    )
  )
    return false;
  if (/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*\s*\(/.test(compact)) return false;
  return (
    /[=[{]/.test(compact) ||
    /\b(?:extern|const|constexpr|constinit|static|thread_local|volatile|auto|unsigned|signed|short|long|char|int|float|double|bool)\b/.test(
      compact,
    ) ||
    /\b[A-Za-z_]\w*(?:::[A-Za-z_]\w*)?(?:\s*<[^;]+>)?\s+[*&]*\s*[A-Za-z_]\w*(?:\s*\[[^\]]*\])?\s*;?\s*$/.test(
      compact,
    )
  );
}

/** Classifies declared data as mutable state or a constant. */
function variableKind(statement: string, names: readonly string[]): UnitKind {
  const explicitlyConstant = /\b(?:constexpr|consteval|constinit)\b/.test(
    statement,
  );
  const immutableValue =
    /\bconst\b/.test(statement) && !/\bconst\b[^=;]*[*&]/.test(statement);
  return explicitlyConstant ||
    immutableValue ||
    names.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name))
    ? "constant"
    : "variable";
}

/** Extends a function-try-block through all of its adjacent catch handlers. */
function functionTryBlockEnd(
  tokens: readonly Token[],
  pairs: ReadonlyMap<number, number>,
  bodyClose: number,
  scopeEnd: number,
) {
  let end = bodyClose;
  while (tokens[end + 1]?.value === "catch") {
    let cursor = end + 2;
    let parens = 0;
    let handlerOpen: number | undefined;
    while (cursor < scopeEnd) {
      const value = tokens[cursor]?.value;
      if (value === "(") parens += 1;
      else if (value === ")") parens = Math.max(0, parens - 1);
      else if (value === "{" && parens === 0) {
        handlerOpen = cursor;
        break;
      }
      cursor += 1;
    }
    if (handlerOpen === undefined) break;
    const handlerClose = pairs.get(handlerOpen);
    if (handlerClose === undefined) break;
    end = handlerClose;
  }
  return end;
}

/** Builds the C++ units using a balanced-token scope walk. */
function analyzeCpp(file: SourceFile) {
  const directives = preprocessorRanges(file.content);
  const headerGuardNames = new Set(
    directives.flatMap((directive) => {
      const normalized = directive.source.replace(/\\\s*\r?\n/g, " ");
      const name =
        /^\s*#\s*ifndef\s+([A-Za-z_]\w*)/.exec(normalized)?.[1] ??
        /^\s*#\s*if\s+!\s*defined\s*\(?\s*([A-Za-z_]\w*)/.exec(normalized)?.[1];
      return name ? [name] : [];
    }),
  );
  const tokens = cppTokens(file.content, directives);
  const pairs = bracePairs(tokens);
  const pending: PendingUnit[] = [];
  let namespaceStatementIndex = 0;

  /** Adds a pending C++ unit with documentation and references attached. */
  const addUnit = (
    kind: UnitKind,
    displayName: string,
    stableName: string,
    range: SourceRange,
    ownNames: readonly string[],
    scope: Scope,
    directClass?: string,
  ) => {
    const reviewRange = {
      from: documentedStart(file.content, range.from),
      to: range.to,
    };
    const references = identifierReferences(
      file.content,
      reviewRange,
      ownNames,
    );
    pending.push({
      unit: makeUnit(
        file,
        CPP_LANGUAGE,
        kind,
        displayName,
        reviewRange,
        references.map((name) => `${file.path}:${name}`),
        complexity(file.content.slice(reviewRange.from, reviewRange.to)),
        stableName,
      ),
      stableName,
      simpleName: ownNames[0] ?? displayName,
      scopeName: scopeName(scope),
      references,
      directClass,
    });
  };

  /** Walks one balanced namespace or class scope for declarations. */
  const scanScope = (fromIndex: number, toIndex: number, scope: Scope) => {
    let index = fromIndex;
    while (index < toIndex) {
      const token = tokens[index];
      if (!token) break;
      if (token.value === ";") {
        index += 1;
        continue;
      }
      if (
        scope.kind === "class" &&
        ["public", "private", "protected"].includes(token.value) &&
        tokens[index + 1]?.value === ":"
      ) {
        index += 2;
        continue;
      }
      let cursor = index;
      let parens = 0;
      let brackets = 0;
      let boundary: number | undefined;
      while (cursor < toIndex) {
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
      const header = file.content.slice(token.from, boundaryToken.from);
      const maskedHeader = maskCppSource(header);
      if (boundaryToken.value === "{") {
        const namespace =
          /\bnamespace(?:\s+inline)?\s*([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)?\s*$/.exec(
            maskedHeader,
          );
        if (namespace) {
          const close = pairs.get(boundary);
          if (close === undefined) break;
          const namespaceParts = namespace[1]?.split("::") ?? ["<anonymous>"];
          scanScope(boundary + 1, close, {
            names: [...scope.names, ...namespaceParts],
            kind: "namespace",
          });
          index = close + 1;
          continue;
        }
        if (/^\s*extern\b/.test(maskedHeader)) {
          const close = pairs.get(boundary);
          if (close === undefined) break;
          scanScope(boundary + 1, close, scope);
          index = close + 1;
          continue;
        }
        const typeMatch = typeDeclarationIdentity(maskedHeader);
        if (typeMatch) {
          const keyword = typeMatch.keyword as
            | "class"
            | "struct"
            | "union"
            | "enum";
          const name =
            typeMatch.name ?? `<anonymous ${typeMatch.keyword ?? "type"}>`;
          const close = pairs.get(boundary);
          if (!name || close === undefined) {
            index += 1;
            continue;
          }
          let endIndex = close;
          if (tokens[endIndex + 1]?.value === ";") endIndex += 1;
          const stableName = qualify(scope, name);
          if (keyword === "enum") {
            addUnit(
              "class",
              name,
              stableName,
              {
                from: token.from,
                to:
                  tokens[endIndex]?.to ?? tokens[close]?.to ?? boundaryToken.to,
              },
              [name],
              scope,
              scope.kind === "class" ? scopeName(scope) : undefined,
            );
          } else {
            addUnit(
              "class",
              name,
              stableName,
              { from: token.from, to: boundaryToken.to },
              [name],
              scope,
              scope.kind === "class" ? scopeName(scope) : undefined,
            );
            scanScope(boundary + 1, close, {
              names: [...scope.names, name],
              kind: "class",
              className: name,
              testFixture:
                /:\s*(?:public\s+|protected\s+|private\s+)?(?:testing::)?Test\b/.test(
                  maskedHeader,
                ) ||
                (isTestLikePath(file.path) && /(?:Test|Fixture)$/.test(name)),
            });
          }
          index = endIndex + 1;
          continue;
        }
        const identity = functionIdentity(header, scope);
        if (identity) {
          let bodyOpen = boundary;
          let close = pairs.get(bodyOpen);
          while (
            close !== undefined &&
            [",", "{"].includes(tokens[close + 1]?.value ?? "")
          ) {
            const previousClose = close;
            const nextOpen = tokens.findIndex(
              (candidate, candidateIndex) =>
                candidateIndex > previousClose &&
                candidateIndex < toIndex &&
                candidate.value === "{",
            );
            if (nextOpen < 0) break;
            bodyOpen = nextOpen;
            close = pairs.get(bodyOpen);
          }
          if (close === undefined) break;
          close = functionTryBlockEnd(tokens, pairs, close, toIndex);
          const qualified = qualify(scope, identity.name);
          const stableName =
            identity.kind === "test"
              ? `test:${qualified}:${identity.name}`
              : qualified;
          addUnit(
            identity.kind,
            identity.displayName,
            stableName,
            { from: token.from, to: tokens[close]?.to ?? boundaryToken.to },
            [identity.name, identity.name.split("::").at(-1) ?? identity.name],
            scope,
            scope.kind === "class"
              ? scopeName(scope)
              : identity.kind === "method" && identity.name.includes("::")
                ? identity.name.slice(0, identity.name.lastIndexOf("::"))
                : undefined,
          );
          index = close + 1;
          if (tokens[index]?.value === ";") index += 1;
          continue;
        }
        const close = pairs.get(boundary);
        if (close === undefined) break;
        let endIndex = close;
        if (tokens[endIndex + 1]?.value === ";") endIndex += 1;
        const statement = file.content.slice(
          token.from,
          tokens[endIndex]?.to ?? boundaryToken.to,
        );
        const names = variableNames(
          maskCppSource(statement).replace(/;\s*$/, ""),
        );
        if (names.length && isPlausibleVariable(statement)) {
          const kind = variableKind(maskedHeader, names);
          const stableName = qualify(scope, names.join(","));
          const display = scope.className
            ? `${scope.className}::${names.join(", ")}`
            : names.join(", ");
          addUnit(
            kind,
            display,
            stableName,
            { from: token.from, to: tokens[endIndex]?.to ?? boundaryToken.to },
            names,
            scope,
            scope.kind === "class" ? scopeName(scope) : undefined,
          );
        }
        index = endIndex + 1;
        continue;
      }

      const end = boundaryToken.to;
      const statement = file.content.slice(token.from, end);
      const maskedStatement = maskCppSource(statement);
      const forwardType =
        /\b(class|struct|union|enum)\s+(?:class\s+|struct\s+)?([A-Za-z_]\w*)\s*;\s*$/.exec(
          maskedStatement,
        );
      if (forwardType) {
        const name = forwardType[2] ?? "anonymous";
        addUnit(
          "class",
          name,
          qualify(scope, name),
          { from: token.from, to: end },
          [name],
          scope,
          scope.kind === "class" ? scopeName(scope) : undefined,
        );
        index = boundary + 1;
        continue;
      }
      const alias = aliasIdentity(maskedStatement);
      if (alias) {
        addUnit(
          "variable",
          alias,
          qualify(scope, alias),
          { from: token.from, to: end },
          [alias],
          scope,
          scope.kind === "class" ? scopeName(scope) : undefined,
        );
        index = boundary + 1;
        continue;
      }
      const identity = functionIdentity(statement.replace(/;\s*$/, ""), scope);
      if (identity) {
        const qualified = qualify(scope, identity.name);
        addUnit(
          identity.kind,
          identity.displayName,
          qualified,
          { from: token.from, to: end },
          [identity.name, identity.name.split("::").at(-1) ?? identity.name],
          scope,
          scope.kind === "class"
            ? scopeName(scope)
            : identity.kind === "method" && identity.name.includes("::")
              ? identity.name.slice(0, identity.name.lastIndexOf("::"))
              : undefined,
        );
        index = boundary + 1;
        continue;
      }
      const names = variableNames(maskedStatement.replace(/;\s*$/, ""));
      if (names.length && isPlausibleVariable(maskedStatement)) {
        const kind = variableKind(maskedStatement, names);
        const stableName = qualify(scope, names.join(","));
        const display = scope.className
          ? `${scope.className}::${names.join(", ")}`
          : names.join(", ");
        addUnit(
          kind,
          display,
          stableName,
          { from: token.from, to: end },
          names,
          scope,
          scope.kind === "class" ? scopeName(scope) : undefined,
        );
      } else if (scope.kind === "namespace" && maskedStatement.trim()) {
        const name = `${scopeName(scope)} namespace statements`;
        addUnit(
          "module",
          name,
          `${scopeName(scope)}:<statements:${namespaceStatementIndex}>`,
          { from: token.from, to: end },
          [],
          scope,
        );
        namespaceStatementIndex += 1;
      }
      index = boundary + 1;
    }
  };

  scanScope(0, tokens.length, { names: [], kind: "file" });

  for (const directive of directives) {
    const macro =
      /^\s*#\s*define\s+([A-Za-z_]\w*)(\s*\([^\n]*?\))?\s*([\s\S]*)$/.exec(
        directive.source,
      );
    if (!macro) continue;
    const name = macro[1] ?? "";
    const parameters = macro[2];
    const replacement = (macro[3] ?? "").replace(/\\\s*\r?\n/g, " ").trim();
    const guardLike =
      !parameters &&
      (!replacement || replacement === "1") &&
      (headerGuardNames.has(name) ||
        /(?:_H|_HPP|_HH|_INCLUDED|_GUARD)$/.test(name));
    if (guardLike || (!parameters && !replacement)) continue;
    const range = { from: directive.from, to: directive.to };
    addUnit(parameters ? "function" : "constant", name, name, range, [name], {
      names: [],
      kind: "file",
    });
  }

  const byQualifiedName = new Map<string, PendingUnit[]>();
  const bySimpleName = new Map<string, PendingUnit[]>();
  for (const candidate of pending) {
    byQualifiedName.set(candidate.stableName, [
      ...(byQualifiedName.get(candidate.stableName) ?? []),
      candidate,
    ]);
    const simple =
      candidate.simpleName.split("::").at(-1) ?? candidate.simpleName;
    bySimpleName.set(simple, [...(bySimpleName.get(simple) ?? []), candidate]);
  }
  return pending.map((candidate) => {
    const dependencyKeys = new Set<string>();
    for (const reference of candidate.references) {
      const scoped = candidate.scopeName
        ? `${candidate.scopeName}::${reference}`
        : reference;
      const exact =
        byQualifiedName.get(reference) ?? byQualifiedName.get(scoped);
      const matches =
        exact ?? bySimpleName.get(reference.split("::").at(-1) ?? reference);
      const match = matches?.length === 1 ? matches[0] : undefined;
      if (match && match !== candidate)
        dependencyKeys.add(match.unit.stableKey);
    }
    if (candidate.unit.kind === "class") {
      for (const member of pending) {
        if (member === candidate || member.directClass !== candidate.stableName)
          continue;
        dependencyKeys.add(member.unit.stableKey);
      }
    }
    return { ...candidate.unit, dependencies: [...dependencyKeys] };
  });
}

/** C++ parser that emits review units aligned to language-level concepts. */
export const cppAdapter: LanguageAdapter = {
  language: CPP_LANGUAGE,
  extensions: supportedExtensions.cpp,
  isContextOnly: isCppContextOnly,
  analyze: analyzeCpp,
};

export const cppParserInternals = {
  analyzeCpp,
  isCppContextOnly,
  maskCppSource,
  preprocessorRanges,
};
