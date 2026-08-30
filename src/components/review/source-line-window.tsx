"use client";

import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * Lines a window mounts or folds away as one unit.
 *
 * Small enough that mounting a block on approach is a frame's work, large
 * enough that a long file needs tens of observers rather than thousands.
 */
const WINDOW_BLOCK_LINES = 50;

/**
 * Blocks mounted before the observer has reported anything.
 *
 * Covers the tallest viewport, so the pane paints source immediately
 * instead of a run of empty spacers waiting on the first observer frame.
 */
const WINDOW_INITIAL_BLOCKS = 4;

/**
 * Distance from the viewport at which a block mounts its rows.
 *
 * Roughly a viewport of lead time either way, so a fast scroll lands on
 * source rather than on a spacer that has yet to fill.
 */
const WINDOW_MOUNT_MARGIN_PX = 1500;

/**
 * Line count above which source mounts a block at a time.
 *
 * A source row is around two dozen DOM elements once syntax tokens, the
 * gutter and the line actions are counted, so a whole file mounted at once
 * costs tens of thousands of them and freezes the tab. Shorter source is a
 * few thousand elements, where windowing would only add wrappers and
 * observers.
 */
export const WINDOWED_SOURCE_LINE_COUNT = 400;

/**
 * Renders source rows, mounting only the blocks near the viewport.
 *
 * `renderLine` must return a keyed element: rows are rendered into an array
 * and their identity comes from the caller rather than from a block offset.
 * Lines named by `pinnedLines` stay mounted wherever the reviewer has
 * scrolled, so the anchors the pane scrolls to are always in the document.
 */
export function SourceLineWindow<T>({
  items,
  pinnedLines,
  renderLine,
  rowHeight,
  startLine,
}: {
  items: readonly T[];
  pinnedLines?: readonly number[];
  renderLine: (item: T, lineNumber: number) => ReactNode;
  rowHeight: number;
  startLine: number;
}) {
  if (items.length <= WINDOWED_SOURCE_LINE_COUNT) {
    return <>{renderBlock(items, 0, items.length, startLine, renderLine)}</>;
  }
  const pinnedBlocks = new Set(
    (pinnedLines ?? []).map((line) =>
      Math.floor((line - startLine) / WINDOW_BLOCK_LINES),
    ),
  );
  return (
    <>
      {Array.from(
        { length: Math.ceil(items.length / WINDOW_BLOCK_LINES) },
        (_, block) => {
          const first = block * WINDOW_BLOCK_LINES;
          const last = Math.min(items.length, first + WINDOW_BLOCK_LINES);
          return (
            <SourceLineBlock
              key={block}
              height={(last - first) * rowHeight}
              initiallyMounted={block < WINDOW_INITIAL_BLOCKS}
              pinned={pinnedBlocks.has(block)}
              render={() =>
                renderBlock(items, first, last, startLine, renderLine)
              }
            />
          );
        },
      )}
    </>
  );
}

/** Builds the caller's rows for one half-open range of line indexes. */
function renderBlock<T>(
  items: readonly T[],
  first: number,
  last: number,
  startLine: number,
  renderLine: (item: T, lineNumber: number) => ReactNode,
) {
  return items
    .slice(first, last)
    .map((item, offset) => renderLine(item, startLine + first + offset));
}

/**
 * Mounts one block of source rows while it is near the viewport.
 *
 * A folded block holds the height its rows last measured, so folding source
 * above the viewport never moves the source the reviewer is reading.
 */
function SourceLineBlock({
  height,
  initiallyMounted,
  pinned,
  render,
}: {
  height: number;
  initiallyMounted: boolean;
  pinned: boolean;
  render: () => ReactNode;
}) {
  const blockRef = useRef<HTMLDivElement>(null);
  const measuredHeight = useRef(height);
  const [near, setNear] = useState(initiallyMounted);
  const mounted = near || pinned;
  useEffect(() => {
    const element = blockRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: `${WINDOW_MOUNT_MARGIN_PX}px 0px` },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Measured after every commit rather than only on mount: a block grows
  // when a comment thread or finding card opens inside it, and folding it
  // away later has to give that space back exactly.
  useLayoutEffect(() => {
    const element = blockRef.current;
    if (mounted && element) measuredHeight.current = element.offsetHeight;
  });
  return (
    <div
      ref={blockRef}
      style={mounted ? undefined : { height: measuredHeight.current }}
    >
      {mounted ? render() : null}
    </div>
  );
}
