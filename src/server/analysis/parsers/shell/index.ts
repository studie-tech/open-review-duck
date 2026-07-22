import type {
  AnalyzedUnit,
  LanguageAdapter,
  SourceFile,
  UnitKind,
} from "../../types";
import { supportedExtensions, supportedFileNames } from "../../types";
import { isTestLikePath, makeUnit, type SourceRange } from "../shared";

export const shellExtensions = supportedExtensions.shell;
export const shellFileNames = supportedFileNames.shell;

interface Line {
  from: number;
  to: number;
  text: string;
  structural: string;
}

interface ShellRange extends SourceRange {
  declarationFrom: number;
}

interface PendingUnit {
  unit: Omit<AnalyzedUnit, "depth" | "reviewOrder">;
  references: string[];
}

const sourceCommand = /^(?:source|\.)\s+(?![(){};|&])(.+?)\s*(?:;)?$/;
const hookNames = new Set([
  "setup",
  "teardown",
  "setup_file",
  "teardown_file",
  "setUp",
  "tearDown",
  "oneTimeSetUp",
  "oneTimeTearDown",
]);

/** Masks strings, comments, and heredoc bodies without changing source offsets. */
function maskShellSource(source: string) {
  const masked = [...source];
  /** Blanks a shell literal range without changing source offsets. */
  const blank = (from: number, to: number) => {
    for (let index = from; index < to; index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
    }
  };

  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      let end = index + 1;
      while (end < source.length) {
        if (quote !== "'" && source[end] === "\\") {
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
    if (
      character === "#" &&
      (index === 0 || /[\s;|&()]/.test(source[index - 1] ?? ""))
    ) {
      const end = source.indexOf("\n", index + 1);
      const to = end < 0 ? source.length : end;
      blank(index, to);
      index = to;
      continue;
    }
    index += 1;
  }

  const base = masked.join("");
  const rawLines = source.split(/(?<=\n)/);
  let offset = 0;
  const pending: Array<{ delimiter: string; stripTabs: boolean }> = [];
  const queued: Array<{ delimiter: string; stripTabs: boolean }> = [];
  for (const rawLine of rawLines) {
    const from = offset;
    const to = from + rawLine.length;
    offset = to;
    if (pending.length > 0) {
      const heredoc = pending[0];
      const candidate = rawLine.replace(/\r?\n$/, "");
      const compared = heredoc?.stripTabs
        ? candidate.replace(/^\t+/, "")
        : candidate;
      blank(from, to);
      if (compared === heredoc?.delimiter) pending.shift();
      continue;
    }

    const structuralLine = base.slice(from, to);
    const operator = /<<(-)?(?!<)/g;
    for (const match of structuralLine.matchAll(operator)) {
      const localFrom = (match.index ?? 0) + match[0].length;
      let cursor = localFrom;
      while (/\s/.test(rawLine[cursor] ?? "") && rawLine[cursor] !== "\n") {
        cursor += 1;
      }
      let quote = "";
      if (["'", '"'].includes(rawLine[cursor] ?? "")) {
        quote = rawLine[cursor] ?? "";
        cursor += 1;
      } else if (rawLine[cursor] === "\\") {
        cursor += 1;
      }
      const start = cursor;
      while (
        cursor < rawLine.length &&
        (quote
          ? rawLine[cursor] !== quote
          : /[A-Za-z0-9_.:+-]/.test(rawLine[cursor] ?? ""))
      ) {
        cursor += 1;
      }
      const delimiter = rawLine.slice(start, cursor);
      if (delimiter) queued.push({ delimiter, stripTabs: match[1] === "-" });
    }
    if (!/\\\s*(?:\r?\n)?$/.test(structuralLine) && queued.length > 0) {
      pending.push(...queued.splice(0));
    }
  }
  return masked.join("");
}

/** Splits original and masked shell source into aligned lines. */
function sourceLines(source: string, structural: string) {
  const result: Line[] = [];
  let offset = 0;
  for (const text of source.split(/(?<=\n)/)) {
    const from = offset;
    const to = from + text.length;
    result.push({ from, to, text, structural: structural.slice(from, to) });
    offset = to;
  }
  return result;
}

/** Finds the source-line index containing an offset. */
function lineIndexAt(lines: Line[], offset: number) {
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const line = lines[middle];
    if (!line) break;
    if (offset < line.from) high = middle - 1;
    else if (offset >= line.to) low = middle + 1;
    else return middle;
  }
  return Math.max(0, Math.min(low, lines.length - 1));
}

