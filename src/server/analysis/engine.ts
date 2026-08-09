import { basename } from "node:path";
import {
  type ImportStatement,
  resolveImportPath,
  resolvePythonImportedSubmodulePath,
} from "~/lib/import-navigation";
import { appendToIndex } from "~/lib/keyed-index";
import { reviewFoundationPriority } from "~/lib/review-priority";
import { lineDiffOperations } from "~/lib/side-by-side-diff";
import { languageAdapterForFile } from "./adapters";
import { semanticSource, sha256, stableReviewKey } from "./hash";
import {
  isImportOnlySource,
  parseImportReferences,
  parseImportStatements,
} from "./imports";
import {
  type SemanticSymbolOccurrence,
  semanticSymbolOccurrences,
} from "./parsers/tree-sitter-adapter";
import { blockCloserLines, type TreeSitterLanguage } from "./tree-sitter";
import type {
  AnalysisResult,
  AnalyzedUnit,
  ReviewUnitRange,
  SourceFile,
  SupportedLanguage,
} from "./types";

export const CURRENT_ANALYSIS_VERSION = 34;

type RawUnit = Omit<AnalyzedUnit, "changedLineCount" | "depth" | "reviewOrder">;
type CountedUnit = Omit<AnalyzedUnit, "depth" | "reviewOrder">;

interface LineChangeMasks {
  previous: boolean[];
  current: boolean[];
}

interface LineChangeHunk {
  previousStart?: number;
  previousEnd?: number;
  currentStart?: number;
  currentEnd?: number;
}

/** Computes changed-line masks from the shared language-neutral patience diff. */
export function changedLineMasks(
  previousSource: string,
  currentSource: string,
) {
  const previousLines = previousSource.split("\n");
  const currentLines = currentSource.split("\n");
  const masks: LineChangeMasks = {
    previous: new Array<boolean>(previousLines.length).fill(false),
    current: new Array<boolean>(currentLines.length).fill(false),
  };
  for (const operation of lineDiffOperations(previousLines, currentLines)) {
    if (
      operation.side === "previous" &&
      operation.previousIndex !== undefined
    ) {
      masks.previous[operation.previousIndex] = true;
    }
    if (operation.side === "current" && operation.currentIndex !== undefined) {
      masks.current[operation.currentIndex] = true;
    }
  }
  return masks;
}

/** Returns the changed base/head line total used by coverage accounting. */
export function changedLineCount(
  previousSource: string,
  currentSource: string,
) {
  const masks = changedLineMasks(previousSource, currentSource);
  return (
    masks.previous.filter(Boolean).length + masks.current.filter(Boolean).length
  );
}

/** The subset of a review unit that decides which lines it renders. */
export type UnitRangeSource = Pick<
  AnalyzedUnit,
  | "changeType"
  | "endLine"
  | "previousEndLine"
  | "previousStartLine"
  | "relatedRanges"
  | "startLine"
>;

/** Lists the side-specific source ranges through which a unit owns lines. */
export function unitOwnershipRanges(
  unit: UnitRangeSource,
  side: "previous" | "current",
) {
  const related = unit.relatedRanges?.flatMap((range) => {
    const startLine =
      side === "previous" ? range.previousStartLine : range.startLine;
    const endLine = side === "previous" ? range.previousEndLine : range.endLine;
    return startLine !== undefined && endLine !== undefined
      ? [{ startLine, endLine }]
      : [];
  });
  if (related?.length) return related;
  if (side === "previous") {
    const startLine =
      unit.previousStartLine ??
      (unit.changeType === "deleted" ? unit.startLine : undefined);
    const endLine =
      unit.previousEndLine ??
      (unit.changeType === "deleted" ? unit.endLine : undefined);
    return startLine !== undefined && endLine !== undefined
      ? [{ startLine, endLine }]
      : [];
  }
  return unit.changeType === "deleted"
    ? []
    : [{ startLine: unit.startLine, endLine: unit.endLine }];
}

/** Assigns every changed base/head line to exactly one atomic review unit. */
function assignChangedLineCounts(file: SourceFile, units: RawUnit[]) {
  if (units.length === 0) return [];
  if (file.isBinary || file.skipReason) {
    return units.map(
      (unit, index): CountedUnit => ({
        ...unit,
        changedLineCount: index === 0 ? 1 : 0,
      }),
    );
  }
  const previousSource =
    file.changeType === "added" ? "" : (file.previousContent ?? file.content);
  const currentSource = file.changeType === "deleted" ? "" : file.content;
  const masks = changedLineMasks(previousSource, currentSource);
  if (file.changeType === "added") masks.previous = [];
  if (file.changeType === "deleted") masks.current = [];
  const counts = new Map(units.map((unit) => [unit.stableKey, 0]));

  for (const side of ["previous", "current"] as const) {
    const changed = masks[side];
    const candidates = units.map((unit) => ({
      unit,
      ranges: unitOwnershipRanges(unit, side),
    }));
    for (let lineIndex = 0; lineIndex < changed.length; lineIndex += 1) {
      if (!changed[lineIndex]) continue;
      const line = lineIndex + 1;
      const containing = candidates
        .filter(({ ranges }) =>
          ranges.some(
            ({ startLine, endLine }) => line >= startLine && line <= endLine,
          ),
        )
        .sort((left, right) => {
          const leftSize = Math.min(
            ...left.ranges.map(({ startLine, endLine }) => endLine - startLine),
          );
          const rightSize = Math.min(
            ...right.ranges.map(
              ({ startLine, endLine }) => endLine - startLine,
            ),
          );
          return (
            leftSize - rightSize ||
            left.unit.stableKey.localeCompare(right.unit.stableKey)
          );
        });
      const owner =
        containing[0]?.unit ??
        candidates
          .filter(({ ranges }) => ranges.length > 0)
          .sort((left, right) => {
            /** Measures one changed line's distance from candidate ownership. */
            const distance = (ranges: typeof left.ranges) =>
              Math.min(
                ...ranges.map(({ startLine, endLine }) =>
                  line < startLine
                    ? startLine - line
                    : line > endLine
                      ? line - endLine
                      : 0,
                ),
              );
            return (
              distance(left.ranges) - distance(right.ranges) ||
              left.unit.stableKey.localeCompare(right.unit.stableKey)
            );
          })[0]?.unit ??
        [...units].sort((left, right) =>
          left.stableKey.localeCompare(right.stableKey),
        )[0];
      if (!owner) {
        throw new Error(
          `Changed ${side} line ${line} in ${file.path} has no atomic owner`,
        );
      }
      counts.set(owner.stableKey, (counts.get(owner.stableKey) ?? 0) + 1);
    }
  }
  const result = units.map(
    (unit): CountedUnit => ({
      ...unit,
      changedLineCount: counts.get(unit.stableKey) ?? 0,
    }),
  );
  const assigned = result.reduce(
    (total, unit) => total + unit.changedLineCount,
    0,
  );
  const expected =
    masks.previous.filter(Boolean).length +
    masks.current.filter(Boolean).length;
  if (assigned !== expected) {
    throw new Error(
      `Changed-line ownership mismatch for ${file.path}: ${assigned}/${expected}`,
    );
  }
  return result;
}

/** Groups adjacent base/head operations so renamed declarations can be paired. */
function changedLineHunks(previousSource: string, currentSource: string) {
  const hunks: LineChangeHunk[] = [];
  let hunk: LineChangeHunk | undefined;
  /** Commits the in-progress changed hunk. */
  const finish = () => {
    if (hunk) hunks.push(hunk);
    hunk = undefined;
  };
  for (const operation of lineDiffOperations(
    previousSource.split("\n"),
    currentSource.split("\n"),
  )) {
    if (operation.side === "both") {
      finish();
      continue;
    }
    hunk ??= {};
    if (operation.previousIndex !== undefined) {
      hunk.previousStart ??= operation.previousIndex;
      hunk.previousEnd = operation.previousIndex;
    }
    if (operation.currentIndex !== undefined) {
      hunk.currentStart ??= operation.currentIndex;
      hunk.currentEnd = operation.currentIndex;
    }
  }
  finish();
  return hunks;
}

