import type {
  AnalyzedUnit,
  LanguageAdapter,
  SourceFile,
  UnitKind,
} from "../../types";
import { supportedExtensions } from "../../types";
import { makeUnit } from "../shared";

type ReviewUnit = Omit<AnalyzedUnit, "depth" | "reviewOrder">;

interface Range {
  from: number;
  to: number;
}

interface TypeDeclaration extends Range {
  bodyFrom?: number;
  bodyTo?: number;
  keyword: string;
  name: string;
  fullName: string;
  parent?: TypeDeclaration;
  header: Range;
  testSuite: boolean;
}

interface PendingUnit {
  unit: ReviewUnit;
  referencedNames: string[];
  owner?: string;
  directOwner?: string;
}

const modifiers = new Set([
  "abstract",
  "async",
  "const",
  "extern",
  "file",
  "internal",
  "new",
  "override",
  "partial",
  "private",
  "protected",
  "public",
  "readonly",
  "required",
  "sealed",
  "static",
  "unsafe",
  "virtual",
  "volatile",
]);

const languageKeywords = new Set([
  ...modifiers,
  "add",
  "as",
  "ascending",
  "await",
  "base",
  "bool",
  "break",
  "by",
  "byte",
  "case",
  "catch",
  "char",
  "checked",
  "class",
  "continue",
  "decimal",
  "default",
  "delegate",
  "descending",
  "do",
  "double",
  "dynamic",
  "else",
  "enum",
  "equals",
  "event",
  "explicit",
  "false",
  "finally",
  "fixed",
  "float",
  "for",
  "foreach",
  "from",
  "get",
  "global",
  "goto",
  "group",
  "if",
  "implicit",
  "in",
  "init",
  "int",
  "interface",
  "into",
  "is",
  "join",
  "let",
  "lock",
  "long",
  "nameof",
  "namespace",
  "not",
  "null",
  "object",
  "on",
  "operator",
  "or",
  "orderby",
  "out",
  "params",
  "record",
  "ref",
  "remove",
  "return",
  "sbyte",
  "select",
  "set",
  "short",
  "sizeof",
  "stackalloc",
  "string",
  "struct",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "uint",
  "ulong",
  "unchecked",
  "unmanaged",
  "ushort",
  "using",
  "value",
  "var",
  "void",
  "when",
  "where",
  "while",
  "with",
  "yield",
]);

const testAttributes = new Set([
  "DataRow",
  "DataTestMethod",
  "Fact",
  "Test",
  "TestCase",
  "TestCaseSource",
  "TestMethod",
  "Theory",
]);

const lifecycleAttributes = new Set([
  "AssemblyCleanup",
  "AssemblyInitialize",
  "ClassCleanup",
  "ClassInitialize",
  "GlobalSetup",
  "GlobalTeardown",
  "OneTimeSetUp",
  "OneTimeTearDown",
  "SetUp",
  "SetUpFixture",
  "TearDown",
  "TestCleanup",
  "TestInitialize",
]);

/** Replaces comments and every C# string form with spaces while preserving offsets. */
function structuralSource(source: string) {
  const output = [...source];
  /** Blanks one lexical range without changing line or byte offsets. */
  const blank = (from: number, to: number) => {
    for (let index = from; index < to; index += 1) {
      if (source[index] !== "\n" && source[index] !== "\r") output[index] = " ";
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
    if (source[index] === "'") {
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === "\\") end += 2;
        else if (source[end++] === "'") break;
      }
      blank(index, end);
      index = end;
      continue;
    }
    if (source[index] === '"') {
      let quoteCount = 1;
      while (source[index + quoteCount] === '"') quoteCount += 1;
      const raw = quoteCount >= 3;
      const verbatim =
        !raw && (source[index - 1] === "@" || source[index - 2] === "@");
      let end = index + quoteCount;
      if (raw) {
        const terminator = '"'.repeat(quoteCount);
        const found = source.indexOf(terminator, end);
        end = found < 0 ? source.length : found + quoteCount;
      } else {
        while (end < source.length) {
          if (verbatim && source.startsWith('""', end)) {
            end += 2;
            continue;
          }
          if (!verbatim && source[end] === "\\") {
            end += 2;
            continue;
          }
          if (source[end++] === '"') break;
        }
      }
      blank(index, end);
      index = end;
      continue;
    }
    index += 1;
  }
  return output.join("");
}

