import type {
  AnalyzedUnit,
  LanguageAdapter,
  SourceFile,
  UnitKind,
} from "../../types";
import { supportedExtensions } from "../../types";
import { makeUnit, type SourceRange } from "../shared";

const RUST_LANGUAGE = "rust" as const;

interface Token {
  value: string;
  from: number;
  to: number;
}

interface Scope {
  names: string[];
  kind: "file" | "module" | "type" | "trait" | "impl" | "extern";
  stableName?: string;
  displayName?: string;
  testModule: boolean;
  macroTests?: boolean;
}

interface PendingUnit {
  unit: Omit<AnalyzedUnit, "depth" | "reviewOrder">;
  stableName: string;
  simpleNames: string[];
  references: string[];
  scopeNames: string[];
  directOwner?: string;
}

const rustKeywords = new Set([
  "Self",
  "abstract",
  "as",
  "async",
  "await",
  "become",
  "box",
  "break",
  "const",
  "continue",
  "crate",
  "do",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "final",
  "fn",
  "for",
  "gen",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "macro",
  "match",
  "mod",
  "move",
  "mut",
  "override",
  "priv",
  "pub",
  "ref",
  "return",
  "self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "try",
  "type",
  "typeof",
  "union",
  "unsafe",
  "unsized",
  "use",
  "virtual",
  "where",
  "while",
  "yield",
]);

/** Masks nested comments and Rust literals while preserving source offsets. */
function maskRustSource(source: string) {
  const masked = [...source];
  /** Blanks a Rust literal range without changing source offsets. */
  const blank = (from: number, to: number) => {
    for (let cursor = from; cursor < to; cursor += 1) {
      if (masked[cursor] !== "\n" && masked[cursor] !== "\r")
        masked[cursor] = " ";
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
      let depth = 1;
      let end = index + 2;
      while (end < source.length && depth > 0) {
        if (source.startsWith("/*", end)) {
          depth += 1;
          end += 2;
        } else if (source.startsWith("*/", end)) {
          depth -= 1;
          end += 2;
        } else {
          end += 1;
        }
      }
      blank(index, end);
      index = end;
      continue;
    }
    const raw = /^(?:br|rb|r)(#{0,255})"/.exec(source.slice(index));
    if (raw) {
      const hashes = raw[1] ?? "";
      const terminator = `"${hashes}`;
      const close = source.indexOf(terminator, index + raw[0].length);
      const end = close < 0 ? source.length : close + terminator.length;
      blank(index, end);
      index = end;
      continue;
    }
    const string = /^(?:b|c)?"/.exec(source.slice(index));
    if (string) {
      let end = index + string[0].length;
      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        end += 1;
        if (source[end - 1] === '"') break;
      }
      blank(index, end);
      index = end;
      continue;
    }
    const character = /^(?:b)?'(?:\\.|[^'\\\r\n])'/.exec(source.slice(index));
    if (character) {
      blank(index, index + character[0].length);
      index += character[0].length;
      continue;
    }
    index += 1;
  }
  return masked.join("");
}

/** Tokenizes structural Rust syntax after masking literals and comments. */
function rustTokens(source: string) {
  const tokens: Token[] = [];
  const expression =
    /::|->|=>|\.\.=|\.\.|&&|\|\||==|!=|<=|>=|<<=|>>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<|>>|[A-Za-z_]\w*|\$[A-Za-z_]\w*|'[A-Za-z_]\w*|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[A-Za-z_]*|[{}()[\];,=<>*&:+\-/%!?.|^~#]/g;
  for (const match of maskRustSource(source).matchAll(expression)) {
    if (match.index === undefined) continue;
    tokens.push({
      value: match[0],
      from: match.index,
      to: match.index + match[0].length,
    });
  }
  return tokens;
}

/** Builds bidirectional delimiter-pair indexes. */
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