/** Returns whether a one-based unit range overlaps a zero-based hunk range. */
function unitIntersectsHunk(
  unit: RawUnit,
  hunk: LineChangeHunk,
  side: "previous" | "current",
) {
  const start = hunk[`${side}Start`];
  const end = hunk[`${side}End`];
  return (
    start !== undefined &&
    end !== undefined &&
    unit.startLine - 1 <= end &&
    unit.endLine - 1 >= start
  );
}

/** Pairs renamed declarations occupying the same changed hunk across revisions. */
function renamedUnitPairs(
  currentUnits: RawUnit[],
  previousUnits: RawUnit[],
  currentByKey: ReadonlyMap<string, RawUnit>,
  previousByKey: ReadonlyMap<string, RawUnit>,
  hunks: readonly LineChangeHunk[],
) {
  const pairs = new Map<string, RawUnit>();
  const matchedPrevious = new Set<string>();
  const unmatchedCurrent = currentUnits
    .filter(({ stableKey }) => !previousByKey.has(stableKey))
    .sort(
      (left, right) =>
        left.endLine - left.startLine - (right.endLine - right.startLine) ||
        left.startLine - right.startLine,
    );
  for (const current of unmatchedCurrent) {
    const currentHunks = hunks.flatMap((hunk, index) =>
      unitIntersectsHunk(current, hunk, "current") ? [index] : [],
    );
    if (currentHunks.length === 0) continue;
    const candidates = previousUnits
      .filter(
        (previous) =>
          previous.kind === current.kind &&
          !currentByKey.has(previous.stableKey) &&
          !matchedPrevious.has(previous.stableKey),
      )
      .flatMap((previous) => {
        const sharedHunks = currentHunks.filter((index) => {
          const hunk = hunks[index];
          return hunk ? unitIntersectsHunk(previous, hunk, "previous") : false;
        });
        if (sharedHunks.length === 0) return [];
        const currentLength = current.endLine - current.startLine;
        const previousLength = previous.endLine - previous.startLine;
        return [
          {
            previous,
            score:
              sharedHunks.length * 1_000 -
              Math.abs(currentLength - previousLength) * 10 -
              Math.abs(current.startLine - previous.startLine),
          },
        ];
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.previous.startLine - right.previous.startLine ||
          left.previous.stableKey.localeCompare(right.previous.stableKey),
      );
    const best = candidates[0];
    if (!best || best.score === candidates[1]?.score) continue;
    pairs.set(current.stableKey, best.previous);
    matchedPrevious.add(best.previous.stableKey);
  }
  return { pairs, matchedPrevious };
}

/** Creates one honest review unit when no structural parser can inspect a file. */
function fallbackDeclaration(file: SourceFile) {
  const changeType = file.changeType ?? "modified";
  const binary = Boolean(file.isBinary);
  const oversized = file.skipReason === "too_large";
  const source = binary
    ? "Binary file — content is not displayed."
    : oversized
      ? "File content is too large to display safely."
      : file.content;
  const kind = binary ? ("binary" as const) : ("module" as const);
  const semanticContent =
    binary || oversized
      ? (file.binaryHash ?? `${file.path}:${changeType}`)
      : semanticSource(source, "text");
  return {
    stableKey: stableReviewKey(file.path, kind, "<whole-file>"),
    path: file.path,
    language: "text" as const,
    kind,
    name: oversized
      ? `${basename(file.path)} · too large`
      : basename(file.path),
    signature: binary
      ? `Binary file ${file.path}`
      : oversized
        ? `Large file ${file.path}`
        : `File ${file.path}`,
    startLine: 1,
    endLine: binary ? 1 : Math.max(1, source.split("\n").length),
    source,
    previousSource: binary || oversized ? undefined : file.previousContent,
    previousStartLine: file.previousContent === undefined ? undefined : 1,
    previousEndLine:
      file.previousContent === undefined
        ? undefined
        : Math.max(1, file.previousContent.split("\n").length),
    contentHash: sha256(binary ? semanticContent : source),
    semanticHash: sha256(`${changeType}:${semanticContent}`),
    changeType,
    complexity: 1,
    dependencies: [],
  } satisfies RawUnit;
}

/**
 * Matches the reserved words languages use to end a block instead of a brace:
 * the `end` family (`end`, `endif`, `endmodule`, `endfunction`, …) and the
 * three POSIX shell loop and branch terminators.
 */
const blockCloseWord = /^(?:end[a-z]*|fi|done|esac)$/;

/**
 * Detects a line that only closes a block a reviewed declaration already owns.
 *
 * A block ends either in punctuation (`}`, `});`, `];`) or in a reserved word,
 * and neither is reviewable work once the declaration it belongs to is its own
 * card. The test is lexical because a syntax tree cannot classify these tokens
 * once they are detached from their opening construct: a lone Ruby `end` parses
 * as an ordinary identifier and a lone brace parses as an error node. One
 * shared vocabulary therefore serves every language rather than a per-grammar
 * rule, and anything it does not recognize stays visible as a review unit.
 */
function isBlockDelimiterOnly(line: string | undefined) {
  if (!line?.trim()) return false;
  return line
    .replace(/[)\]};,]/g, " ")
    .split(/\s+/)
    .every((token) => !token || blockCloseWord.test(token.toLowerCase()));
}

/** Measures a line's indentation, treating a blank line as absent. */
function lineIndent(line: string | undefined) {
  return line?.trim() ? line.length - line.trimStart().length : undefined;
}

/**
 * Detects a line that only opens a block whose body a declaration already owns.
 *
 * A sweep range stops as soon as a covered line begins, so a range that ends on
 * a construct header means everything that header introduces is already its own
 * review card and the header is chrome around reviewed work. Indentation
 * decides the nesting, which keeps the rule free of a per-language list of
 * opening tokens (`{`, `:`, `do`, `then`, …).
 */
function opensReviewedBlock(lines: readonly string[], index: number) {
  const indent = lineIndent(lines[index]);
  if (indent === undefined) return false;
  for (let next = index + 1; next < lines.length; next += 1) {
    const nextIndent = lineIndent(lines[next]);
    if (nextIndent !== undefined) return nextIndent > indent;
  }
  return false;
}

/** Extracts reviewable module-level source not owned by a declaration unit. */
function moduleReviewUnits(
  file: SourceFile,
  language: SupportedLanguage,
  declarations: RawUnit[],
  isContextOnly: (source: string) => boolean,
) {
  const changeType = file.changeType ?? "modified";
  if (declarations.length === 0) {
    if (isContextOnly(file.content)) return [];
    return [
      {
        stableKey: stableReviewKey(file.path, "module", "<module>"),
        path: file.path,
        language,
        kind: "module" as const,
        name: basename(file.path),
        signature: `Module ${file.path}`,
        startLine: 1,
        endLine: Math.max(1, file.content.split("\n").length),
        source: file.content,
        previousSource: file.previousContent,
        previousStartLine: file.previousContent === undefined ? undefined : 1,
        previousEndLine:
          file.previousContent === undefined
            ? undefined
            : Math.max(1, file.previousContent.split("\n").length),
        contentHash: sha256(file.content),
        semanticHash: sha256(
          `${changeType}:${semanticSource(file.content, language)}`,
        ),
        changeType,
        complexity: 1,
        dependencies: [],
      },
    ];
  }

  const lines = file.content.split("\n");
  const covered = new Array<boolean>(lines.length).fill(false);
  for (const declaration of declarations) {
    for (
      let index = Math.max(0, declaration.startLine - 1);
      index < Math.min(lines.length, declaration.endLine);
      index += 1
    ) {
      covered[index] = true;
    }
  }
  const ranges: Array<{ start: number; end: number }> = [];
  let rangeStart: number | undefined;
  for (let index = 0; index <= lines.length; index += 1) {
    if (index < lines.length && !covered[index]) {
      rangeStart ??= index;
      continue;
    }
    if (rangeStart !== undefined) {
      ranges.push({ start: rangeStart, end: index - 1 });
      rangeStart = undefined;
    }
  }
  const firstDeclarationLine = Math.min(
    ...declarations.map(({ startLine }) => startLine),
  );
  return ranges.flatMap((range, rangeIndex) => {
    while (
      range.start <= range.end &&
      (!lines[range.start]?.trim() || isBlockDelimiterOnly(lines[range.start]))
    ) {
      range.start += 1;
    }
    while (
      range.end >= range.start &&
      (!lines[range.end]?.trim() || opensReviewedBlock(lines, range.end))
    ) {
      range.end -= 1;
    }
    if (range.start > range.end) return [];
    const source = lines.slice(range.start, range.end + 1).join("\n");
    const firstContentLine = source.split("\n").find((line) => line.trim());
    if (language === "python" && /^[ \t]+/.test(firstContentLine ?? "")) {
      return [];
    }
    if (isContextOnly(source)) return [];
    // Lines a declaration left behind when its members were reviewed one by
    // one close that declaration rather than stating anything of their own.
    if (isBlockDelimiterOnly(source)) return [];
    const setup = range.end + 1 < firstDeclarationLine;
    const name = setup ? "Module setup" : "Module statements";
    return [
      {
        stableKey: stableReviewKey(
          file.path,
          "module",
          `<module:${setup ? "setup" : "statements"}:${rangeIndex}>`,
        ),
        path: file.path,
        language,
        kind: "module" as const,
        name,
        signature: `${name} in ${file.path}`,
        startLine: range.start + 1,
        endLine: range.end + 1,
        source,
        contentHash: sha256(source),
        semanticHash: sha256(
          `${changeType}:${semanticSource(source, language)}`,
        ),
        changeType,
        complexity: 1,
        dependencies: setup
          ? []
          : declarations.map(({ stableKey }) => stableKey),
      },
    ];
  });
}