/** Builds matching-delimiter maps over already-neutralized source. */
function delimiterPairs(source: string, open: string, close: string) {
  const stack: number[] = [];
  const pairs = new Map<number, number>();
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === open) stack.push(index);
    else if (source[index] === close) {
      const start = stack.pop();
      if (start !== undefined) pairs.set(start, index);
    }
  }
  return pairs;
}

/** Advances across whitespace up to an optional source boundary. */
function skipWhitespace(source: string, from: number, limit = source.length) {
  let index = from;
  while (index < limit && /\s/.test(source[index] ?? "")) index += 1;
  return index;
}

/** Returns the offset of the line containing a source position. */
function lineStart(source: string, offset: number) {
  return source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

/** Includes contiguous XML documentation and attributes in a declaration range. */
function declarationStart(source: string, structural: string, offset: number) {
  let start = lineStart(source, offset);
  let cursor = start;
  let sawMetadata = false;
  while (cursor > 0) {
    const previousEnd = cursor - 1;
    const previousStart = lineStart(source, previousEnd);
    const line = source.slice(previousStart, previousEnd).trim();
    if (!line) break;
    const metadataLine =
      line.startsWith("///") ||
      line.startsWith("/**") ||
      line.startsWith("*") ||
      line.endsWith("*/") ||
      line.startsWith("[") ||
      line.endsWith("]") ||
      (sawMetadata &&
        structural.slice(previousStart, previousEnd).trim() === "");
    if (!metadataLine) break;
    sawMetadata = true;
    start = previousStart;
    cursor = previousStart;
  }
  return start;
}

/** Finds the next top-level semicolon or body opener in a declaration header. */
function declarationTerminator(
  structural: string,
  from: number,
  limit: number,
  parens: ReadonlyMap<number, number>,
) {
  for (let index = from; index < limit; index += 1) {
    if (structural[index] === "(") {
      index = parens.get(index) ?? index;
      continue;
    }
    if (structural[index] === "{" || structural[index] === ";") return index;
  }
  return undefined;
}

/** Discovers class-like declarations, including nested and semicolon records. */
function findTypes(source: string, structural: string) {
  const braces = delimiterPairs(structural, "{", "}");
  const parens = delimiterPairs(structural, "(", ")");
  const declarations: TypeDeclaration[] = [];
  const pattern =
    /\b(record\s+(?:class|struct)|record|class|interface|struct|enum)\s+(@?[A-Za-z_]\w*)/g;
  for (
    let match = pattern.exec(structural);
    match;
    match = pattern.exec(structural)
  ) {
    const keyword = match[1] ?? "class";
    const name = (match[2] ?? "anonymous").replace(/^@/, "");
    const terminator = declarationTerminator(
      structural,
      match.index + match[0].length,
      structural.length,
      parens,
    );
    if (terminator === undefined) continue;
    const start = declarationStart(source, structural, match.index);
    if (structural[terminator] === "{") {
      const close = braces.get(terminator);
      if (close === undefined) continue;
      declarations.push({
        from: start,
        to: close + 1,
        bodyFrom: terminator,
        bodyTo: close,
        keyword,
        name,
        fullName: name,
        header: { from: start, to: terminator + 1 },
        testSuite: false,
      });
    } else {
      declarations.push({
        from: start,
        to: terminator + 1,
        keyword,
        name,
        fullName: name,
        header: { from: start, to: terminator + 1 },
        testSuite: false,
      });
    }
  }

  const delegatePattern =
    /\bdelegate\s+(?:[\w<>,.?\s:]|\[|\])+?\s+(@?[A-Za-z_]\w*)\s*(?:<[^;(){}]+>)?\s*\(/g;
  for (
    let match = delegatePattern.exec(structural);
    match;
    match = delegatePattern.exec(structural)
  ) {
    const name = (match[1] ?? "anonymous").replace(/^@/, "");
    const semicolon = structural.indexOf(";", match.index + match[0].length);
    if (semicolon < 0) continue;
    const start = declarationStart(source, structural, match.index);
    declarations.push({
      from: start,
      to: semicolon + 1,
      keyword: "delegate",
      name,
      fullName: name,
      header: { from: start, to: semicolon + 1 },
      testSuite: false,
    });
  }

  declarations.sort(
    (left, right) => left.from - right.from || right.to - left.to,
  );
  for (const declaration of declarations) {
    declaration.parent = declarations
      .filter(
        (candidate) =>
          candidate !== declaration &&
          candidate.bodyFrom !== undefined &&
          candidate.bodyTo !== undefined &&
          candidate.bodyFrom < declaration.from &&
          candidate.bodyTo > declaration.to,
      )
      .sort((left, right) => left.to - left.from - (right.to - right.from))[0];
    declaration.fullName = declaration.parent
      ? `${declaration.parent.fullName}.${declaration.name}`
      : declaration.name;
  }
  return declarations;
}

/** Splits the immediate body of a type into complete member declarations. */
function directMemberRanges(
  source: string,
  structural: string,
  type: TypeDeclaration,
  braces: ReadonlyMap<number, number>,
) {
  if (type.bodyFrom === undefined || type.bodyTo === undefined) return [];
  const ranges: Range[] = [];
  let start = type.bodyFrom + 1;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = start; index < type.bodyTo; index += 1) {
    const character = structural[index];
    if (character === "(") parenDepth += 1;
    else if (character === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (character === "{" && parenDepth === 0 && bracketDepth === 0) {
      const close = braces.get(index);
      if (close === undefined || close > type.bodyTo) continue;
      let end = close + 1;
      let next = skipWhitespace(structural, end, type.bodyTo);
      if (structural[next] === "=") {
        const semicolon = structural.indexOf(";", next + 1);
        if (semicolon >= 0 && semicolon < type.bodyTo) end = semicolon + 1;
      } else if (structural[next] === ";") {
        end = next + 1;
      }
      if (structural.slice(start, end).trim())
        ranges.push({ from: start, to: end });
      start = end;
      index = end - 1;
      next = end;
    } else if (character === ";" && parenDepth === 0 && bracketDepth === 0) {
      if (structural.slice(start, index + 1).trim()) {
        ranges.push({ from: start, to: index + 1 });
      }
      start = index + 1;
    }
  }
  return ranges.map((range) => ({
    from: skipWhitespace(source, range.from, range.to),
    to: range.to,
  }));
}

/** Returns normalized attribute names attached to a declaration. */
function attributeNames(source: string) {
  return [
    ...source.matchAll(/\[\s*(?:\w+\s*:\s*)?([A-Za-z_]\w*)(?:Attribute)?\b/g),
  ].map((match) => (match[1] ?? "").replace(/Attribute$/, ""));
}

/** Derives a framework-provided test title when one is statically available. */
function testLabel(source: string, fallback: string) {
  return (
    /\b(?:DisplayName|TestName)\s*=\s*"((?:\\.|[^"\\])*)"/.exec(source)?.[1] ??
    fallback
  );
}

