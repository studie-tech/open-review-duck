export interface SideBySideDiffRow {
  kind: "unchanged" | "modified" | "added" | "deleted";
  previousIndex?: number;
  currentIndex?: number;
}

export interface LineDiffOperation {
  side: "both" | "previous" | "current";
  previousIndex?: number;
  currentIndex?: number;
}

export type CompactSideBySideDiffItem =
  | {
      kind: "row";
      rowIndex: number;
      row: SideBySideDiffRow;
    }
  | {
      kind: "collapsed";
      rowStart: number;
      rowEnd: number;
      count: number;
    };

/** Finds the longest increasing sequence of current indexes for patience anchors. */
function increasingAnchorIndexes(
  candidates: Array<{ previous: number; current: number }>,
) {
  const tails: number[] = [];
  const predecessors = new Array<number>(candidates.length).fill(-1);
  for (let index = 0; index < candidates.length; index += 1) {
    const current = candidates[index]?.current ?? 0;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const tail = candidates[tails[middle] ?? 0]?.current ?? 0;
      if (tail < current) low = middle + 1;
      else high = middle;
    }
    if (low > 0) predecessors[index] = tails[low - 1] ?? -1;
    tails[low] = index;
  }
  const result: number[] = [];
  let cursor = tails.at(-1) ?? -1;
  while (cursor >= 0) {
    result.push(cursor);
    cursor = predecessors[cursor] ?? -1;
  }
  return result.reverse();
}

/** Appends an exact LCS diff for one small region. */
function appendExactRegion(
  previousLines: readonly string[],
  currentLines: readonly string[],
  previousStart: number,
  previousEnd: number,
  currentStart: number,
  currentEnd: number,
  operations: LineDiffOperation[],
) {
  const previousLength = previousEnd - previousStart;
  const currentLength = currentEnd - currentStart;
  const width = currentLength + 1;
  const lengths = new Uint32Array((previousLength + 1) * width);
  for (let previous = previousLength - 1; previous >= 0; previous -= 1) {
    for (let current = currentLength - 1; current >= 0; current -= 1) {
      lengths[previous * width + current] =
        previousLines[previousStart + previous] ===
        currentLines[currentStart + current]
          ? (lengths[(previous + 1) * width + current + 1] ?? 0) + 1
          : Math.max(
              lengths[(previous + 1) * width + current] ?? 0,
              lengths[previous * width + current + 1] ?? 0,
            );
    }
  }
  let previous = 0;
  let current = 0;
  while (previous < previousLength && current < currentLength) {
    const previousIndex = previousStart + previous;
    const currentIndex = currentStart + current;
    if (previousLines[previousIndex] === currentLines[currentIndex]) {
      operations.push({ side: "both", previousIndex, currentIndex });
      previous += 1;
      current += 1;
    } else if (
      (lengths[(previous + 1) * width + current] ?? 0) >=
      (lengths[previous * width + current + 1] ?? 0)
    ) {
      operations.push({ side: "previous", previousIndex });
      previous += 1;
    } else {
      operations.push({ side: "current", currentIndex });
      current += 1;
    }
  }
  while (previous < previousLength) {
    operations.push({
      side: "previous",
      previousIndex: previousStart + previous,
    });
    previous += 1;
  }
  while (current < currentLength) {
    operations.push({
      side: "current",
      currentIndex: currentStart + current,
    });
    current += 1;
  }
}

/**
 * Produces a language-neutral patience diff, using exact LCS only inside
 * ambiguous regions. Unique anchors prevent repeated braces and doc-comment
 * markers from pulling an insertion into the wrong declaration.
 */