/** Gives colliding parser identities a deterministic source discriminator. */
function disambiguateStableKeys(units: RawUnit[]) {
  const keyCounts = new Map<string, number>();
  for (const unit of units) {
    keyCounts.set(unit.stableKey, (keyCounts.get(unit.stableKey) ?? 0) + 1);
  }
  const collisionCounts = new Map<string, number>();
  return units.map((unit) => {
    if ((keyCounts.get(unit.stableKey) ?? 0) === 1) return unit;
    const discriminator = sha256(unit.signature ?? unit.source).slice(0, 12);
    const candidate = `${unit.stableKey}:${discriminator}`;
    const occurrence = collisionCounts.get(candidate) ?? 0;
    collisionCounts.set(candidate, occurrence + 1);
    return {
      ...unit,
      stableKey: occurrence === 0 ? candidate : `${candidate}:${occurrence}`,
    };
  });
}

/** Parses one file without deciding which declarations belong to the PR diff. */
function rawFileReviewUnits(file: SourceFile) {
  const adapter =
    file.isBinary || file.skipReason ? undefined : languageAdapterForFile(file);
  const analyzed = adapter
    ? adapter.analyze(file)
    : [fallbackDeclaration(file)];
  const isContextOnly =
    adapter?.isContextOnly ??
    ((source: string) =>
      isImportOnlySource(source, adapter?.language ?? "text"));
  const hasLogicalDeclaration = analyzed.some(
    ({ source }) => !isContextOnly(source),
  );
  const declarations = disambiguateStableKeys(
    hasLogicalDeclaration
      ? analyzed.filter(({ source }) => !isContextOnly(source))
      : analyzed,
  );
  const moduleUnits = moduleReviewUnits(
    file,
    adapter?.language ?? "text",
    declarations,
    isContextOnly,
  );
  return {
    adapter,
    reviewUnits: [...declarations, ...moduleUnits],
  };
}

/** Collects contiguous uncovered changed-line ranges on one diff side. */
function uncoveredLineRanges(changed: boolean[], covered: boolean[]) {
  const ranges: Array<{ start: number; end: number }> = [];
  let start: number | undefined;
  for (let index = 0; index <= changed.length; index += 1) {
    if (index < changed.length && changed[index] && !covered[index]) {
      start ??= index;
      continue;
    }
    if (start !== undefined) {
      ranges.push({ start, end: index - 1 });
      start = undefined;
    }
  }
  return ranges;
}

/** Returns whether a zero-based range intersects an optional hunk span. */
function rangeIntersectsHunkSpan(
  range: { start: number; end: number },
  spanStart: number | undefined,
  spanEnd: number | undefined,
) {
  return (
    spanStart !== undefined &&
    spanEnd !== undefined &&
    range.start <= spanEnd &&
    range.end >= spanStart
  );
}

/** Builds a human-readable line-range label for a change fragment. */
function changeLineLabel(startIndex: number, endIndex: number) {
  return startIndex === endIndex
    ? `line ${startIndex + 1}`
    : `lines ${startIndex + 1}–${endIndex + 1}`;
}

/** Creates an explicit unit for changed lines not owned by a parsed declaration. */
function changeFragment(
  file: SourceFile,
  language: SupportedLanguage,
  options: {
    currentLines?: readonly string[];
    currentStart?: number;
    currentEnd?: number;
    previousLines?: readonly string[];
    previousStart?: number;
    previousEnd?: number;
  },
): RawUnit {
  const currentStart = options.currentStart;
  const currentEnd = options.currentEnd;
  const previousStart = options.previousStart;
  const previousEnd = options.previousEnd;
  const hasCurrent =
    options.currentLines !== undefined &&
    currentStart !== undefined &&
    currentEnd !== undefined;
  const hasPrevious =
    options.previousLines !== undefined &&
    previousStart !== undefined &&
    previousEnd !== undefined;
  const currentSource =
    hasCurrent && options.currentLines
      ? options.currentLines.slice(currentStart, currentEnd + 1).join("\n")
      : "";
  const previousSource =
    hasPrevious && options.previousLines
      ? options.previousLines.slice(previousStart, previousEnd + 1).join("\n")
      : undefined;
  const changeType = hasCurrent
    ? hasPrevious
      ? ("modified" as const)
      : ("added" as const)
    : ("deleted" as const);
  const labelStart = hasCurrent ? currentStart : (previousStart ?? 0);
  const labelEnd = hasCurrent ? currentEnd : (previousEnd ?? 0);
  const lineLabel = changeLineLabel(labelStart, labelEnd);
  const identitySource = hasCurrent
    ? currentSource
    : (previousSource ?? currentSource);
  const identity = `<pr-change:${changeType}:${labelStart + 1}:${sha256(identitySource).slice(0, 12)}>`;
  return {
    stableKey: stableReviewKey(file.path, "module", identity),
    path: file.path,
    language,
    kind: "module",
    name: `Changed ${lineLabel}`,
    signature: `Changed ${lineLabel} in ${file.path}`,
    startLine: labelStart + 1,
    endLine: labelEnd + 1,
    source: hasCurrent ? currentSource : (previousSource ?? ""),
    previousSource,
    previousStartLine: hasPrevious ? previousStart + 1 : undefined,
    previousEndLine: hasPrevious ? previousEnd + 1 : undefined,
    contentHash: sha256(hasCurrent ? currentSource : (previousSource ?? "")),
    semanticHash: sha256(
      `${changeType}:${semanticSource(
        hasCurrent ? currentSource : (previousSource ?? ""),
        language,
      )}`,
    ),
    changeType,
    complexity: 1,
    dependencies: [],
  };
}

/**
 * Converts uncovered changed-line ranges into review units, pairing base/head
 * ranges that share a replace hunk so rewrites surface as modifications.
 */
