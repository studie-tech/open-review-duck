import { lineDiffOperations, sideBySideDiff } from "./side-by-side-diff";

export interface MovedCodeFile {
  path: string;
  previousPath?: string | null;
  previousSource: string;
  currentSource: string;
}

export interface MovedLineRange {
  startLine: number;
  endLine: number;
}

export interface MovedCodeRanges {
  previous: MovedLineRange[];
  current: MovedLineRange[];
}

interface ChangedChunk {
  id: number;
  file: number;
  start: number;
  lines: string[];
}

interface Anchor {
  chunk: ChangedChunk;
  index: number;
}

/** Separates reordered blocks while retaining the order inside each matched block. */
function orderedAnchorRuns(anchors: Array<[number, number]>) {
  const runs: Array<Array<[number, number]>> = [];
  for (const anchor of anchors.sort((left, right) => left[0] - right[0])) {
    let run = runs.at(-1);
    if (!run || anchor[1] <= (run.at(-1)?.[1] ?? -1)) {
      run = [];
      runs.push(run);
    }
    run.push(anchor);
  }
  return runs;
}

/** Excludes whitespace, delimiters, imports and comments as movement anchors. */
function meaningfulLine(line: string) {
  const text = line.trim();
  return (
    text.length >= 8 &&
    /[\p{L}\p{N}]/u.test(text) &&
    !/^(?:import\b|from\b|require\s*\(|\/\/|\/\*|\*|#)/u.test(text)
  );
}

/** Groups consecutive changed lines on one side without including retained code. */
function changedChunks(
  files: readonly MovedCodeFile[],
  side: "previous" | "current",
) {
  const chunks: ChangedChunk[] = [];
  for (const [file, source] of files.entries()) {
    const lines = source[`${side}Source`].split("\n");
    let chunk: ChangedChunk | undefined;
    for (const row of sideBySideDiff(
      source.previousSource,
      source.currentSource,
    )) {
      const index = row[`${side}Index`];
      if (row.kind === "unchanged" || index === undefined) continue;
      if (!chunk || chunk.start + chunk.lines.length !== index) {
        chunk = { id: chunks.length, file, start: index, lines: [] };
        chunks.push(chunk);
      }
      chunk.lines.push(lines[index] ?? "");
    }
  }
  return chunks;
}

/** Indexes exact changed text so repeated declarations cannot be paired arbitrarily. */
function anchorIndex(chunks: readonly ChangedChunk[]) {
  const index = new Map<string, Anchor[]>();
  for (const chunk of chunks) {
    chunk.lines.forEach((line, offset) => {
      if (!meaningfulLine(line)) return;
      const anchors = index.get(line) ?? [];
      anchors.push({ chunk, index: offset });
      index.set(line, anchors);
    });
  }
  return index;
}

/** Packs one-based line numbers into sorted contiguous ranges. */
function lineRanges(lines: ReadonlySet<number>): MovedLineRange[] {
  const ranges: MovedLineRange[] = [];
  for (const line of [...lines].sort((left, right) => left - right)) {
    const previous = ranges.at(-1);
    if (previous && previous.endLine + 1 === line) previous.endLine = line;
    else ranges.push({ startLine: line, endLine: line });
  }
  return ranges;
}

/** Checks an absolute source line against sorted movement ranges. */
export function isMovedCodeLine(
  ranges: readonly MovedLineRange[] | undefined,
  line: number | undefined,
) {
  if (line === undefined || !ranges) return false;
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const range = ranges[middle];
    if (!range) return false;
    if (line < range.startLine) high = middle;
    else if (line > range.endLine) low = middle + 1;
    else return true;
  }
  return false;
}

/**
 * Finds unchanged portions of confidently matched moves within and across files.
 *
 * Only removed and inserted text can seed a match, so copying retained code is
 * never treated as a move. Unique exact anchors bound a small comparison; at
 * least two meaningful lines and a majority of the block must match. Only
 * exact equal lines are returned, preserving every edit inside a moved block.
 */
export function movedCodeRanges(files: readonly MovedCodeFile[]) {
  const previous = anchorIndex(changedChunks(files, "previous"));
  const current = anchorIndex(changedChunks(files, "current"));
  const pairs = new Map<
    string,
    {
      previous: ChangedChunk;
      current: ChangedChunk;
      anchors: Array<[number, number]>;
    }
  >();
  for (const [text, oldAnchors] of previous) {
    const newAnchors = current.get(text);
    if (oldAnchors.length !== 1 || newAnchors?.length !== 1) continue;
    const old = oldAnchors[0];
    const next = newAnchors[0];
    if (!old || !next) continue;
    const key = `${old.chunk.id}:${next.chunk.id}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = { previous: old.chunk, current: next.chunk, anchors: [] };
      pairs.set(key, pair);
    }
    pair.anchors.push([old.index, next.index]);
  }
  const matched = files.map(() => ({
    previous: new Set<number>(),
    current: new Set<number>(),
  }));
  const blocks = [...pairs.values()].flatMap((pair) =>
    orderedAnchorRuns(pair.anchors).map((anchors) => ({ ...pair, anchors })),
  );
  for (const pair of blocks) {
    const first = pair.anchors[0];
    const last = pair.anchors.at(-1);
    if (!first || !last) continue;
    const leading = Math.min(first[0], first[1]);
    const trailing = Math.min(
      pair.previous.lines.length - last[0] - 1,
      pair.current.lines.length - last[1] - 1,
    );
    const oldStart = first[0] - leading;
    const newStart = first[1] - leading;
    const oldLines = pair.previous.lines.slice(
      oldStart,
      last[0] + trailing + 1,
    );
    const newLines = pair.current.lines.slice(newStart, last[1] + trailing + 1);
    // The shared patience diff bounds exact LCS work inside ambiguous gaps,
    // while unique anchors allow large moved blocks to stay a linear pass.
    const operations = lineDiffOperations(oldLines, newLines);
    const equal = operations.filter((operation) => operation.side === "both");
    const meaningful = equal.filter((operation) =>
      meaningfulLine(oldLines[operation.previousIndex ?? -1] ?? ""),
    );
    const size = Math.max(
      oldLines.filter(meaningfulLine).length,
      newLines.filter(meaningfulLine).length,
    );
    if (meaningful.length < 2 || meaningful.length / size < 0.6) continue;
    for (const operation of equal) {
      if (
        operation.previousIndex === undefined ||
        operation.currentIndex === undefined
      )
        continue;
      const oldLine =
        pair.previous.start + oldStart + operation.previousIndex + 1;
      const newLine =
        pair.current.start + newStart + operation.currentIndex + 1;
      const oldMatch = matched[pair.previous.file];
      const newMatch = matched[pair.current.file];
      if (
        !oldMatch ||
        !newMatch ||
        oldMatch.previous.has(oldLine) ||
        newMatch.current.has(newLine)
      )
        continue;
      oldMatch.previous.add(oldLine);
      newMatch.current.add(newLine);
    }
  }
  // A provider-verified file rename is already an unambiguous movement match.
  for (const [index, file] of files.entries()) {
    if (!file.previousPath || file.previousPath === file.path) continue;
    for (const row of sideBySideDiff(file.previousSource, file.currentSource)) {
      if (row.kind !== "unchanged") continue;
      if (row.previousIndex !== undefined)
        matched[index]?.previous.add(row.previousIndex + 1);
      if (row.currentIndex !== undefined)
        matched[index]?.current.add(row.currentIndex + 1);
    }
  }
  return files
    .map((file, index) => ({
      path: file.path,
      previous: lineRanges(matched[index]?.previous ?? new Set()),
      current: lineRanges(matched[index]?.current ?? new Set()),
    }))
    .filter((file) => file.previous.length > 0 || file.current.length > 0);
}