/** Counts top-level parameters for overload-stable callable identities. */
function parameterArity(signature: string) {
  const open = signature.lastIndexOf("(");
  if (open < 0) return 0;
  let depth = 0;
  let commas = 0;
  const body = signature.slice(open + 1, signature.lastIndexOf(")"));
  if (!body.trim()) return 0;
  for (const character of body) {
    if ("(<[".includes(character)) depth += 1;
    else if (")>]".includes(character)) depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) commas += 1;
  }
  return commas + 1;
}

/** Produces a compact type-oriented identity that distinguishes overloads. */
function parameterIdentity(signature: string) {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  if (open < 0 || close <= open) return "";
  const body = signature.slice(open + 1, close);
  const parameters: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index <= body.length; index += 1) {
    const character = body[index];
    if ("(<[{".includes(character ?? "")) depth += 1;
    else if (")>]}".includes(character ?? "")) depth = Math.max(0, depth - 1);
    if ((character === "," && depth === 0) || index === body.length) {
      const parameter = body
        .slice(start, index)
        .replace(/^\s*(?:\[[\s\S]*?\]\s*)+/, "")
        .split(/(?<![=!<>])=(?!=|>)/, 1)[0]
        ?.trim()
        .replace(/\b(?:this|scoped|ref|out|in|params)\s+/g, "")
        .replace(/\s+@?[A-Za-z_]\w*\s*$/, "")
        .replace(/\s+/g, "");
      if (parameter) parameters.push(parameter);
      start = index + 1;
    }
  }
  return parameters.join(",");
}