function uncoveredChangeFragments(
  file: SourceFile,
  language: SupportedLanguage,
  previousLines: readonly string[],
  currentLines: readonly string[],
  previousChanged: boolean[],
  currentChanged: boolean[],
  previousCovered: boolean[],
  currentCovered: boolean[],
) {
  const previousRanges = uncoveredLineRanges(previousChanged, previousCovered);
  const currentRanges = uncoveredLineRanges(currentChanged, currentCovered);
  const previousUsed = new Array<boolean>(previousRanges.length).fill(false);
  const currentUsed = new Array<boolean>(currentRanges.length).fill(false);
  const fragments: RawUnit[] = [];

  /** Marks a zero-based inclusive range as covered on one side. */
  const cover = (covered: boolean[], start: number, end: number) => {
    for (
      let index = Math.max(0, start);
      index <= Math.min(covered.length - 1, end);
      index += 1
    ) {
      covered[index] = true;
    }
  };

  for (const hunk of changedLineHunks(
    previousLines.join("\n"),
    currentLines.join("\n"),
  )) {
    const previousIndexes = previousRanges.flatMap((range, index) =>
      !previousUsed[index] &&
      rangeIntersectsHunkSpan(range, hunk.previousStart, hunk.previousEnd)
        ? [index]
        : [],
    );
    const currentIndexes = currentRanges.flatMap((range, index) =>
      !currentUsed[index] &&
      rangeIntersectsHunkSpan(range, hunk.currentStart, hunk.currentEnd)
        ? [index]
        : [],
    );
    if (previousIndexes.length === 0 || currentIndexes.length === 0) continue;

    const previousStart = Math.min(
      ...previousIndexes.map((index) => previousRanges[index]?.start ?? 0),
    );
    const previousEnd = Math.max(
      ...previousIndexes.map((index) => previousRanges[index]?.end ?? 0),
    );
    const currentStart = Math.min(
      ...currentIndexes.map((index) => currentRanges[index]?.start ?? 0),
    );
    const currentEnd = Math.max(
      ...currentIndexes.map((index) => currentRanges[index]?.end ?? 0),
    );
    for (const index of previousIndexes) previousUsed[index] = true;
    for (const index of currentIndexes) currentUsed[index] = true;
    cover(previousCovered, previousStart, previousEnd);
    cover(currentCovered, currentStart, currentEnd);
    fragments.push(
      changeFragment(file, language, {
        previousLines,
        previousStart,
        previousEnd,
        currentLines,
        currentStart,
        currentEnd,
      }),
    );
  }

  for (const [index, range] of currentRanges.entries()) {
    if (currentUsed[index] || !range) continue;
    cover(currentCovered, range.start, range.end);
    fragments.push(
      changeFragment(file, language, {
        currentLines,
        currentStart: range.start,
        currentEnd: range.end,
      }),
    );
  }
  for (const [index, range] of previousRanges.entries()) {
    if (previousUsed[index] || !range) continue;
    cover(previousCovered, range.start, range.end);
    fragments.push(
      changeFragment(file, language, {
        previousLines,
        previousStart: range.start,
        previousEnd: range.end,
      }),
    );
  }
  return fragments;
}

/** Fails closed if a future parser regression leaves a PR line unreviewable. */
function assertChangedLinesCovered(
  path: string,
  side: "base" | "head",
  changed: boolean[],
  covered: boolean[],
) {
  const missing = changed.flatMap((isChanged, index) =>
    isChanged && !covered[index] ? [index + 1] : [],
  );
  if (missing.length > 0) {
    throw new Error(
      `Analysis did not cover changed ${side} lines in ${path}: ${missing.join(", ")}`,
    );
  }
}

/** Returns whether a one-based line span holds at least one line changed by the PR. */
function intersectsChangedLines(
  span: { startLine: number; endLine: number },
  changed: boolean[],
) {
  const start = Math.max(0, span.startLine - 1);
  const end = Math.min(changed.length, span.endLine);
  for (let index = start; index < end; index += 1) {
    if (changed[index]) return true;
  }
  return false;
}

const importedIdentifier = /^[\w$][\w$.]*$/;

/** Compiles whole-word matchers for the names one import statement binds. */
function importedNamePatterns(statement: ImportStatement) {
  return statement.references.flatMap(({ local, specifier }) => {
    // Wildcard and whole-module imports bind no local identifier, so a body
    // reaches them through the specifier's final segment instead — Go spells
    // `import "fmt"` as `fmt.Sprint`. Requiring an identifier also stops the
    // placeholder itself from matching arbitrary punctuation in a body.
    const name = importedIdentifier.test(local)
      ? local
      : (specifier.split(/[/.]/).at(-1) ?? "");
    return importedIdentifier.test(name)
      ? [new RegExp(`(^|[^\\w$])${name.replace(/\./g, "\\.")}([^\\w$]|$)`)]
      : [];
  });
}

