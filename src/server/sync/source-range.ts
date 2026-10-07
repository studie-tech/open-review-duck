import type { AnalyzedUnit, SourceFile } from "~/server/analysis/types";

/** Indexes UTF-8 line boundaries once for all units of an immutable source. */
export function indexSourceLines(source: string) {
  const boundaries = [0];
  let offset = 0;
  for (const line of source.split("\n")) {
    offset += Buffer.byteLength(line) + 1;
    boundaries.push(offset);
  }
  boundaries[boundaries.length - 1] = Buffer.byteLength(source);
  return boundaries;
}

/** Converts an inclusive line range to UTF-8 byte offsets. */
export function sourceRange(
  source: string,
  startLine: number,
  endLine: number,
  boundaries = indexSourceLines(source),
) {
  const lineCount = boundaries.length - 1;
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > lineCount
  ) {
    throw new Error(
      `Source range ${startLine}-${endLine} is outside a ${lineCount}-line object`,
    );
  }
  return {
    startByte: boundaries[startLine - 1] ?? 0,
    endByte: boundaries[endLine] ?? 0,
  };
}

/** Selects the immutable source object and byte range for an atomic unit. */
export function persistedUnitSourceRange(
  file: Pick<SourceFile, "content" | "previousContent">,
  unit: Pick<
    AnalyzedUnit,
    | "changeType"
    | "startLine"
    | "endLine"
    | "previousStartLine"
    | "previousEndLine"
  >,
  boundaries?: { current: number[]; previous?: number[] },
) {
  const usePrevious =
    unit.changeType === "deleted" && file.previousContent !== undefined;
  const source = usePrevious
    ? (file.previousContent ?? file.content)
    : file.content;
  const startLine = usePrevious
    ? (unit.previousStartLine ?? unit.startLine)
    : unit.startLine;
  const endLine = usePrevious
    ? (unit.previousEndLine ?? unit.endLine)
    : unit.endLine;
  return {
    objectSide: usePrevious ? ("previous" as const) : ("current" as const),
    ...sourceRange(
      source,
      startLine,
      endLine,
      usePrevious ? boundaries?.previous : boundaries?.current,
    ),
  };
}

/** Converts an analyzed base-side line range to immutable object byte offsets. */
export function previousSourceRange(
  source: string,
  unit: AnalyzedUnit,
  boundaries?: number[],
) {
  if (unit.previousSource === undefined) return {};
  if (
    unit.previousStartLine === undefined ||
    unit.previousEndLine === undefined
  ) {
    throw new Error(`Previous source range is missing for ${unit.stableKey}`);
  }
  const range = sourceRange(
    source,
    unit.previousStartLine,
    unit.previousEndLine,
    boundaries,
  );
  return {
    previousStartByte: range.startByte,
    previousEndByte: range.endByte,
  };
}