/** Estimates branch complexity for review ordering. */
function complexityOf(source: string) {
  return (
    1 +
    (source.match(
      /\b(?:if|else\s+if|for|foreach|while|case|catch|when)\b|&&|\|\||\?\?/g,
    )?.length ?? 0)
  );
}

/** Extracts useful identifier and qualified-member references from C# source. */
function referencedNames(source: string, ownNames: readonly string[]) {
  const structural = structuralSource(source);
  const own = new Set(ownNames);
  const found = new Set<string>();
  for (const match of structural.matchAll(
    /@?[A-Za-z_]\w*(?:\s*\.\s*@?[A-Za-z_]\w*)*/g,
  )) {
    const name = (match[0] ?? "").replace(/\s+/g, "").replaceAll("@", "");
    const simple = name.split(".").at(-1) ?? name;
    if (
      !name ||
      languageKeywords.has(name) ||
      languageKeywords.has(simple) ||
      own.has(name)
    ) {
      continue;
    }
    found.add(name);
    if (name.includes(".")) found.add(name.split(".")[0] ?? name);
  }
  return [...found];
}

/** Removes leading comments and attributes for member-shape classification. */
function memberCore(source: string) {
  return source
    .replace(/^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)+/, "")
    .replace(/^\s*(?:\[[\s\S]*?\]\s*)+/, "")
    .trim();
}

interface MemberIdentity {
  name: string;
  stableName: string;
  kind: UnitKind;
  testLabel?: string;
}