/** Records one contextual range on a unit without dropping the range it owns. */
function addRelatedRange(unit: RawUnit, range: ReviewUnitRange) {
  const [current] = unitOwnershipRanges(unit, "current");
  const [previous] = unitOwnershipRanges(unit, "previous");
  unit.relatedRanges = [
    ...(unit.relatedRanges ?? [
      {
        startLine: current?.startLine,
        endLine: current?.endLine,
        previousStartLine: previous?.startLine,
        previousEndLine: previous?.endLine,
      },
    ]),
    range,
  ].sort(
    (left, right) =>
      (left.startLine ?? left.previousStartLine ?? Number.MAX_SAFE_INTEGER) -
      (right.startLine ?? right.previousStartLine ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * Folds each changed import statement into the changed units that use it.
 *
 * An import exists for the declarations that reference it, so the declaration
 * spelling a newly imported symbol is the only card on which a reviewer can
 * judge the import. Recording the statement's range on that unit keeps the edit
 * inside a reviewable card — and therefore inside a review concept — instead of
 * leaving it as whole-file context that no card renders. A statement no changed
 * unit references is deliberately left uncovered so it surfaces as its own
 * change unit rather than silently re-opening declarations that never used it.
 *
 * Matching on the bound name keeps the rule language-neutral, because every
 * adapter reports import references through the shared statement model rather
 * than through per-language syntax.
 */
function foldContextualImportChanges(
  source: string,
  language: SupportedLanguage,
  changed: boolean[],
  covered: boolean[],
  units: Array<{ unit: RawUnit; source: string }>,
  side: "current" | "previous",
) {
  return parseImportStatements(source, language).flatMap((statement) => {
    if (!intersectsChangedLines(statement, changed)) return [];
    const patterns = importedNamePatterns(statement);
    const users = units.filter((candidate) =>
      patterns.some((pattern) => pattern.test(candidate.source)),
    );
    if (users.length === 0) return [];
    for (
      let index = Math.max(0, statement.startLine - 1);
      index < Math.min(changed.length, statement.endLine);
      index += 1
    ) {
      if (changed[index]) covered[index] = true;
    }
    for (const { unit } of users) {
      addRelatedRange(
        unit,
        side === "current"
          ? { startLine: statement.startLine, endLine: statement.endLine }
          : {
              previousStartLine: statement.startLine,
              previousEndLine: statement.endLine,
            },
      );
    }
    return [statement];
  });
}

/** Hashes the import statements intentionally absorbed as unit context. */
function contextualImportHash(
  statements: ImportStatement[],
  language: SupportedLanguage,
) {
  return statements.length > 0
    ? sha256(
        statements
          .map((statement) =>
            statement.references.length > 0
              ? JSON.stringify(
                  statement.references.map(
                    ({ specifier, imported, local, kind }) => ({
                      specifier,
                      imported,
                      local,
                      kind,
                    }),
                  ),
                )
              : semanticSource(statement.source, language),
          )
          .join("\n"),
      )
    : "";
}

/** Treats changed blank separators as layout belonging to nearby logical units. */
function markContextualBlankChanges(
  lines: readonly string[],
  changed: boolean[],
  covered: boolean[],
) {
  for (let index = 0; index < changed.length; index += 1) {
    if (changed[index] && !lines[index]?.trim()) covered[index] = true;
  }
}

/**
 * Treats a changed block-closing line as punctuation owned by the construct it
 * terminates, so a reflowed `});` never becomes a line-numbered review card of
 * its own. The source is only parsed once an uncovered changed line remains.
 */
function markContextualBlockCloserChanges(
  source: string,
  language: SupportedLanguage,
  changed: boolean[],
  covered: boolean[],
) {
  if (language === "text") return;
  if (!changed.some((isChanged, index) => isChanged && !covered[index])) return;
  for (const line of blockCloserLines(language, source)) {
    if (changed[line - 1]) covered[line - 1] = true;
  }
}

/** Scopes parsed units to the actual base-to-head changes in one modified file. */
function prScopedReviewUnits(
  file: SourceFile,
  language: SupportedLanguage,
  currentUnits: RawUnit[],
) {
  if (
    file.changeType !== "modified" ||
    file.previousContent === undefined ||
    file.isBinary ||
    file.skipReason
  ) {
    return currentUnits.length > 0 ||
      file.changeType === undefined ||
      language !== "text"
      ? currentUnits
      : [{ ...fallbackDeclaration(file), language }];
  }

  const previousFile: SourceFile = {
    ...file,
    content: file.previousContent,
    previousContent: undefined,
  };
  const previousUnits = rawFileReviewUnits(previousFile).reviewUnits;
  const previousByKey = new Map(
    previousUnits.map((unit) => [unit.stableKey, unit]),
  );
  const currentByKey = new Map(
    currentUnits.map((unit) => [unit.stableKey, unit]),
  );
  const renamed = renamedUnitPairs(
    currentUnits,
    previousUnits,
    currentByKey,
    previousByKey,
    changedLineHunks(file.previousContent, file.content),
  );
  const masks = changedLineMasks(file.previousContent, file.content);
  const currentLines = file.content.split("\n");
  const previousLines = file.previousContent.split("\n");
  const currentCovered = new Array<boolean>(currentLines.length).fill(false);
  const previousCovered = new Array<boolean>(previousLines.length).fill(false);

  const changedCandidates = currentUnits
    .flatMap((unit) => {
      const previous =
        previousByKey.get(unit.stableKey) ?? renamed.pairs.get(unit.stableKey);
      if (!intersectsChangedLines(unit, masks.current)) return [];
      if (previous?.contentHash === unit.contentHash) return [];
      return [{ unit, previous }];
    })
    .sort(
      (left, right) =>
        left.unit.endLine -
          left.unit.startLine -
          (right.unit.endLine - right.unit.startLine) ||
        left.unit.startLine - right.unit.startLine ||
        left.unit.stableKey.localeCompare(right.unit.stableKey),
    );
  const changedCurrent: RawUnit[] = [];
  for (const { unit, previous } of changedCandidates) {
    let ownsChangedLine = false;
    for (
      let index = Math.max(0, unit.startLine - 1);
      index < Math.min(currentCovered.length, unit.endLine);
      index += 1
    ) {
      if (masks.current[index] && !currentCovered[index]) {
        ownsChangedLine = true;
        break;
      }
    }
    if (!ownsChangedLine) continue;
    for (
      let index = Math.max(0, unit.startLine - 1);
      index < Math.min(currentCovered.length, unit.endLine);
      index += 1
    ) {
      currentCovered[index] = true;
    }
    if (previous) {
      for (
        let index = Math.max(0, previous.startLine - 1);
        index < Math.min(previousCovered.length, previous.endLine);
        index += 1
      ) {
        previousCovered[index] = true;
      }
    }
    changedCurrent.push({
      ...unit,
      previousSource: previous?.source,
      previousStartLine: previous?.startLine,
      previousEndLine: previous?.endLine,
      semanticHash: previous
        ? unit.semanticHash
        : sha256(`added:${semanticSource(unit.source, language)}`),
      changeType: previous ? ("modified" as const) : ("added" as const),
    });
  }

  const deletedUnits = previousUnits.flatMap((unit) => {
    if (
      currentByKey.has(unit.stableKey) ||
      renamed.matchedPrevious.has(unit.stableKey)
    ) {
      return [];
    }
    if (!intersectsChangedLines(unit, masks.previous)) return [];
    for (
      let index = Math.max(0, unit.startLine - 1);
      index < Math.min(previousCovered.length, unit.endLine);
      index += 1
    ) {
      previousCovered[index] = true;
    }
    return [
      {
        ...unit,
        previousSource: unit.source,
        previousStartLine: unit.startLine,
        previousEndLine: unit.endLine,
        semanticHash: sha256(
          `deleted:${semanticSource(unit.source, language)}`,
        ),
        changeType: "deleted" as const,
      },
    ];
  });

  const currentLogicalUnits = changedCurrent.flatMap((unit) =>
    isImportOnlySource(unit.source, language)
      ? []
      : [{ unit, source: unit.source }],
  );
  const previousLogicalUnits = [
    ...deletedUnits.flatMap((unit) =>
      isImportOnlySource(unit.source, language)
        ? []
        : [{ unit, source: unit.source }],
    ),
    ...changedCurrent.flatMap((unit) =>
      unit.previousSource !== undefined &&
      !isImportOnlySource(unit.previousSource, language)
        ? [{ unit, source: unit.previousSource }]
        : [],
    ),
  ];
  const absorbedCurrentImports =
    currentLogicalUnits.length > 0
      ? foldContextualImportChanges(
          file.content,
          language,
          masks.current,
          currentCovered,
          currentLogicalUnits,
          "current",
        )
      : [];
  if (currentLogicalUnits.length > 0) {
    markContextualBlankChanges(currentLines, masks.current, currentCovered);
    markContextualBlockCloserChanges(
      file.content,
      language,
      masks.current,
      currentCovered,
    );
  }
  const absorbedPreviousImports =
    previousLogicalUnits.length > 0
      ? foldContextualImportChanges(
          file.previousContent,
          language,
          masks.previous,
          previousCovered,
          previousLogicalUnits,
          "previous",
        )
      : [];
  if (previousLogicalUnits.length > 0) {
    markContextualBlankChanges(previousLines, masks.previous, previousCovered);
    markContextualBlockCloserChanges(
      file.previousContent,
      language,
      masks.previous,
      previousCovered,
    );
  }
  const currentImportHash = contextualImportHash(
    absorbedCurrentImports,
    language,
  );
  const previousImportHash = contextualImportHash(
    absorbedPreviousImports,
    language,
  );
  if (
    (currentImportHash || previousImportHash) &&
    currentImportHash !== previousImportHash
  ) {
    for (const unit of [...changedCurrent, ...deletedUnits]) {
      unit.semanticHash = sha256(
        `${unit.semanticHash}:contextual-imports:${currentImportHash}:${previousImportHash}`,
      );
    }
  }
  const fragments = uncoveredChangeFragments(
    file,
    language,
    previousLines,
    currentLines,
    masks.previous,
    masks.current,
    previousCovered,
    currentCovered,
  );
  assertChangedLinesCovered(file.path, "head", masks.current, currentCovered);
  assertChangedLinesCovered(file.path, "base", masks.previous, previousCovered);
  return [...changedCurrent, ...deletedUnits, ...fragments];
}

interface UnitSymbolProfile {
  unit: RawUnit;
  currentRange?: { startLine: number; endLine: number };
  previousRange?: { startLine: number; endLine: number };
  current: Map<string, SemanticSymbolOccurrence[]>;
  previous: Map<string, SemanticSymbolOccurrence[]>;
  added: Set<string>;
  removed: Set<string>;
}

const conceptSymbolStopWords = new Set([
  "args",
  "boolean",
  "data",
  "error",
  "false",
  "index",
  "item",
  "null",
  "number",
  "object",
  "props",
  "result",
  "self",
  "state",
  "string",
  "super",
  "this",
  "true",
  "undefined",
  "value",
]);

/**
 * Bounds the material a merge may add on top of the largest change it already
 * holds. A concept is one card and one sign-off: the engine cannot split an
 * oversized declaration, but it must not manufacture one either. Roughly half a
 * screen of extra code — the other members plus the untouched lines the merged
 * span drags in — is what a reviewer absorbs in the same pass as the change the
 * card is named after. Past that the members read better as their own named
 * cards, which dependency ordering already keeps adjacent.
 */
const conceptMergeLineBudget = 40;

/**
 * Bounds how many atomic cards one concept may replace. The merged title names a
 * single member and counts the rest, so it can only honestly stand for a
 * handful; beyond that the swallowed declarations lose the titles a reviewer
 * navigates and signs off by.
 */
const conceptMemberBudget = 4;

/** Indexes semantic occurrences whose source coordinates overlap one range. */
function symbolsWithinRange(
  occurrences: SemanticSymbolOccurrence[],
  range?: { startLine: number; endLine: number },
) {
  const symbols = new Map<string, SemanticSymbolOccurrence[]>();
  if (!range) return symbols;
  for (const occurrence of occurrences) {
    if (
      occurrence.endLine < range.startLine ||
      occurrence.startLine > range.endLine
    ) {
      continue;
    }
    appendToIndex(symbols, occurrence.name, occurrence);
  }
  return symbols;
}

/** Finds symbol counts that changed inside the corresponding unit slices. */
function changedProfileNames(
  before: Map<string, SemanticSymbolOccurrence[]>,
  after: Map<string, SemanticSymbolOccurrence[]>,
  direction: "added" | "removed",
) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return new Set(
    [...names].filter((name) => {
      const previousCount = before.get(name)?.length ?? 0;
      const currentCount = after.get(name)?.length ?? 0;
      return direction === "removed"
        ? previousCount > currentCount
        : currentCount > previousCount;
    }),
  );
}

/** Checks whether a definition's lexical scope can contain an occurrence. */
function scopesResolve(
  definitions: SemanticSymbolOccurrence[],
  occurrences: SemanticSymbolOccurrence[],
) {
  return definitions.some((definition) => {
    const specificScopes = definition.scopeChain.filter(
      (scope) => scope !== "<file>",
    );
    if (specificScopes.length === 0) return true;
    return occurrences.some((occurrence) =>
      specificScopes.some((scope) => occurrence.scopeChain.includes(scope)),
    );
  });
}

/** Pairs members with their range on one diff side, skipping absent sides. */
function conceptSideRanges(
  members: readonly UnitSymbolProfile[],
  side: "currentRange" | "previousRange",
) {
  return members.flatMap((member) => {
    const range = member[side];
    return range ? [{ member, range }] : [];
  });
}

/**
 * Returns the member whose declaration opens the merged card.
 *
 * A concept renders its head-side source whenever any member survives into the
 * head revision, so the card literally starts on the earliest range of that
 * side; naming the concept after any other member would title the card with a
 * symbol a reviewer never reads at its first line.
 */
function conceptOpeningMember(members: readonly UnitSymbolProfile[]) {
  const current = conceptSideRanges(members, "currentRange");
  const rendered =
    current.length > 0 ? current : conceptSideRanges(members, "previousRange");
  return rendered
    .sort(
      (left, right) =>
        left.range.startLine - right.range.startLine ||
        right.range.endLine - left.range.endLine ||
        left.member.unit.stableKey.localeCompare(right.member.unit.stableKey),
    )
    .at(0)?.member;
}

/**
 * Checks that related changes still read as a single reviewable card.
 *
 * Merging is discretionary, so it has to earn the atomic cards it consumes:
 * the concept stays within its member and line budgets, and it opens on a
 * declaration whose own name can title it. Module units are named after a line
 * range or the file itself, which names nothing a reviewer can sign off.
 */
function conceptRemainsAtomic(members: readonly UnitSymbolProfile[]) {
  if (members.length > conceptMemberBudget) return false;
  const opening = conceptOpeningMember(members);
  if (!opening || opening.unit.kind === "module") return false;
  return (["currentRange", "previousRange"] as const).every((side) => {
    const ranges = conceptSideRanges(members, side).map(({ range }) => range);
    if (ranges.length === 0) return true;
    const span =
      Math.max(...ranges.map(({ endLine }) => endLine)) -
      Math.min(...ranges.map(({ startLine }) => startLine));
    const largestMember = Math.max(
      ...ranges.map(({ startLine, endLine }) => endLine - startLine),
    );
    return span - largestMember <= conceptMergeLineBudget;
  });
}

/** Creates one deterministic multi-range concept from related atomic units. */
function mergeConceptUnits(file: SourceFile, members: UnitSymbolProfile[]) {
  const currentRanges = members.flatMap(({ currentRange }) =>
    currentRange ? [currentRange] : [],
  );
  const previousRanges = members.flatMap(({ previousRange }) =>
    previousRange ? [previousRange] : [],
  );
  const relatedRanges = members
    // A member that already renders disjoint ranges — a declaration holding the
    // import statement it uses — keeps them, so merging never hides a line the
    // member alone would have shown.
    .flatMap(
      ({ unit, currentRange, previousRange }): ReviewUnitRange[] =>
        unit.relatedRanges ?? [
          {
            startLine: currentRange?.startLine,
            endLine: currentRange?.endLine,
            previousStartLine: previousRange?.startLine,
            previousEndLine: previousRange?.endLine,
          },
        ],
    )
    .sort(
      (left, right) =>
        (left.startLine ?? left.previousStartLine ?? Number.MAX_SAFE_INTEGER) -
        (right.startLine ?? right.previousStartLine ?? Number.MAX_SAFE_INTEGER),
    );
  const currentStart = Math.min(
    ...currentRanges.map(({ startLine }) => startLine),
  );
  const currentEnd = Math.max(...currentRanges.map(({ endLine }) => endLine));
  const previousStart = Math.min(
    ...previousRanges.map(({ startLine }) => startLine),
  );
  const previousEnd = Math.max(...previousRanges.map(({ endLine }) => endLine));
  const currentSource =
    currentRanges.length > 0
      ? file.content
          .split("\n")
          .slice(currentStart - 1, currentEnd)
          .join("\n")
      : "";
  const previousSource =
    previousRanges.length > 0
      ? (file.previousContent ?? "")
          .split("\n")
          .slice(previousStart - 1, previousEnd)
          .join("\n")
      : undefined;
  const anchor = conceptOpeningMember(members)?.unit;
  if (!anchor) throw new Error("A review concept must contain an anchor");
  const memberKeys = members
    .map(({ unit }) => unit.stableKey)
    .sort((left, right) => left.localeCompare(right));
  const changeTypes = new Set(members.map(({ unit }) => unit.changeType));
  const changeType =
    changeTypes.size === 1
      ? (members[0]?.unit.changeType ?? "modified")
      : ("modified" as const);
  const stableKey = stableReviewKey(
    file.path,
    anchor.kind,
    `<concept:${sha256(memberKeys.join("\0"))}>`,
  );
  return {
    ...anchor,
    stableKey,
    name: `${anchor.name} · ${members.length} related changes`,
    signature: `Related changes for ${anchor.name}`,
    startLine:
      currentRanges.length > 0 ? currentStart : Math.max(1, previousStart),
    endLine: currentRanges.length > 0 ? currentEnd : Math.max(1, previousEnd),
    source: currentRanges.length > 0 ? currentSource : (previousSource ?? ""),
    previousSource,
    previousStartLine: previousRanges.length > 0 ? previousStart : undefined,
    previousEndLine: previousRanges.length > 0 ? previousEnd : undefined,
    contentHash: sha256(
      members
        .map(({ unit }) => unit.contentHash)
        .sort()
        .join("\0"),
    ),
    semanticHash: sha256(
      `${changeType}:${members
        .map(({ unit }) => unit.semanticHash)
        .sort()
        .join("\0")}`,
    ),
    changeType,
    complexity: members.reduce((total, { unit }) => total + unit.complexity, 0),
    dependencies: [
      ...new Set(members.flatMap(({ unit }) => unit.dependencies)),
    ].filter((dependency) => !memberKeys.includes(dependency)),
    relatedRanges,
  } satisfies RawUnit;
}

/**
 * Clusters high-confidence definition/reference changes into review concepts.
 *
 * The algorithm is language-neutral after Tree-sitter adapters normalize
 * identifiers, definitions, references, and lexical scope chains.
 */
function clusterRelatedChangeUnits(
  file: SourceFile,
  language: SupportedLanguage,
  units: RawUnit[],
) {
  if (
    language === "text" ||
    file.changeType !== "modified" ||
    !file.previousContent ||
    units.length < 2
  ) {
    return units;
  }
  const treeLanguage = language as TreeSitterLanguage;
  const currentOccurrences = semanticSymbolOccurrences(
    treeLanguage,
    file.content,
  );
  const previousOccurrences = semanticSymbolOccurrences(
    treeLanguage,
    file.previousContent,
  );
  const profiles: UnitSymbolProfile[] = units.map((unit) => {
    const currentRange =
      unit.changeType === "deleted"
        ? undefined
        : { startLine: unit.startLine, endLine: unit.endLine };
    const previousRange =
      unit.previousStartLine !== undefined && unit.previousEndLine !== undefined
        ? {
            startLine: unit.previousStartLine,
            endLine: unit.previousEndLine,
          }
        : undefined;
    const current = symbolsWithinRange(currentOccurrences, currentRange);
    const previous = symbolsWithinRange(previousOccurrences, previousRange);
    return {
      unit,
      currentRange,
      previousRange,
      current,
      previous,
      added: changedProfileNames(previous, current, "added"),
      removed: changedProfileNames(previous, current, "removed"),
    };
  });
  const parents = profiles.map((_, index) => index);
  /** Resolves one profile's path-compressed concept root. */
  const find = (index: number): number => {
    const parent = parents[index] ?? index;
    if (parent === index) return index;
    const root = find(parent);
    parents[index] = root;
    return root;
  };
  /** Joins two profiles into the same deterministic concept set. */
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const fullCounts = new Map<string, number>();
  for (const occurrence of [...currentOccurrences, ...previousOccurrences]) {
    fullCounts.set(occurrence.name, (fullCounts.get(occurrence.name) ?? 0) + 1);
  }
  for (const direction of ["removed", "added"] as const) {
    const side = direction === "removed" ? "previous" : "current";
    const names = new Set(
      profiles.flatMap((profile) => [...profile[direction]]),
    );
    for (const name of names) {
      if (
        name.length < 3 ||
        conceptSymbolStopWords.has(name.toLowerCase()) ||
        (fullCounts.get(name) ?? 0) > 48
      ) {
        continue;
      }
      const owners = profiles
        .flatMap((profile, index) => {
          if (!profile[direction].has(name)) return [];
          const definitions = (profile[side].get(name) ?? []).filter(
            ({ role }) => role === "definition",
          );
          const range =
            side === "previous" ? profile.previousRange : profile.currentRange;
          return definitions.length > 0 && range
            ? [
                {
                  index,
                  definitions,
                  rangeSize: range.endLine - range.startLine,
                },
              ]
            : [];
        })
        .sort(
          (left, right) =>
            left.rangeSize - right.rangeSize || left.index - right.index,
        );
      if (
        owners.length === 0 ||
        (owners[1] && owners[0]?.rangeSize === owners[1].rangeSize)
      ) {
        continue;
      }
      const owner = owners[0];
      if (!owner) continue;
      const related = profiles.flatMap((profile, index) => {
        if (index === owner.index || !profile[direction].has(name)) return [];
        const occurrences = profile[side].get(name) ?? [];
        return scopesResolve(owner.definitions, occurrences) ? [index] : [];
      });
      if (related.length === 0 || related.length > 24) continue;
      for (const index of related) union(owner.index, index);
    }
  }
  const grouped = new Map<number, UnitSymbolProfile[]>();
  profiles.forEach((profile, index) => {
    const root = find(index);
    appendToIndex(grouped, root, profile);
  });
  const aliases = new Map<string, string>();
  const merged = [...grouped.values()].flatMap((members) => {
    if (members.length === 1 || !conceptRemainsAtomic(members)) {
      return members.map(({ unit }) => unit);
    }
    const concept = mergeConceptUnits(file, members);
    for (const { unit } of members)
      aliases.set(unit.stableKey, concept.stableKey);
    return [concept];
  });
  return merged.map((unit) => ({
    ...unit,
    dependencies: [
      ...new Set(
        unit.dependencies
          .map((dependency) => aliases.get(dependency) ?? dependency)
          .filter((dependency) => dependency !== unit.stableKey),
      ),
    ],
  }));
}

/** Calculates dependency depth for every analyzed code unit. */
function calculateDepth(
  key: string,
  dependencies: Map<string, string[]>,
  visiting = new Set<string>(),
  memo = new Map<string, number>(),
): number {
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  if (visiting.has(key)) return 0;
  visiting.add(key);
  const depth = Math.max(
    0,
    ...(dependencies.get(key) ?? []).map(
      (dependency) =>
        1 + calculateDepth(dependency, dependencies, new Set(visiting), memo),
    ),
  );
  memo.set(key, depth);
  return depth;
}

/** Orders coherent dependency concepts depth-first while keeping test files contiguous. */
function clusterConceptUnits(units: AnalyzedUnit[]) {
  const fileContexts = units
    .filter(({ kind }) => kind === "file")
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.stableKey.localeCompare(right.stableKey),
    );
  const reviewableUnits = units.filter(({ kind }) => kind !== "file");
  const testPaths = new Set(
    reviewableUnits
      .filter(({ kind }) => kind === "test" || kind === "test_hook")
      .map(({ path }) => path),
  );
  const grouped = new Map<string, AnalyzedUnit[]>();
  for (const unit of reviewableUnits) {
    const groupKey = testPaths.has(unit.path)
      ? `test-file:${unit.path}`
      : `unit:${unit.stableKey}`;
    appendToIndex(grouped, groupKey, unit);
  }
  const clusters = [...grouped.entries()].map(([id, members]) => {
    return {
      id,
      members,
      dependencies: new Set<string>(),
      ownPriority: Math.min(
        ...members.map((unit) => reviewFoundationPriority(unit).rank),
      ),
      depth: Math.max(0, ...members.map(({ depth }) => depth)),
      complexity: Math.min(...members.map(({ complexity }) => complexity)),
      path: members[0]?.path ?? "",
      startLine: Math.min(...members.map(({ startLine }) => startLine)),
      testFile: members.length > 1 && testPaths.has(members[0]?.path ?? ""),
    };
  });
  const clusterByUnit = new Map(
    clusters.flatMap((cluster) =>
      cluster.members.map((unit) => [unit.stableKey, cluster.id] as const),
    ),
  );
  const clusterById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  for (const cluster of clusters) {
    for (const dependency of cluster.members.flatMap(
      (unit) => unit.dependencies,
    )) {
      const dependencyCluster = clusterByUnit.get(dependency);
      if (dependencyCluster && dependencyCluster !== cluster.id) {
        cluster.dependencies.add(dependencyCluster);
      }
    }
  }
  const dependents = new Map<string, Set<string>>();
  for (const cluster of clusters) {
    for (const dependency of cluster.dependencies) {
      const current = dependents.get(dependency) ?? new Set<string>();
      current.add(cluster.id);
      dependents.set(dependency, current);
    }
  }
  const priorityMemo = new Map<string, number>();

  /** Returns the strongest foundation priority reachable within a concept branch. */
  function branchPriority(
    cluster: (typeof clusters)[number],
    visiting = new Set<string>(),
  ): number {
    const cached = priorityMemo.get(cluster.id);
    if (cached !== undefined) return cached;
    if (visiting.has(cluster.id)) return cluster.ownPriority;
    visiting.add(cluster.id);
    const priority = Math.min(
      cluster.ownPriority,
      ...[...cluster.dependencies]
        .map((dependency) => clusterById.get(dependency))
        .filter((dependency): dependency is (typeof clusters)[number] =>
          Boolean(dependency),
        )
        .map((dependency) => branchPriority(dependency, new Set(visiting))),
    );
    priorityMemo.set(cluster.id, priority);
    return priority;
  }
  /** Orders clusters by their earliest transitive review foundation. */
  const compareFoundationPriority = (
    left: (typeof clusters)[number],
    right: (typeof clusters)[number],
  ) =>
    branchPriority(left) - branchPriority(right) ||
    left.ownPriority - right.ownPriority;
  /** Applies deterministic dependency, complexity, and source-order ranking. */
  const compareClusters = (
    left: (typeof clusters)[number],
    right: (typeof clusters)[number],
  ) =>
    compareFoundationPriority(left, right) ||
    left.complexity - right.complexity ||
    left.path.localeCompare(right.path) ||
    left.startLine - right.startLine ||
    left.id.localeCompare(right.id);
  const orderedClusters: typeof clusters = [];
  const emitted = new Set<string>();
  const visiting = new Set<string>();

  /** Emits one concept branch after recursively emitting its prerequisites. */
  function visit(cluster: (typeof clusters)[number]) {
    if (emitted.has(cluster.id) || visiting.has(cluster.id)) return;
    visiting.add(cluster.id);
    [...cluster.dependencies]
      .map((dependency) => clusterById.get(dependency))
      .filter((dependency): dependency is (typeof clusters)[number] =>
        Boolean(dependency),
      )
      .sort(
        (left, right) =>
          compareFoundationPriority(left, right) ||
          left.depth - right.depth ||
          compareClusters(left, right),
      )
      .forEach(visit);
    visiting.delete(cluster.id);
    emitted.add(cluster.id);
    orderedClusters.push(cluster);
  }

  clusters
    .filter((cluster) => (dependents.get(cluster.id)?.size ?? 0) === 0)
    .sort(compareClusters)
    .forEach(visit);
  clusters.sort(compareClusters).forEach(visit);

  const orderedReviewable = orderedClusters.flatMap((cluster) => {
    if (!cluster.testFile) return cluster.members;
    return cluster.members.sort((left, right) => {
      const leftRank =
        left.kind === "file"
          ? 2
          : left.kind === "module" &&
              ["Test setup", "Test module setup"].includes(left.name)
            ? 0
            : 1;
      const rightRank =
        right.kind === "file"
          ? 2
          : right.kind === "module" &&
              ["Test setup", "Test module setup"].includes(right.name)
            ? 0
            : 1;
      return (
        leftRank - rightRank ||
        left.startLine - right.startLine ||
        left.endLine - right.endLine ||
        left.stableKey.localeCompare(right.stableKey)
      );
    });
  });
  return [...orderedReviewable, ...fileContexts];
}

/** Extracts review units and produces their dependency-aware review order. */
export function analyzeFiles(files: SourceFile[]): AnalysisResult {
  const rawUnits = files.flatMap((file) => {
    const { adapter, reviewUnits: unscopedReviewUnits } =
      rawFileReviewUnits(file);
    const changeType = file.changeType ?? "modified";
    const scopedReviewUnits = prScopedReviewUnits(
      file,
      adapter?.language ?? "text",
      unscopedReviewUnits,
    );
    // Preserve the analyzer's existing high-confidence atomic units. Broader
    // multi-file concepts are built as a separate presentation layer.
    const atomicReviewUnits = clusterRelatedChangeUnits(
      file,
      adapter?.language ?? "text",
      scopedReviewUnits,
    );
    const reviewUnitsForPr = assignChangedLineCounts(file, atomicReviewUnits);
    const fileContextSource =
      file.isBinary || file.skipReason
        ? fallbackDeclaration(file).source
        : file.content;
    const fileContext: CountedUnit = {
      stableKey: stableReviewKey(file.path, "file", "<file-context>"),
      path: file.path,
      language: adapter?.language ?? "text",
      kind: "file",
      name: basename(file.path),
      signature: `Module ${file.path}`,
      startLine: 1,
      endLine: Math.max(1, file.content.split("\n").length),
      source: fileContextSource,
      previousSource: file.isBinary ? undefined : file.previousContent,
      previousStartLine:
        file.isBinary || file.previousContent === undefined ? undefined : 1,
      previousEndLine:
        file.isBinary || file.previousContent === undefined
          ? undefined
          : Math.max(1, file.previousContent.split("\n").length),
      contentHash: sha256(file.binaryHash ?? fileContextSource),
      semanticHash: sha256(
        `${changeType}:${
          file.isBinary
            ? (file.binaryHash ?? file.path)
            : semanticSource(file.content, adapter?.language ?? "text")
        }`,
      ),
      changeType,
      complexity:
        1 +
        reviewUnitsForPr.reduce((total, unit) => total + unit.complexity, 0),
      changedLineCount: 0,
      dependencies: reviewUnitsForPr.map((unit) => unit.stableKey),
    };
    return [...reviewUnitsForPr, fileContext];
  });
  const byShortKey = new Map<string, string[]>();
  const stableKeys = new Set(rawUnits.map((unit) => unit.stableKey));
  const byName = new Map<string, string[]>();
  for (const unit of rawUnits) {
    const shortKey = `${unit.path}:${unit.name}`;
    appendToIndex(byShortKey, shortKey, unit.stableKey);
    appendToIndex(byName, unit.name, unit.stableKey);
  }
  const importAliases = buildImportAliases(files, rawUnits);
  const dependencies = new Map(
    rawUnits.map((unit) => [
      unit.stableKey,
      [
        ...new Set(
          unit.dependencies
            .map((key) => {
              if (stableKeys.has(key)) return key;
              const name = key.slice(key.lastIndexOf(":") + 1);
              const importedMatches =
                importAliases.get(unit.path)?.get(name) ?? [];
              if (importedMatches.length === 1) return importedMatches[0];
              const localMatches = byShortKey.get(key) ?? [];
              if (localMatches.length === 1) return localMatches[0];
              const globalMatches = byName.get(name) ?? [];
              return globalMatches.length === 1 ? globalMatches[0] : undefined;
            })
            .filter((value): value is string => Boolean(value)),
        ),
      ],
    ]),
  );
  const withDepth = rawUnits.map((unit) => ({
    ...unit,
    dependencies: dependencies.get(unit.stableKey) ?? [],
    depth: calculateDepth(unit.stableKey, dependencies),
    reviewOrder: 0,
  }));
  const sorted = clusterConceptUnits(withDepth).map(
    (unit, reviewOrder): AnalyzedUnit => ({ ...unit, reviewOrder }),
  );
  return {
    units: sorted,
    unsupportedFiles: files
      .filter((file) => Boolean(file.skipReason))
      .map(({ path }) => path),
  };
}

/** Builds import aliases used to connect references across source files. */
function buildImportAliases(
  files: SourceFile[],
  units: Array<Pick<AnalyzedUnit, "stableKey" | "path" | "name" | "kind">>,
) {
  const paths = new Set(files.map(({ path }) => path));
  const unitsByPathAndName = new Map<string, string[]>();
  for (const unit of units) {
    const key = `${unit.path}:${unit.name}`;
    appendToIndex(unitsByPathAndName, key, unit.stableKey);
  }
  const result = new Map<string, Map<string, string[]>>();
  for (const file of files) {
    const aliases = new Map<string, string[]>();
    const language = languageAdapterForFile(file)?.language ?? "text";
    if (language === "text") {
      result.set(file.path, aliases);
      continue;
    }
    for (const item of parseImportReferences(file.content, language)) {
      const targetPath = resolveImportPath(
        file.path,
        item.specifier,
        paths,
        language,
      );
      if (item.kind === "named") {
        const matches = targetPath
          ? (unitsByPathAndName.get(`${targetPath}:${item.imported}`) ?? [])
          : [];
        if (matches.length > 0) {
          aliases.set(item.local, matches);
          continue;
        }
        if (language !== "python") continue;
        const submodulePath = resolvePythonImportedSubmodulePath(
          file.path,
          item.specifier,
          item.imported,
          paths,
        );
        if (!submodulePath) continue;
        for (const unit of units.filter(
          ({ path, kind }) =>
            path === submodulePath && kind !== "file" && kind !== "module",
        )) {
          aliases.set(`${item.local}.${unit.name}`, [unit.stableKey]);
        }
        continue;
      }
      if (!targetPath || item.local === "*") continue;
      for (const unit of units.filter(
        ({ path, kind }) =>
          path === targetPath && kind !== "file" && kind !== "module",
      )) {
        aliases.set(`${item.local}.${unit.name}`, [unit.stableKey]);
      }
    }
    result.set(file.path, aliases);
  }
  return result;
}

/** Carries forward sign-offs whose semantic source has not changed. */
export function reconcileSignOffs(
  previous: AnalyzedUnit[],
  next: AnalyzedUnit[],
) {
  const previousByKey = new Map(previous.map((unit) => [unit.stableKey, unit]));
  const nextByKey = new Map(next.map((unit) => [unit.stableKey, unit]));
  const changedKeys = new Set(
    next
      .filter(
        (unit) =>
          previousByKey.get(unit.stableKey)?.semanticHash !== unit.semanticHash,
      )
      .map((unit) => unit.stableKey),
  );
  for (const prior of previous) {
    if (!nextByKey.has(prior.stableKey)) changedKeys.add(prior.stableKey);
  }

  let previousGraphChanged = true;
  while (previousGraphChanged) {
    previousGraphChanged = false;
    for (const unit of previous) {
      if (
        !changedKeys.has(unit.stableKey) &&
        unit.dependencies.some((dependency) => changedKeys.has(dependency))
      ) {
        changedKeys.add(unit.stableKey);
        previousGraphChanged = true;
      }
    }
  }

  const requiresReview = new Set(
    next
      .filter(
        (unit) =>
          !previousByKey.has(unit.stableKey) || changedKeys.has(unit.stableKey),
      )
      .map((unit) => unit.stableKey),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of next) {
      if (
        !requiresReview.has(unit.stableKey) &&
        unit.dependencies.some((dependency) => requiresReview.has(dependency))
      ) {
        requiresReview.add(unit.stableKey);
        changed = true;
      }
    }
  }
  return next.map((unit) => {
    const prior = previousByKey.get(unit.stableKey);
    return {
      unit,
      requiresReview: requiresReview.has(unit.stableKey),
      previousUnit: prior,
    };
  });
}