export function lineDiffOperations(
  previousLines: readonly string[],
  currentLines: readonly string[],
) {
  const operations: LineDiffOperation[] = [];

  /** Counts lines in one region so repeated syntax cannot become a greedy anchor. */
  function regionLineCounts(
    lines: readonly string[],
    start: number,
    end: number,
  ) {
    const counts = new Map<string, number>();
    for (let index = start; index < end; index += 1) {
      const line = lines[index] ?? "";
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    return counts;
  }

  /** Recursively aligns one unmatched region. */
  function appendRegion(
    initialPreviousStart: number,
    initialPreviousEnd: number,
    initialCurrentStart: number,
    initialCurrentEnd: number,
    leftAnchored = false,
    rightAnchored = false,
  ) {
    let previousStart = initialPreviousStart;
    let previousEnd = initialPreviousEnd;
    let currentStart = initialCurrentStart;
    let currentEnd = initialCurrentEnd;
    const previousRegionCounts = regionLineCounts(
      previousLines,
      previousStart,
      previousEnd,
    );
    const currentRegionCounts = regionLineCounts(
      currentLines,
      currentStart,
      currentEnd,
    );
    while (
      previousStart < previousEnd &&
      currentStart < currentEnd &&
      previousLines[previousStart] === currentLines[currentStart] &&
      ((leftAnchored &&
        (!rightAnchored ||
          (previousStart + 1 < previousEnd &&
            currentStart + 1 < currentEnd &&
            previousLines[previousStart + 1] ===
              currentLines[currentStart + 1]))) ||
        (previousRegionCounts.get(previousLines[previousStart] ?? "") === 1 &&
          currentRegionCounts.get(currentLines[currentStart] ?? "") === 1))
    ) {
      operations.push({
        side: "both",
        previousIndex: previousStart,
        currentIndex: currentStart,
      });
      previousStart += 1;
      currentStart += 1;
    }
    let suffix = 0;
    while (
      previousStart < previousEnd &&
      currentStart < currentEnd &&
      previousLines[previousEnd - 1] === currentLines[currentEnd - 1] &&
      (rightAnchored ||
        (previousRegionCounts.get(previousLines[previousEnd - 1] ?? "") === 1 &&
          currentRegionCounts.get(currentLines[currentEnd - 1] ?? "") === 1))
    ) {
      previousEnd -= 1;
      currentEnd -= 1;
      suffix += 1;
    }
    if (previousStart === previousEnd) {
      for (let current = currentStart; current < currentEnd; current += 1) {
        operations.push({ side: "current", currentIndex: current });
      }
    } else if (currentStart === currentEnd) {
      for (
        let previous = previousStart;
        previous < previousEnd;
        previous += 1
      ) {
        operations.push({ side: "previous", previousIndex: previous });
      }
    } else {
      const previousOccurrences = new Map<
        string,
        { count: number; index: number }
      >();
      const currentOccurrences = new Map<
        string,
        { count: number; index: number }
      >();
      for (let index = previousStart; index < previousEnd; index += 1) {
        const line = previousLines[index] ?? "";
        const occurrence = previousOccurrences.get(line);
        previousOccurrences.set(line, {
          count: (occurrence?.count ?? 0) + 1,
          index,
        });
      }
      for (let index = currentStart; index < currentEnd; index += 1) {
        const line = currentLines[index] ?? "";
        const occurrence = currentOccurrences.get(line);
        currentOccurrences.set(line, {
          count: (occurrence?.count ?? 0) + 1,
          index,
        });
      }
      const candidates = [...previousOccurrences.entries()]
        .flatMap(([line, previous]) => {
          const current = currentOccurrences.get(line);
          return previous.count === 1 && current?.count === 1
            ? [{ previous: previous.index, current: current.index }]
            : [];
        })
        .sort((left, right) => left.previous - right.previous);
      const anchors = increasingAnchorIndexes(candidates).flatMap((index) => {
        const anchor = candidates[index];
        return anchor ? [anchor] : [];
      });
      if (anchors.length > 0) {
        let previousCursor = previousStart;
        let currentCursor = currentStart;
        let regionLeftAnchored = leftAnchored;
        for (const anchor of anchors) {
          appendRegion(
            previousCursor,
            anchor.previous,
            currentCursor,
            anchor.current,
            regionLeftAnchored,
            true,
          );
          operations.push({
            side: "both",
            previousIndex: anchor.previous,
            currentIndex: anchor.current,
          });
          previousCursor = anchor.previous + 1;
          currentCursor = anchor.current + 1;
          regionLeftAnchored = true;
        }
        appendRegion(
          previousCursor,
          previousEnd,
          currentCursor,
          currentEnd,
          regionLeftAnchored,
          rightAnchored,
        );
      } else {
        const cells =
          (previousEnd - previousStart) * (currentEnd - currentStart);
        if (cells <= 250_000) {
          appendExactRegion(
            previousLines,
            currentLines,
            previousStart,
            previousEnd,
            currentStart,
            currentEnd,
            operations,
          );
        } else {
          for (
            let previous = previousStart;
            previous < previousEnd;
            previous += 1
          ) {
            operations.push({ side: "previous", previousIndex: previous });
          }
          for (let current = currentStart; current < currentEnd; current += 1) {
            operations.push({ side: "current", currentIndex: current });
          }
        }
      }
    }
    for (let index = 0; index < suffix; index += 1) {
      operations.push({
        side: "both",
        previousIndex: previousEnd + index,
        currentIndex: currentEnd + index,
      });
    }
  }

  appendRegion(0, previousLines.length, 0, currentLines.length);
  return operations;
}

/** Pairs one changed block into GitHub-style side-by-side rows. */
function pairChangedBlock(operations: LineDiffOperation[]) {
  const previous = operations.filter(
    (operation) => operation.side === "previous",
  );
  const current = operations.filter(
    (operation) => operation.side === "current",
  );
  const rows: SideBySideDiffRow[] = [];
  for (
    let index = 0;
    index < Math.max(previous.length, current.length);
    index += 1
  ) {
    const previousOperation = previous[index];
    const currentOperation = current[index];
    rows.push({
      kind:
        previousOperation && currentOperation
          ? "modified"
          : previousOperation
            ? "deleted"
            : "added",
      previousIndex: previousOperation?.previousIndex,
      currentIndex: currentOperation?.currentIndex,
    });
  }
  return rows;
}

/** Produces aligned line rows for a side-by-side source diff. */
export function sideBySideDiff(previousSource: string, currentSource: string) {
  const previousLines = previousSource ? previousSource.split("\n") : [];
  const currentLines = currentSource ? currentSource.split("\n") : [];
  const operations = lineDiffOperations(previousLines, currentLines);

  const rows: SideBySideDiffRow[] = [];
  let changedBlock: LineDiffOperation[] = [];
  for (const operation of operations) {
    if (operation.side !== "both") {
      changedBlock.push(operation);
      continue;
    }
    rows.push(...pairChangedBlock(changedBlock));
    changedBlock = [];
    rows.push({
      kind: "unchanged",
      previousIndex: operation.previousIndex,
      currentIndex: operation.currentIndex,
    });
  }
  rows.push(...pairChangedBlock(changedBlock));
  return rows;
}

/**
 * Collapses long unchanged regions while retaining context around every hunk.
 * This projection is deliberately language-neutral: parsers decide unit
 * boundaries, while the diff decides which unchanged lines initially matter.
 */
export function compactSideBySideDiff(
  rows: readonly SideBySideDiffRow[],
  contextLines = 3,
  options?:
    | { start: number; end: number }
    | {
        requiredRange?: { start: number; end: number };
        /**
         * Only allow collapse inside this half-open range. Rows outside are
         * always shown — used so paged file context never recollapses.
         */
        collapseWithin?: { start: number; end: number };
        /** Keep this many rows pinned at each end of collapseWithin. */
        pinRangeEnds?: number;
      },
): CompactSideBySideDiffItem[] {
  const normalized =
    options && "collapseWithin" in options
      ? options
      : options && "requiredRange" in options
        ? options
        : options && "start" in options && "end" in options
          ? { requiredRange: options }
          : {};
  const requiredRange = normalized.requiredRange;
  const collapseWithin = normalized.collapseWithin;
  const pinRangeEnds = normalized.pinRangeEnds ?? 0;

  const changedIndexes = rows.flatMap((row, index) =>
    row.kind === "unchanged" ? [] : [index],
  );
  if (changedIndexes.length === 0 && !requiredRange && !collapseWithin) {
    return rows.map((row, rowIndex) => ({ kind: "row", row, rowIndex }));
  }

  const visible = new Uint8Array(rows.length);
  if (collapseWithin) {
    const from = Math.max(0, collapseWithin.start);
    const to = Math.min(rows.length, collapseWithin.end);
    // Paged surrounding context is always fully visible.
    visible.fill(1, 0, from);
    visible.fill(1, to, rows.length);
    if (pinRangeEnds > 0 && to > from) {
      visible.fill(1, from, Math.min(to, from + pinRangeEnds));
      visible.fill(1, Math.max(from, to - pinRangeEnds), to);
    }
  }
  if (requiredRange) {
    visible.fill(
      1,
      Math.max(0, requiredRange.start),
      Math.min(rows.length, requiredRange.end),
    );
  }
  for (const changedIndex of changedIndexes) {
    if (
      collapseWithin &&
      (changedIndex < collapseWithin.start ||
        changedIndex >= collapseWithin.end)
    ) {
      continue;
    }
    const start = Math.max(
      collapseWithin?.start ?? 0,
      changedIndex - contextLines,
    );
    const end = Math.min(
      collapseWithin?.end ?? rows.length,
      changedIndex + contextLines + 1,
    );
    visible.fill(1, start, end);
  }
  if (changedIndexes.length === 0 && !requiredRange) {
    // No hunks: keep the full compactable span rather than hiding everything.
    if (collapseWithin) {
      visible.fill(
        1,
        Math.max(0, collapseWithin.start),
        Math.min(rows.length, collapseWithin.end),
      );
    } else {
      visible.fill(1);
    }
  }

  const items: CompactSideBySideDiffItem[] = [];
  let rowIndex = 0;
  while (rowIndex < rows.length) {
    const row = rows[rowIndex];
    if (visible[rowIndex] && row) {
      items.push({ kind: "row", row, rowIndex });
      rowIndex += 1;
      continue;
    }
    const rowStart = rowIndex;
    while (rowIndex < rows.length && !visible[rowIndex]) rowIndex += 1;
    items.push({
      kind: "collapsed",
      rowStart,
      rowEnd: rowIndex,
      count: rowIndex - rowStart,
    });
  }
  return items;
}

/** Returns zero-based head-side line indexes introduced or changed by a diff. */
export function currentChangedLineIndexes(
  previousSource: string,
  currentSource: string,
) {
  const indexes = new Set<number>();
  for (const row of sideBySideDiff(previousSource, currentSource)) {
    if (
      (row.kind === "added" || row.kind === "modified") &&
      row.currentIndex !== undefined
    ) {
      indexes.add(row.currentIndex);
    }
  }
  return indexes;
}

/** Locates a unit's first line inside its complete file revision. */
export function sourceStartLine(
  fileSource: string | undefined,
  unitSource: string,
  fallback: number,
) {
  if (!fileSource || !unitSource) return fallback;
  const offset = fileSource.indexOf(unitSource);
  if (offset < 0) return fallback;
  return fileSource.slice(0, offset).split("\n").length;
}