/** Finds the start offset of the line containing an offset. */
function lineStart(source: string, offset: number) {
  return source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

/** Includes contiguous rustdoc and attributes with their declaration. */
function attachedStart(source: string, declarationStart: number) {
  const original = lineStart(source, declarationStart);
  let start = original;
  let changed = true;
  while (changed && start > 0) {
    changed = false;
    const before = source.slice(0, start);
    const trimmed = before.replace(/[ \t\r\n]+$/, "");
    if (trimmed.endsWith("*/")) {
      const commentStart = trimmed.lastIndexOf("/*");
      if (commentStart >= 0 && /^\/\*[*!]/.test(trimmed.slice(commentStart))) {
        start = lineStart(source, commentStart);
        changed = true;
        continue;
      }
    }
    if (trimmed.endsWith("]")) {
      const attributeStart = Math.max(
        trimmed.lastIndexOf("#["),
        trimmed.lastIndexOf("#!["),
      );
      if (
        attributeStart >= 0 &&
        !/\n\s*[^#\s]/.test(trimmed.slice(attributeStart))
      ) {
        start = lineStart(source, attributeStart);
        changed = true;
        continue;
      }
    }
    const previousEnd = start - 1;
    const previousStart = source.lastIndexOf("\n", previousEnd - 1) + 1;
    if (/^\s*\/\/[!/]/.test(source.slice(previousStart, previousEnd + 1))) {
      start = previousStart;
      changed = true;
    }
  }
  return start;
}

/** Normalizes structural Rust source for declaration matching. */
function normalized(value: string) {
  return maskRustSource(value).replace(/\s+/g, " ").trim();
}

/** Formats a Rust scope as a module-qualified path. */
function scopeName(scope: Scope) {
  return scope.names.join("::");
}

/** Qualifies a declaration within its Rust scope. */
function qualify(scope: Scope, name: string) {
  return scope.names.length ? `${scopeName(scope)}::${name}` : name;
}

/** Estimates Rust review complexity from branching constructs. */
function complexity(source: string) {
  const masked = maskRustSource(source);
  return (
    1 +
    (masked.match(/\b(?:if|for|while|loop|match|await)\b|&&|\|\||\?(?![?])/g)
      ?.length ?? 0)
  );
}

/** Collects possible same-file Rust declaration references. */
function references(
  source: string,
  range: SourceRange,
  ownNames: readonly string[],
) {
  const found = new Set<string>();
  const own = new Set(ownNames);
  const masked = maskRustSource(source.slice(range.from, range.to));
  for (const match of masked.matchAll(/\b[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*\b/g)) {
    const value = match[0];
    const simple = value.split("::").at(-1) ?? value;
    if (
      !rustKeywords.has(value) &&
      !rustKeywords.has(simple) &&
      !own.has(value) &&
      !own.has(simple)
    ) {
      found.add(value);
    }
  }
  return [...found];
}

/** Splits a Rust list without crossing nested delimiters. */
function splitTopLevel(value: string, delimiter = ",") {
  const masked = maskRustSource(value);
  const ranges: Array<{ value: string; from: number; to: number }> = [];
  let start = 0;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let angles = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index];
    if (character === "(") parens += 1;
    else if (character === ")") parens = Math.max(0, parens - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (character === "{") braces += 1;
    else if (character === "}") braces = Math.max(0, braces - 1);
    else if (character === "<") angles += 1;
    else if (character === ">") angles = Math.max(0, angles - 1);
    else if (
      character === delimiter &&
      parens === 0 &&
      brackets === 0 &&
      braces === 0 &&
      angles === 0
    ) {
      ranges.push({ value: value.slice(start, index), from: start, to: index });
      start = index + 1;
    }
  }
  ranges.push({ value: value.slice(start), from: start, to: value.length });
  return ranges;
}

/** Classifies attributed and macro-contained Rust tests. */
function testKind(
  source: string,
  attachedFrom: number,
  declarationFrom: number,
  scope: Scope,
): UnitKind {
  const prefix = source.slice(attachedFrom, declarationFrom);
  if (
    /^\s*#\s*\[\s*(?:test|(?:tokio|async_std|actix_rt)::test|rstest|proptest|quickcheck)(?:\s*\([^\]]*\))?\s*\]/m.test(
      prefix,
    )
  ) {
    return "test";
  }
  return scope.macroTests ? "test" : "function";
}

/** Derives stable and display identities for an impl block. */
function implIdentity(header: string) {
  const compact = normalized(header)
    .replace(
      /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:default\s+)?(?:unsafe\s+)?impl\b\s*/,
      "",
    )
    .replace(/\s*\{$/, "")
    .trim();
  const beforeWhere = compact.split(/\s+where\s+/, 1)[0] ?? compact;
  const traitFor = /(?:^|>\s+)(.+?)\s+for\s+(.+)$/.exec(beforeWhere);
  const target = (traitFor?.[2] ?? beforeWhere)
    .replace(/^<[^>]*>\s*/, "")
    .trim();
  const traitName = traitFor?.[1]?.replace(/^<[^>]*>\s*/, "").trim();
  return {
    stable: `impl${compact.startsWith("<") ? "" : " "}${compact}`,
    display: traitName ? `impl ${traitName} for ${target}` : `impl ${target}`,
    target,
  };
}

/** Extracts a path-qualified Rust macro invocation name. */
function macroInvocation(header: string) {
  return /\b([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*!\s*$/.exec(
    normalized(header),
  )?.[1];
}

/** Recognizes crate-level declarations that are useful context but not review units. */
function isRustContextOnly(source: string) {
  let remaining = maskRustSource(source);
  let previous = "";
  while (remaining !== previous) {
    previous = remaining;
    remaining = remaining
      .replace(/^\s*#!?\[[\s\S]*?\]\s*/, "")
      .replace(/^\s*(?:pub(?:\s*\([^)]*\))?\s+)?use\b[\s\S]*?;\s*/, "")
      .replace(
        /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?extern\s+crate\b[\s\S]*?;\s*/,
        "",
      )
      .replace(/^\s*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+[A-Za-z_]\w*\s*;\s*/, "");
  }
  return remaining.trim().length === 0;
}

/** Builds Rust review units with explicit module, type, trait, and impl hierarchy. */
function analyzeRust(file: SourceFile) {
  const source = file.content;
  const tokens = rustTokens(source);
  const braces = paired(tokens, "{", "}");
  const pending: PendingUnit[] = [];

  /** Adds a documented Rust unit with inferred references. */
  const addUnit = (
    kind: UnitKind,
    displayName: string,
    stableName: string,
    range: SourceRange,
    ownNames: string[],
    scope: Scope,
    directOwner?: string,
  ) => {
    const reviewRange = {
      from: attachedStart(source, range.from),
      to: range.to,
    };
    const unitReferences = references(source, reviewRange, ownNames);
    pending.push({
      unit: makeUnit(
        file,
        RUST_LANGUAGE,
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
      scopeNames: scope.names,
      directOwner,
    });
  };

  /** Extracts named local closures as independently reviewable units. */
  const addClosureUnits = (
    bodyRange: SourceRange,
    parentDisplay: string,
    parentStable: string,
    scope: Scope,
  ) => {
    const body = source.slice(bodyRange.from, bodyRange.to);
    const masked = maskRustSource(body);
    const pattern =
      /\blet\s+(?:mut\s+)?([A-Za-z_]\w*)(?:\s*:[^=;]+)?\s*=\s*(?:move\s+)?(?:async\s+)?\|/g;
    for (const match of masked.matchAll(pattern)) {
      if (match.index === undefined || !match[1]) continue;
      const from = bodyRange.from + match.index;
      let cursor = match.index + match[0].length;
      let parens = 0;
      let brackets = 0;
      let bracesDepth = 0;
      while (cursor < masked.length) {
        const character = masked[cursor];
        if (character === "(") parens += 1;
        else if (character === ")") parens = Math.max(0, parens - 1);
        else if (character === "[") brackets += 1;
        else if (character === "]") brackets = Math.max(0, brackets - 1);
        else if (character === "{") bracesDepth += 1;
        else if (character === "}") {
          if (bracesDepth === 0) break;
          bracesDepth -= 1;
        } else if (
          character === ";" &&
          parens === 0 &&
          brackets === 0 &&
          bracesDepth === 0
        ) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      const closureName = match[1];
      addUnit(
        "function",
        `${parentDisplay}::${closureName}`,
        `${parentStable}::closure:${closureName}`,
        { from, to: bodyRange.from + cursor },
        [closureName],
        scope,
        parentStable,
      );
    }
  };

  /** Extracts named or tuple fields from a Rust type body. */
  const addFields = (
    owner: string,
    openIndex: number,
    closeIndex: number,
    scope: Scope,
    tuple: boolean,
  ) => {
    const from = tokens[openIndex]?.to ?? 0;
    const to = tokens[closeIndex]?.from ?? from;
    for (const [position, part] of splitTopLevel(
      source.slice(from, to),
    ).entries()) {
      const plain = normalized(part.value).replace(
        /^(?:#\s*!?\s*\[[^\]]*\]\s*)+/,
        "",
      );
      if (!plain) continue;
      const field = tuple
        ? position.toString()
        : /(?:pub(?:\s*\([^)]*\))?\s+)?([A-Za-z_]\w*)\s*:/.exec(plain)?.[1];
      if (!field) continue;
      const leading = part.value.search(/\S/);
      const trailing = part.value.match(/\s*$/)?.[0].length ?? 0;
      addUnit(
        "variable",
        `${owner}.${field}`,
        `${owner}.${field}`,
        {
          from: from + part.from + Math.max(0, leading),
          to: from + part.to - trailing,
        },
        [field],
        scope,
        owner,
      );
    }
  };

  /** Recursively scans declarations within one Rust lexical scope. */
  const scanScope = (fromIndex: number, toIndex: number, scope: Scope) => {
    let index = fromIndex;
    while (index < toIndex) {
      while ([";", ","].includes(tokens[index]?.value ?? "")) index += 1;
      const start = tokens[index];
      if (!start || index >= toIndex) break;
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
      const header = source.slice(start.from, boundaryToken.from);
      const compact = normalized(header);

      if (boundaryToken.value === "{") {
        const close = braces.get(boundary);
        if (close === undefined) break;
        const end = tokens[close]?.to ?? boundaryToken.to;
        const moduleName = /\bmod\s+([A-Za-z_]\w*)\s*$/.exec(compact)?.[1];
        if (moduleName) {
          const stable = qualify(scope, moduleName);
          addUnit(
            "module",
            moduleName,
            stable,
            { from: start.from, to: boundaryToken.to },
            [moduleName],
            scope,
            scope.stableName,
          );
          scanScope(boundary + 1, close, {
            names: [...scope.names, moduleName],
            kind: "module",
            stableName: stable,
            displayName: moduleName,
            testModule:
              scope.testModule ||
              /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/.test(
                source.slice(attachedStart(source, start.from), start.from),
              ) ||
              /tests?/.test(moduleName),
          });
          index = close + 1;
          continue;
        }

        const typeMatch = /\b(struct|union|enum)\s+([A-Za-z_]\w*)/.exec(
          compact,
        );
        if (typeMatch?.[1] && typeMatch[2]) {
          const typeName = typeMatch[2];
          const stable = qualify(scope, typeName);
          addUnit(
            "class",
            typeName,
            stable,
            { from: start.from, to: boundaryToken.to },
            [typeName],
            scope,
            scope.stableName,
          );
          if (typeMatch[1] === "enum") {
            const bodyFrom = boundaryToken.to;
            const bodyTo = tokens[close]?.from ?? bodyFrom;
            for (const part of splitTopLevel(source.slice(bodyFrom, bodyTo))) {
              const variant = /^\s*([A-Za-z_]\w*)/.exec(
                normalized(part.value),
              )?.[1];
              if (!variant) continue;
              const leading = part.value.search(/\S/);
              const trailing = part.value.match(/\s*$/)?.[0].length ?? 0;
              addUnit(
                "constant",
                `${typeName}::${variant}`,
                `${stable}::${variant}`,
                {
                  from: bodyFrom + part.from + Math.max(0, leading),
                  to: bodyFrom + part.to - trailing,
                },
                [variant],
                scope,
                stable,
              );
            }
          } else {
            addFields(stable, boundary, close, scope, false);
          }
          index = close + 1;
          continue;
        }

        const traitMatch = /\btrait\s+([A-Za-z_]\w*)/.exec(compact);
        if (traitMatch?.[1]) {
          const traitName = traitMatch[1];
          const stable = qualify(scope, traitName);
          addUnit(
            "class",
            traitName,
            stable,
            { from: start.from, to: boundaryToken.to },
            [traitName],
            scope,
            scope.stableName,
          );
          scanScope(boundary + 1, close, {
            ...scope,
            names: [...scope.names, traitName],
            kind: "trait",
            stableName: stable,
            displayName: traitName,
          });
          index = close + 1;
          continue;
        }

        if (/\bimpl\b/.test(compact)) {
          const identity = implIdentity(header);
          const stable = qualify(scope, identity.stable);
          addUnit(
            "class",
            identity.display,
            stable,
            { from: start.from, to: boundaryToken.to },
            [identity.target.split(/::|</)[0] ?? identity.target],
            scope,
            scope.stableName,
          );
          scanScope(boundary + 1, close, {
            ...scope,
            kind: "impl",
            stableName: stable,
            displayName: identity.display,
            names: scope.names,
          });
          index = close + 1;
          continue;
        }

        const functionMatch = /\bfn\s+([A-Za-z_]\w*)/.exec(compact);
        if (functionMatch?.[1]) {
          const name = functionMatch[1];
          const attached = attachedStart(source, start.from);
          const functionOffset = Math.max(0, header.search(/\bfn\b/));
          const baseStable =
            scope.kind === "impl" || scope.kind === "trait"
              ? `${scope.stableName}::${name}`
              : qualify(scope, name);
          const display =
            scope.kind === "impl" || scope.kind === "trait"
              ? `${scope.displayName}::${name}`
              : name;
          const kind =
            scope.kind === "impl" || scope.kind === "trait"
              ? "method"
              : testKind(source, attached, start.from + functionOffset, scope);
          addUnit(
            kind,
            display,
            kind === "test" ? `test:${baseStable}` : baseStable,
            { from: start.from, to: end },
            [name],
            scope,
            scope.stableName,
          );
          addClosureUnits(
            { from: boundaryToken.to, to: tokens[close]?.from ?? end },
            display,
            baseStable,
            scope,
          );
          index = close + 1;
          continue;
        }

        const externBlock = /\bextern\s*$/.test(compact);
        if (externBlock) {
          const label = /extern\s*"([^"]*)"/.exec(header)?.[1] ?? "Rust";
          const stable = qualify(scope, `extern:${label}`);
          addUnit(
            "module",
            `extern ${label}`,
            stable,
            { from: start.from, to: boundaryToken.to },
            [],
            scope,
            scope.stableName,
          );
          scanScope(boundary + 1, close, {
            ...scope,
            kind: "extern",
            stableName: stable,
            displayName: `extern ${label}`,
          });
          index = close + 1;
          continue;
        }

        const macroName =
          /\bmacro_rules\s*!\s*([A-Za-z_]\w*)/.exec(compact)?.[1] ??
          /\bmacro\s+([A-Za-z_]\w*)/.exec(compact)?.[1];
        if (macroName) {
          addUnit(
            "function",
            macroName,
            qualify(scope, `macro:${macroName}`),
            { from: start.from, to: end },
            [macroName],
            scope,
            scope.stableName,
          );
          index = close + 1;
          continue;
        }

        const invocation = macroInvocation(header);
        if (invocation) {
          if (
            ["proptest", "quickcheck"].includes(
              invocation.split("::").at(-1) ?? "",
            )
          ) {
            scanScope(boundary + 1, close, {
              ...scope,
              testModule: true,
              macroTests: true,
            });
          } else {
            addUnit(
              "module",
              `${invocation}!`,
              qualify(scope, `macro-call:${invocation}`),
              { from: start.from, to: end },
              [invocation.split("::").at(-1) ?? invocation],
              scope,
              scope.stableName,
            );
          }
          index = close + 1;
          if (tokens[index]?.value === ";") index += 1;
          continue;
        }

        const binding = /\b(const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)/.exec(
          compact,
        );
        if (binding?.[2]) {
          const name = binding[2];
          const stable = scope.stableName
            ? `${scope.stableName}::${name}`
            : qualify(scope, name);
          addUnit(
            binding[1] === "const" ? "constant" : "variable",
            ["impl", "trait", "extern"].includes(scope.kind) &&
              scope.displayName
              ? `${scope.displayName}::${name}`
              : name,
            stable,
            { from: start.from, to: end },
            [name],
            scope,
            scope.stableName,
          );
        }
        index = close + 1;
        if (tokens[index]?.value === ";") index += 1;
        continue;
      }

      const end = boundaryToken.to;
      if (
        /\b(?:use|extern\s+crate)\b/.test(compact) ||
        /\bmod\s+[A-Za-z_]\w*\s*$/.test(compact)
      ) {
        index = boundary + 1;
        continue;
      }
      const tupleStruct = /\bstruct\s+([A-Za-z_]\w*)\s*\(/.exec(compact);
      if (tupleStruct?.[1]) {
        const name = tupleStruct[1];
        const stable = qualify(scope, name);
        addUnit(
          "class",
          name,
          stable,
          { from: start.from, to: end },
          [name],
          scope,
          scope.stableName,
        );
        const open = tokens.findIndex(
          (token, tokenIndex) =>
            tokenIndex >= index && tokenIndex < boundary && token.value === "(",
        );
        const parens = paired(tokens, "(", ")");
        const close = open >= 0 ? parens.get(open) : undefined;
        if (open >= 0 && close !== undefined)
          addFields(stable, open, close, scope, true);
        index = boundary + 1;
        continue;
      }
      const unitStruct = /\bstruct\s+([A-Za-z_]\w*)\s*$/.exec(compact)?.[1];
      if (unitStruct) {
        addUnit(
          "class",
          unitStruct,
          qualify(scope, unitStruct),
          { from: start.from, to: end },
          [unitStruct],
          scope,
          scope.stableName,
        );
        index = boundary + 1;
        continue;
      }
      const functionMatch = /\bfn\s+([A-Za-z_]\w*)/.exec(compact);
      if (
        functionMatch?.[1] &&
        (["trait", "extern"].includes(scope.kind) || /\bextern\b/.test(compact))
      ) {
        const name = functionMatch[1];
        const stable = scope.stableName
          ? `${scope.stableName}::${name}`
          : qualify(scope, `extern:${name}`);
        const isMember = ["trait", "extern"].includes(scope.kind);
        addUnit(
          isMember ? "method" : "function",
          isMember ? `${scope.displayName}::${name}` : name,
          stable,
          { from: start.from, to: end },
          [name],
          scope,
          scope.stableName,
        );
        index = boundary + 1;
        continue;
      }
      const associatedType = /\btype\s+([A-Za-z_]\w*)/.exec(compact)?.[1];
      if (associatedType) {
        const stable = scope.stableName
          ? `${scope.stableName}::type:${associatedType}`
          : qualify(scope, associatedType);
        addUnit(
          "variable",
          scope.displayName
            ? `${scope.displayName}::${associatedType}`
            : associatedType,
          stable,
          { from: start.from, to: end },
          [associatedType],
          scope,
          scope.stableName,
        );
        index = boundary + 1;
        continue;
      }
      const binding = /\b(const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)/.exec(
        compact,
      );
      if (binding?.[2]) {
        const name = binding[2];
        const stable = scope.stableName
          ? `${scope.stableName}::${name}`
          : qualify(scope, name);
        addUnit(
          binding[1] === "const" ? "constant" : "variable",
          ["impl", "trait", "extern"].includes(scope.kind) && scope.displayName
            ? `${scope.displayName}::${name}`
            : name,
          stable,
          { from: start.from, to: end },
          [name],
          scope,
          scope.stableName,
        );
      } else {
        const invocation = /\b([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*!/.exec(
          compact,
        )?.[1];
        if (invocation)
          addUnit(
            "module",
            `${invocation}!`,
            qualify(scope, `macro-call:${invocation}`),
            { from: start.from, to: end },
            [invocation.split("::").at(-1) ?? invocation],
            scope,
            scope.stableName,
          );
      }
      index = boundary + 1;
    }
  };

  scanScope(0, tokens.length, { names: [], kind: "file", testModule: false });

  const byStable = new Map<string, PendingUnit[]>();
  const bySimple = new Map<string, PendingUnit[]>();
  for (const candidate of pending) {
    byStable.set(candidate.stableName, [
      ...(byStable.get(candidate.stableName) ?? []),
      candidate,
    ]);
    for (const simple of candidate.simpleNames)
      bySimple.set(simple, [...(bySimple.get(simple) ?? []), candidate]);
  }
  return pending.map((candidate) => {
    const dependencies = new Set<string>();
    for (const reference of candidate.references) {
      const simple = reference.split("::").at(-1) ?? reference;
      const scopedCandidates = candidate.scopeNames
        .map(
          (_, index) =>
            `${candidate.scopeNames.slice(0, candidate.scopeNames.length - index).join("::")}::${reference}`,
        )
        .flatMap((name) => byStable.get(name) ?? []);
      const exact = byStable.get(reference) ?? scopedCandidates;
      const matches = exact.length ? exact : (bySimple.get(simple) ?? []);
      const dependency = matches.length === 1 ? matches[0] : undefined;
      if (dependency && dependency !== candidate)
        dependencies.add(dependency.unit.stableKey);
    }
    if (candidate.unit.kind === "class" || candidate.unit.kind === "module") {
      for (const member of pending) {
        if (member.directOwner === candidate.stableName)
          dependencies.add(member.unit.stableKey);
      }
    }
    return { ...candidate.unit, dependencies: [...dependencies] };
  });
}

/** Rust parser that emits review units aligned with modules, types, and impls. */
export const rustAdapter: LanguageAdapter = {
  language: RUST_LANGUAGE,
  extensions: supportedExtensions.rust,
  isContextOnly: isRustContextOnly,
  analyze: analyzeRust,
};

export const rustParserInternals = {
  analyzeRust,
  isRustContextOnly,
  maskRustSource,
};
