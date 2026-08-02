import { currentChangedLineIndexes } from "~/lib/side-by-side-diff";

export interface AiChangedLineRange {
  startLine: number;
  endLine: number;
}

interface ExplanationUnit {
  changeType: string;
  startLine: number;
  endLine: number;
  source: string;
  previousSource: string | null;
}

/** Coalesces sorted line numbers into compact inclusive ranges. */
function lineRanges(lines: readonly number[]): AiChangedLineRange[] {
  const ranges: AiChangedLineRange[] = [];
  for (const line of lines) {
    const previous = ranges.at(-1);
    if (previous && line <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, line);
    } else {
      ranges.push({ startLine: line, endLine: line });
    }
  }
  return ranges;
}

/**
 * Returns the displayed lines directly introduced, changed, or removed by the
 * pull request. The algorithm is language-neutral because parser units already
 * establish semantic boundaries; source comparison establishes review focus.
 */
export function explanationChangedLineRanges(
  unit: ExplanationUnit,
): AiChangedLineRange[] {
  if (unit.changeType === "added" || unit.changeType === "deleted") {
    return unit.endLine >= unit.startLine
      ? [{ startLine: unit.startLine, endLine: unit.endLine }]
      : [];
  }
  if (!unit.previousSource) return [];
  return lineRanges(
    [...currentChangedLineIndexes(unit.previousSource, unit.source)]
      .map((index) => unit.startLine + index)
      .filter((line) => line >= unit.startLine && line <= unit.endLine)
      .sort((left, right) => left - right),
  );
}

/** Constrains one model annotation to its first changed-line intersection. */
export function constrainAnnotationToChangedLines<
  T extends { line: number; endLine?: number },
>(annotation: T, ranges: readonly AiChangedLineRange[]): T | null {
  const annotationEnd = annotation.endLine ?? annotation.line;
  const intersection = ranges.find(
    (range) =>
      annotation.line <= range.endLine && annotationEnd >= range.startLine,
  );
  if (!intersection) return null;
  const line = Math.max(annotation.line, intersection.startLine);
  const endLine = Math.min(annotationEnd, intersection.endLine);
  return {
    ...annotation,
    line,
    ...(annotation.endLine === undefined && endLine === line
      ? {}
      : { endLine }),
  };
}