/** Classifies one direct class-body segment without inspecting nested bodies. */
function classifyMember(
  type: TypeDeclaration,
  source: string,
): MemberIdentity | undefined {
  const core = memberCore(source);
  if (!core || /^#/.test(core)) return undefined;
  const attributes = new Set(attributeNames(source));
  const header = core.split(/=>|\{|;/, 1)[0]?.trim() ?? core;
  const finalParen = header.lastIndexOf(")");
  if (finalParen >= 0) {
    let depth = 0;
    let open = -1;
    for (let index = finalParen; index >= 0; index -= 1) {
      if (header[index] === ")") depth += 1;
      else if (header[index] === "(" && --depth === 0) {
        open = index;
        break;
      }
    }
    if (open >= 0) {
      const prefix = header.slice(0, open).trim();
      if (!/(?:^|[^=!<>])=(?!=|>)/.test(prefix)) {
        const operator =
          /\b(?:(implicit|explicit)\s+)?operator\s+([^\s(]+)\s*$/.exec(prefix);
        const destructor = /~\s*(@?[A-Za-z_]\w*)\s*$/.exec(prefix);
        const normal = /(@?[A-Za-z_]\w*)\s*(?:<[^<>]*>)?\s*$/.exec(prefix);
        const rawName = operator
          ? `${operator[1] ? `${operator[1]} ` : ""}operator ${operator[2]}`
          : destructor
            ? `~${destructor[1]}`
            : normal?.[1]?.replace(/^@/, "");
        if (rawName) {
          const arity = parameterArity(header.slice(open, finalParen + 1));
          const parameterTypes = parameterIdentity(
            header.slice(open, finalParen + 1),
          );
          const isConstructor = rawName === type.name;
          const lifecycle =
            [...attributes].some((attribute) =>
              lifecycleAttributes.has(attribute),
            ) ||
            (type.testSuite &&
              (isConstructor ||
                ["Dispose", "DisposeAsync", "InitializeAsync"].includes(
                  rawName,
                )));
          const isTest = [...attributes].some((attribute) =>
            testAttributes.has(attribute),
          );
          const kind: UnitKind = isTest
            ? "test"
            : lifecycle
              ? "test_hook"
              : "method";
          return {
            name: rawName,
            stableName: `${type.fullName}.${isConstructor ? ".ctor" : rawName}/${arity}:${parameterTypes}`,
            kind,
            testLabel: isTest ? testLabel(source, rawName) : undefined,
          };
        }
      }
    }
  }

  const propertyBody =
    core.includes("{") && /\b(?:get|set|init|add|remove)\s*[;{]/.test(core);
  if (propertyBody || /=>/.test(core)) {
    const before = core.split(/=>|\{/, 1)[0] ?? "";
    const indexer = /\bthis\s*\[/.test(before);
    const name = indexer
      ? "this[]"
      : /(@?[A-Za-z_]\w*)\s*$/.exec(before)?.[1]?.replace(/^@/, "");
    if (name) {
      return {
        name,
        stableName: `${type.fullName}.${name}`,
        kind: "variable",
      };
    }
  }

  if (core.endsWith(";")) {
    const declaration = core.slice(0, -1);
    const beforeInitializer =
      declaration.split(/(?<![=!<>])=(?!=|>)/, 1)[0] ?? declaration;
    const names = [
      ...beforeInitializer.matchAll(/@?([A-Za-z_]\w*)\s*(?=,|$)/g),
    ].map((match) => match[1] ?? "");
    const name = names.at(-1);
    if (name && !["using", "return", "throw"].includes(name)) {
      return {
        name: names.join(", "),
        stableName: `${type.fullName}.${names.join("+")}`,
        kind: /\bconst\b/.test(core) ? "constant" : "variable",
      };
    }
  }
  return undefined;
}

/** Locates block and file-scoped namespace wrappers. */
function namespaceDeclarations(source: string, structural: string) {
  const braces = delimiterPairs(structural, "{", "}");
  const result: Array<Range & { name: string; fullRange: Range }> = [];
  for (const match of structural.matchAll(
    /\bnamespace\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*([;{])/g,
  )) {
    const name = match[1] ?? "namespace";
    const terminator = (match.index ?? 0) + (match[0]?.length ?? 0) - 1;
    const start = declarationStart(source, structural, match.index ?? 0);
    if (match[2] === "{") {
      const close = braces.get(terminator);
      if (close === undefined) continue;
      result.push({
        from: start,
        to: terminator + 1,
        name,
        fullRange: { from: start, to: close + 1 },
      });
    } else {
      result.push({
        from: start,
        to: terminator + 1,
        name,
        fullRange: { from: start, to: structural.length },
      });
    }
  }
  return result;
}

/** Treats imports and namespace wrappers as contextual C# scaffolding. */
function isCsharpContextOnly(source: string) {
  const structural = structuralSource(source)
    .replace(/^\s*(?:global\s+)?using\b[\s\S]*?;\s*$/gm, "")
    .replace(/^\s*extern\s+alias\b[^;]*;\s*$/gm, "")
    .replace(/\bnamespace\s+[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*[;{]/g, "")
    .replace(/[{}]/g, "")
    .replace(/^\s*#(?:nullable|pragma)\b[^\n]*$/gm, "");
  return structural.trim().length === 0;
}

/** Creates one constant unit for every direct enum member. */
function enumMemberUnits(file: SourceFile, type: TypeDeclaration) {
  if (
    type.keyword !== "enum" ||
    type.bodyFrom === undefined ||
    type.bodyTo === undefined
  ) {
    return [];
  }
  const body = file.content.slice(type.bodyFrom + 1, type.bodyTo);
  const structural = structuralSource(body);
  const units: PendingUnit[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index <= structural.length; index += 1) {
    const character = structural[index];
    if ("([{<".includes(character ?? "")) depth += 1;
    else if (")]}>".includes(character ?? "")) depth = Math.max(0, depth - 1);
    if ((character === "," && depth === 0) || index === structural.length) {
      const raw = body.slice(start, index);
      const name = /(?:^|\s)(@?[A-Za-z_]\w*)\s*(?:=|$)/
        .exec(memberCore(raw))?.[1]
        ?.replace(/^@/, "");
      if (name) {
        const from = type.bodyFrom + 1 + start;
        const to = type.bodyFrom + 1 + index + (character === "," ? 1 : 0);
        units.push({
          unit: makeUnit(
            file,
            "csharp",
            "constant",
            `${type.name}.${name}`,
            { from, to },
            [],
            1,
            `${type.fullName}.${name}`,
          ),
          referencedNames: referencedNames(raw, [name]),
          owner: type.fullName,
          directOwner: type.fullName,
        });
      }
      start = index + 1;
    }
  }
  return units;
}

/** Preserves executable top-level program statements while excluding context. */
function topLevelStatementUnits(
  file: SourceFile,
  structural: string,
  types: readonly TypeDeclaration[],
  namespaces: ReturnType<typeof namespaceDeclarations>,
) {
  const lines = file.content.split("\n");
  const covered = new Array<boolean>(lines.length).fill(false);
  /** Maps a byte offset to its zero-based source line. */
  const lineAt = (offset: number) =>
    structural.slice(0, offset).split("\n").length - 1;
  /** Marks a source range as owned by structural context or a declaration. */
  const cover = (range: Range) => {
    for (let line = lineAt(range.from); line <= lineAt(range.to); line += 1)
      covered[line] = true;
  };
  for (const type of types.filter(({ parent }) => !parent)) cover(type);
  for (const namespace of namespaces) cover(namespace.fullRange);
  for (const match of structural.matchAll(
    /^\s*(?:global\s+)?using\b[\s\S]*?;\s*$/gm,
  )) {
    cover({
      from: match.index ?? 0,
      to: (match.index ?? 0) + (match[0]?.length ?? 0),
    });
  }
  const units: PendingUnit[] = [];
  let start: number | undefined;
  for (let line = 0; line <= lines.length; line += 1) {
    const reviewable =
      line < lines.length &&
      !covered[line] &&
      Boolean(structural.split("\n")[line]?.trim());
    if (reviewable) start ??= line;
    else if (start !== undefined) {
      const from =
        lines.slice(0, start).join("\n").length + (start > 0 ? 1 : 0);
      const text = lines.slice(start, line).join("\n");
      const to = from + text.length;
      units.push({
        unit: makeUnit(
          file,
          "csharp",
          "module",
          "Top-level statements",
          { from, to },
          [],
          complexityOf(text),
          `<top-level:${start}>`,
        ),
        referencedNames: referencedNames(text, []),
      });
      start = undefined;
    }
  }
  return units;
}

/** Resolves same-file references and makes structural shells depend on direct children. */
function resolveDependencies(pending: PendingUnit[]) {
  const bySimpleName = new Map<string, ReviewUnit[]>();
  const byQualifiedName = new Map<string, ReviewUnit>();
  for (const { unit } of pending) {
    const stableName = unit.stableKey.slice(
      `${unit.path}:${unit.kind}:`.length,
    );
    byQualifiedName.set(stableName.replace(/\/\d+:[^#]*(?:#\d+)?$/, ""), unit);
    const simple = unit.name
      .split(" › ")
      .at(-1)
      ?.split(".")
      .at(-1)
      ?.split(",")[0]
      ?.trim();
    if (simple)
      bySimpleName.set(simple, [...(bySimpleName.get(simple) ?? []), unit]);
  }
  return pending.map(({ unit, referencedNames, owner }) => {
    const resolved = new Set(unit.dependencies);
    for (const reference of referencedNames) {
      const simple = reference.split(".").at(-1) ?? reference;
      const owned = owner
        ? byQualifiedName.get(`${owner}.${simple}`)
        : undefined;
      const qualified = byQualifiedName.get(reference);
      const unique = bySimpleName.get(simple);
      const dependency =
        owned ?? qualified ?? (unique?.length === 1 ? unique[0] : undefined);
      if (dependency && dependency.stableKey !== unit.stableKey)
        resolved.add(dependency.stableKey);
      else if (!languageKeywords.has(simple))
        resolved.add(`${unit.path}:${reference}`);
    }
    for (const candidate of pending) {
      if (candidate.directOwner === unit.stableKey)
        resolved.add(candidate.unit.stableKey);
    }
    return { ...unit, dependencies: [...resolved] };
  });
}

/** A dependency-aware C# parser designed around human-sized review units. */
export const csharpAdapter: LanguageAdapter = {
  language: "csharp",
  extensions: supportedExtensions.csharp,
  isContextOnly: isCsharpContextOnly,
  analyze(file: SourceFile) {
    const structural = structuralSource(file.content);
    const braces = delimiterPairs(structural, "{", "}");
    const types = findTypes(file.content, structural);
    const namespaces = namespaceDeclarations(file.content, structural);
    for (const type of types) {
      const header = file.content.slice(type.header.from, type.header.to);
      const attributes = attributeNames(header);
      type.testSuite =
        attributes.some((attribute) =>
          ["TestClass", "TestFixture"].includes(attribute),
        ) ||
        (/Tests?$/.test(type.name) &&
          /(?:^|[/\\])(?:tests?|specs?)(?:[/\\]|$)|(?:Tests?|Specs?)\.cs$/i.test(
            file.path,
          ));
    }

    const pending: PendingUnit[] = [];
    for (const type of types) {
      const kind: UnitKind = type.testSuite ? "test_suite" : "class";
      const shell = makeUnit(
        file,
        "csharp",
        kind,
        type.name,
        type.header,
        referencedNames(file.content.slice(type.header.from, type.header.to), [
          type.name,
        ]).map((name) => `${file.path}:${name}`),
        1,
        type.fullName,
      );
      pending.push({
        unit: shell,
        referencedNames: [],
        owner: type.parent?.fullName,
        directOwner: type.parent?.fullName,
      });

      pending.push(...enumMemberUnits(file, type));
      if (
        type.keyword === "enum" ||
        type.bodyFrom === undefined ||
        type.bodyTo === undefined
      ) {
        continue;
      }
      const nestedRanges = types.filter(({ parent }) => parent === type);
      for (const range of directMemberRanges(
        file.content,
        structural,
        type,
        braces,
      )) {
        if (
          nestedRanges.some(
            (nested) => range.from <= nested.from && range.to >= nested.to,
          )
        ) {
          continue;
        }
        const source = file.content.slice(range.from, range.to);
        const identity = classifyMember(type, source);
        if (!identity) continue;
        const displayName = identity.testLabel
          ? `${type.name} › ${identity.testLabel}`
          : identity.kind === "variable" || identity.kind === "constant"
            ? `${type.name}.${identity.name}`
            : identity.name;
        pending.push({
          unit: makeUnit(
            file,
            "csharp",
            identity.kind,
            displayName,
            range,
            [],
            complexityOf(source),
            identity.stableName,
          ),
          referencedNames: referencedNames(source, [type.name, identity.name]),
          owner: type.fullName,
          directOwner: type.fullName,
        });
      }
    }

    pending.push(
      ...topLevelStatementUnits(file, structural, types, namespaces),
    );
    for (const type of types) {
      const shell = pending.find(
        ({ unit }) =>
          unit.stableKey.endsWith(`:${type.fullName}`) &&
          (unit.kind === "class" || unit.kind === "test_suite"),
      );
      if (!shell) continue;
      for (const candidate of pending) {
        if (candidate.directOwner === type.fullName)
          candidate.directOwner = shell.unit.stableKey;
      }
    }
    return resolveDependencies(pending);
  },
};