/** Includes a directly adjacent shell comment block with a declaration. */
function documentedRange(
  lines: Line[],
  declarationFrom: number,
  to: number,
): ShellRange {
  const declarationLine = lineIndexAt(lines, declarationFrom);
  let first = declarationLine;
  for (let index = declarationLine - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) break;
    const text = line.text.replace(/\r?\n$/, "");
    if (/^\s*#/.test(text) && !/^\s*#!/.test(text)) {
      first = index;
      continue;
    }
    break;
  }
  return { from: lines[first]?.from ?? declarationFrom, to, declarationFrom };
}

/** Finds the closing brace for a shell brace block. */
function matchingBrace(structural: string, opening: number) {
  let depth = 0;
  for (let index = opening; index < structural.length; index += 1) {
    if (structural[index] === "{") depth += 1;
    if (structural[index] === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
}

/** Estimates shell review complexity from control-flow operators. */
function complexityOf(structural: string) {
  return Math.max(
    1,
    1 +
      (structural.match(
        /\b(?:if|elif|case|for|while|until|select)\b|&&|\|\||\|/g,
      )?.length ?? 0),
  );
}

/** Builds a shell unit with a declaration-derived signature. */
function shellUnit(
  file: SourceFile,
  kind: UnitKind,
  name: string,
  range: ShellRange,
  dependencies: string[],
  stableName = name,
) {
  const unit = makeUnit(
    file,
    "shell",
    kind,
    name,
    range,
    dependencies,
    complexityOf(file.content.slice(range.declarationFrom, range.to)),
    stableName,
  );
  const declaration = file.content.slice(range.declarationFrom, range.to);
  return {
    ...unit,
    signature: declaration.split(/[\n{]/, 1)[0]?.trim(),
  };
}

/** Extracts a static path from a shell source command. */
function sourceSpecifier(statement: string) {
  const match = sourceCommand.exec(statement.trim());
  if (!match) return undefined;
  const specifier = match[1]
    ?.replace(/^(['"])(.*)\1$/, "$2")
    .replace(/\s+#.*$/, "")
    .trim();
  if (!specifier || /(?:&&|\|\||[;|])\s*\S/.test(specifier)) return undefined;
  return specifier;
}

/** Collects sourced-script dependency identities. */
function sourcedDependencies(source: string) {
  return source
    .split(/\r?\n/)
    .map(sourceSpecifier)
    .filter((specifier): specifier is string => Boolean(specifier))
    .map((specifier) => `shell-source:${specifier}`);
}

/** Recognizes shebangs, comments, and static source commands as file context. */
export function isContextOnly(source: string) {
  const structural = maskShellSource(source);
  const lines = sourceLines(source, structural);
  return lines.every((line) => {
    const raw = line.text.trim();
    const code = line.structural.trim();
    if (!raw || raw.startsWith("#!") || raw.startsWith("#")) return true;
    return Boolean(code && sourceSpecifier(line.text));
  });
}

/** Checks whether a range overlaps an existing semantic unit. */
function occupiedBy(ranges: SourceRange[], from: number, to: number) {
  return ranges.some((range) => from < range.to && to > range.from);
}

interface FunctionRange extends ShellRange {
  name: string;
  opening: number;
  batsLabel?: string;
}

/** Finds documented shell functions and their complete bodies. */
function functionRanges(source: string, structural: string, lines: Line[]) {
  const candidates: FunctionRange[] = [];
  const expression =
    /(?:^|[;\n])\s*(?:(function)\s+([A-Za-z_][\w:.-]*)\s*(?:\(\s*\))?|([A-Za-z_][\w:.-]*)\s*\(\s*\))\s*\{/gm;
  for (const match of structural.matchAll(expression)) {
    const name = match[2] ?? match[3];
    const opening = (match.index ?? 0) + match[0].lastIndexOf("{");
    const declarationFrom =
      (match.index ?? 0) +
      (match[0].startsWith("\n") || match[0].startsWith(";") ? 1 : 0);
    const to = matchingBrace(structural, opening);
    if (!name || to === undefined) continue;
    candidates.push({
      ...documentedRange(lines, declarationFrom, to),
      name,
      opening,
    });
  }

  const batsExpression = /(?:^|\n)\s*@test\b[^\n{]*\{/gm;
  for (const match of structural.matchAll(batsExpression)) {
    const opening = (match.index ?? 0) + match[0].lastIndexOf("{");
    const declarationFrom =
      (match.index ?? 0) + (match[0].startsWith("\n") ? 1 : 0);
    const to = matchingBrace(structural, opening);
    if (to === undefined) continue;
    const header = source.slice(declarationFrom, opening);
    const batsLabel =
      /@test\s+(["'])(.*?)\1/s.exec(header)?.[2]?.replace(/\s+/g, " ").trim() ??
      /@test\s+([^\s{]+)/.exec(header)?.[1] ??
      "Bats test";
    candidates.push({
      ...documentedRange(lines, declarationFrom, to),
      name: batsLabel,
      batsLabel,
      opening,
    });
  }

  candidates.sort(
    (left, right) => left.declarationFrom - right.declarationFrom,
  );
  const accepted: FunctionRange[] = [];
  for (const candidate of candidates) {
    if (
      accepted.some(
        (outer) =>
          candidate.declarationFrom > outer.opening && candidate.to <= outer.to,
      )
    ) {
      continue;
    }
    accepted.push(candidate);
  }
  return accepted;
}

/** Finds calls to locally declared shell functions. */
function referencedFunctions(
  structural: string,
  names: readonly string[],
  ownName?: string,
) {
  return names.filter((name) => {
    if (name === ownName) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
      new RegExp(
        `(?:^|[;|&()\\n]\\s*|\\$\\(\\s*)(?:(?:run|command|builtin|env|sudo)\\s+)?${escaped}(?=\\s|[;|&()<>]|$)`,
        "m",
      ).test(structural) ||
      new RegExp(
        `(?:^|[;\\n]\\s*)trap\\s+(?:--\\s+)?${escaped}(?=\\s|$)`,
        "m",
      ).test(structural)
    );
  });
}

/** Trims whitespace around a top-level source interval. */
function trimShellRange(source: string, from: number, to: number) {
  while (from < to && /\s/.test(source[from] ?? "")) from += 1;
  while (to > from && /\s/.test(source[to - 1] ?? "")) to -= 1;
  return { from, to };
}

/** Finds the first executable offset within a top-level shell interval. */
function executableOffset(
  source: string,
  structural: string,
  from: number,
  to: number,
) {
  const lines = sourceLines(source.slice(from, to), structural.slice(from, to));
  const executable = lines.find((line) => {
    const raw = line.text.trim();
    const code = line.structural.trim();
    return (
      Boolean(code) &&
      !raw.startsWith("#!") &&
      !raw.startsWith("#") &&
      !sourceSpecifier(line.text)
    );
  });
  return from + (executable?.from ?? 0);
}

/** Returns meaningful top-level regions separated only by named declarations. */
function topLevelRanges(
  source: string,
  structural: string,
  functions: FunctionRange[],
) {
  const intervals: Array<{ from: number; to: number }> = [];
  let cursor = 0;
  for (const declaration of functions) {
    intervals.push({ from: cursor, to: declaration.from });
    cursor = declaration.to;
  }
  intervals.push({ from: cursor, to: source.length });

  return intervals.flatMap((interval, index) => {
    const range = trimShellRange(source, interval.from, interval.to);
    if (range.from >= range.to) return [];
    const region = source.slice(range.from, range.to);
    if (isContextOnly(region)) return [];
    const beforeFirstFunction =
      functions.length > 0 && range.to <= (functions[0]?.from ?? 0);
    const afterLastFunction =
      functions.length === 0 || range.from >= (functions.at(-1)?.to ?? 0);
    return [
      {
        ...range,
        declarationFrom: executableOffset(
          source,
          structural,
          range.from,
          range.to,
        ),
        name: beforeFirstFunction
          ? "Script setup"
          : afterLastFunction
            ? "Script execution"
            : "Script flow",
        stableName: beforeFirstFunction
          ? "script-setup"
          : afterLastFunction
            ? "script-execution"
            : `top-level-flow:${index}`,
      },
    ];
  });
}

/** Extracts shell functions, assignments, lifecycle, tests, and phases. */
function analyzeShell(file: SourceFile) {
  const structural = maskShellSource(file.content);
  const lines = sourceLines(file.content, structural);
  const functions = functionRanges(file.content, structural, lines);
  const occupied: SourceRange[] = functions.map(({ from, to }) => ({
    from,
    to,
  }));
  const sourceDependencies = lines
    .filter((line) => !occupiedBy(occupied, line.from, line.to))
    .map((line) => sourceSpecifier(line.text))
    .filter((specifier): specifier is string => Boolean(specifier))
    .map((specifier) => `shell-source:${specifier}`);
  const functionNames = functions
    .filter(({ batsLabel }) => !batsLabel)
    .map(({ name }) => name);
  const hasBats = functions.some(({ batsLabel }) => batsLabel);
  const testFile =
    hasBats ||
    isTestLikePath(file.path) ||
    /(?:^|\/)test[^/]*\.sh$/.test(file.path.toLowerCase());
  const pending: PendingUnit[] = functions.map((range) => {
    const body = structural.slice(range.opening + 1, range.to - 1);
    const isHook = !range.batsLabel && hookNames.has(range.name) && testFile;
    const isTest =
      Boolean(range.batsLabel) ||
      (!isHook && testFile && /^test[A-Z0-9_]/.test(range.name));
    const kind: UnitKind = isHook ? "test_hook" : isTest ? "test" : "function";
    return {
      unit: shellUnit(
        file,
        kind,
        range.name,
        range,
        [
          ...sourceDependencies,
          ...sourcedDependencies(
            file.content.slice(range.opening + 1, range.to - 1),
          ),
        ],
        range.name,
      ),
      references: referencedFunctions(body, functionNames, range.name),
    };
  });

  for (const range of topLevelRanges(file.content, structural, functions)) {
    const phaseStructure = structural.slice(range.from, range.to);
    pending.push({
      unit: shellUnit(
        file,
        "module",
        range.name,
        range,
        sourceDependencies,
        range.stableName,
      ),
      references: referencedFunctions(phaseStructure, functionNames),
    });
  }

  const functionsByName = new Map(
    pending
      .filter(({ unit }) =>
        ["function", "test", "test_hook"].includes(unit.kind),
      )
      .map(({ unit }) => [unit.name, unit.stableKey] as const),
  );
  return pending
    .map(({ unit, references }) => ({
      ...unit,
      dependencies: [
        ...new Set([
          ...unit.dependencies,
          ...references
            .map((reference) => functionsByName.get(reference))
            .filter((key): key is string => Boolean(key)),
        ]),
      ],
    }))
    .sort(
      (left, right) =>
        left.startLine - right.startLine || left.endLine - right.endLine,
    );
}

export const shellAdapter: LanguageAdapter = {
  language: "shell",
  extensions: shellExtensions,
  fileNames: shellFileNames,
  matches: ({ content }) =>
    /^#![^\n]*(?:\/|\b)(?:ba|z|k|da)?sh(?:\s|$)/.test(content),
  isContextOnly,
  analyze: analyzeShell,
};

export const shellParserInternals = {
  maskShellSource,
  sourceSpecifier,
};
