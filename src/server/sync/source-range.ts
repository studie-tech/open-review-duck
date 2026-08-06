import type { AnalyzedUnit, SourceFile } from "~/server/analysis/types";

/** Converts an inclusive line range to UTF-8 byte offsets. */
export function sourceRange(
  source: string,
  startLine: number,
  endLine: number,
) {
  const lineCount = source.split("\n").length;
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
  const lines = source.match(/[^\n]*(?:\n|$)/g) ?? [];
  const before = lines.slice(0, Math.max(0, startLine - 1)).join("");
  const selected = lines.slice(Math.max(0, startLine - 1), endLine).join("");
  const startByte = Buffer.byteLength(before);
  return { startByte, endByte: startByte + Buffer.byteLength(selected) };
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
    ...sourceRange(source, startLine, endLine),
  };
}

/** Converts an analyzed base-side line range to immutable object byte offsets. */
export function previousSourceRange(source: string, unit: AnalyzedUnit) {
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
  );
  return {
    previousStartByte: range.startByte,
    previousEndByte: range.endByte,
  };
}
