"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { SideBySideDiffRow } from "~/lib/side-by-side-diff";
import { cn } from "~/lib/utils";

export type ReviewOverviewKind = "added" | "deleted" | "modified";

export interface ReviewOverviewMark {
  end: number;
  kind: ReviewOverviewKind;
  start: number;
}

export interface ReviewOverviewRange {
  end: number;
  start: number;
}

/** Clamps a 0–1 overview coordinate so marks stay inside the track. */
export function clampOverviewRatio(value: number) {
  return Math.min(1, Math.max(0, value));
}

/** Coalesces consecutive changed diff rows onto the 0–1 overview scale. */
export function overviewMarksFromDiffRows(
  rows: readonly Pick<SideBySideDiffRow, "kind">[],
): ReviewOverviewMark[] {
  if (rows.length === 0) return [];
  const marks: ReviewOverviewMark[] = [];
  let current: ReviewOverviewMark | undefined;
  for (let index = 0; index < rows.length; index += 1) {
    const kind = rows[index]?.kind;
    if (kind === undefined || kind === "unchanged") {
      current = undefined;
      continue;
    }
    const start = index / rows.length;
    const end = (index + 1) / rows.length;
    if (current && current.kind === kind) {
      current.end = end;
      continue;
    }
    current = { end, kind, start };
    marks.push(current);
  }
  return marks;
}

/**
 * Maps a unit's current-side line window onto aligned diff rows.
 *
 * Deleted units have no current lines, so the previous side is the fallback
 * that still places the cyan review-scope band on the overview.
 */
export function overviewRangeFromDiffRows(
  rows: readonly SideBySideDiffRow[],
  startLine: number,
  endLine: number,
  options: { currentStartLine?: number; previousStartLine?: number } = {},
): ReviewOverviewRange | undefined {
  if (rows.length === 0 || endLine < startLine) return undefined;
  const currentStartLine = options.currentStartLine ?? 1;
  const previousStartLine = options.previousStartLine ?? 1;
  let first = -1;
  let last = -1;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    const currentLine =
      row.currentIndex === undefined
        ? undefined
        : currentStartLine + row.currentIndex;
    const previousLine =
      row.previousIndex === undefined
        ? undefined
        : previousStartLine + row.previousIndex;
    const inRange =
      (currentLine !== undefined &&
        currentLine >= startLine &&
        currentLine <= endLine) ||
      (currentLine === undefined &&
        previousLine !== undefined &&
        previousLine >= startLine &&
        previousLine <= endLine);
    if (!inRange) continue;
    if (first === -1) first = index;
    last = index;
  }
  if (first === -1) return undefined;
  return {
    end: (last + 1) / rows.length,
    start: first / rows.length,
  };
}

/** Reads how much of a code root is visible inside its scrolling pane. */
export function overviewViewportFromElements(
  pane: Pick<Element, "getBoundingClientRect">,
  code: Pick<Element, "getBoundingClientRect">,
): ReviewOverviewRange {
  const paneRect = pane.getBoundingClientRect();
  const codeRect = code.getBoundingClientRect();
  if (codeRect.height <= 0) return { end: 1, start: 0 };
  return {
    end: clampOverviewRatio((paneRect.bottom - codeRect.top) / codeRect.height),
    start: clampOverviewRatio((paneRect.top - codeRect.top) / codeRect.height),
  };
}

/** Scrolls a pane so `ratio` of the code root sits near the middle. */
export function seekOverviewRatio(
  pane: {
    clientHeight: number;
    scrollTo: (options: { top: number }) => void;
  },
  code: { offsetHeight: number; offsetTop: number },
  ratio: number,
) {
  const top =
    code.offsetTop +
    clampOverviewRatio(ratio) * code.offsetHeight -
    pane.clientHeight / 2;
  pane.scrollTo({ top: Math.max(0, top) });
}

const MARK_COLORS: Record<ReviewOverviewKind, string> = {
  added: "bg-addition",
  deleted: "bg-coral",
  modified: "bg-cyan",
};

const MARK_LABELS: Record<ReviewOverviewKind, string> = {
  added: "Added lines",
  deleted: "Deleted lines",
  modified: "Modified lines",
};

/** Converts a pointer event on the track into a 0–1 file position. */
function ratioFromPointer(
  event: Pick<PointerEvent, "clientX">,
  track: Element,
) {
  const bounds = track.getBoundingClientRect();
  if (bounds.width <= 0) return 0;
  return clampOverviewRatio((event.clientX - bounds.left) / bounds.width);
}

/**
 * Horizontal overview ruler for a long review unit.
 *
 * Editors keep this on the scrollbar: VS Code and Visual Studio paint SCM
 * ticks (green add, red delete) plus a viewport rectangle so a reviewer can
 * see where they are and jump without a full minimap. This strip does the
 * same job in the unit header, where the left and right sidebars already
 * occupy the vertical edges.
 */
export function ReviewScrollOverview({
  label,
  marks,
  onSeek,
  unitRange,
  viewport,
}: {
  label?: string;
  marks: readonly ReviewOverviewMark[];
  onSeek: (ratio: number) => void;
  unitRange?: ReviewOverviewRange;
  viewport: ReviewOverviewRange;
}) {
  const labelId = useId();
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const visibleStart = Math.round(viewport.start * 100);
  const visibleEnd = Math.round(viewport.end * 100);
  const viewportWidth = Math.max(viewport.end - viewport.start, 0.02);

  const seekFromEvent = useCallback(
    (event: Pick<PointerEvent, "clientX">) => {
      const track = trackRef.current;
      if (!track) return;
      onSeek(ratioFromPointer(event, track));
    },
    [onSeek],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      dragging.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      seekFromEvent(event);
    },
    [seekFromEvent],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      seekFromEvent(event);
    },
    [seekFromEvent],
  );

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 0.12 : 0.04;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        onSeek(clampOverviewRatio(viewport.start + step));
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        onSeek(clampOverviewRatio(viewport.start - step));
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        onSeek(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        onSeek(1);
      }
    },
    [onSeek, viewport.start],
  );

  return (
    <div className="border-t border-line px-3 py-2 sm:px-5 lg:px-7">
      <div className="flex items-center gap-3">
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-labelledby={label ? labelId : undefined}
          aria-label={label ? undefined : "Visible region of this file"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={visibleStart}
          aria-valuetext={`${visibleStart}% to ${visibleEnd}% of the file`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
          className="bg-surface-subtle relative h-3 min-w-0 flex-1 cursor-pointer overflow-hidden rounded-full border border-line/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          {unitRange && (
            <span
              aria-hidden="true"
              className="bg-cyan/20 absolute inset-y-0"
              style={{
                left: `${unitRange.start * 100}%`,
                width: `${Math.max(unitRange.end - unitRange.start, 0.012) * 100}%`,
              }}
            />
          )}
          {marks.map((mark) => (
            <span
              key={`${mark.kind}-${mark.start}`}
              aria-hidden="true"
              title={MARK_LABELS[mark.kind]}
              className={cn(
                "absolute top-0.5 bottom-0.5 rounded-full opacity-90",
                MARK_COLORS[mark.kind],
              )}
              style={{
                left: `${mark.start * 100}%`,
                width: `max(2px, ${(mark.end - mark.start) * 100}%)`,
              }}
            />
          ))}
          <span
            aria-hidden="true"
            className="border-cloud/70 bg-cloud/20 absolute inset-y-0 rounded-full border"
            style={{
              left: `${viewport.start * 100}%`,
              width: `${viewportWidth * 100}%`,
            }}
          />
        </div>
        {label && (
          <p
            id={labelId}
            className="text-fog hidden shrink-0 font-mono text-[9px] sm:block"
          >
            {label}
          </p>
        )}
      </div>
      <p className="text-fog mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px]">
        <span>File map · click to jump</span>
        {marks.some((mark) => mark.kind === "added") && (
          <span className="inline-flex items-center gap-1">
            <span className="bg-addition size-1.5 rounded-full" />
            Added
          </span>
        )}
        {marks.some((mark) => mark.kind === "deleted") && (
          <span className="inline-flex items-center gap-1">
            <span className="bg-coral size-1.5 rounded-full" />
            Deleted
          </span>
        )}
        {marks.some((mark) => mark.kind === "modified") && (
          <span className="inline-flex items-center gap-1">
            <span className="bg-cyan size-1.5 rounded-full" />
            Modified
          </span>
        )}
      </p>
    </div>
  );
}

/**
 * Keeps the overview viewport in sync with the code pane without a render on
 * every pointer-move of the page — only the pane's own scroll and size.
 */
export function useReviewCodeOverview(
  paneRef: { current: HTMLElement | null },
  codeRef: { current: HTMLElement | null },
  resetKey: unknown,
) {
  const [viewport, setViewport] = useState<ReviewOverviewRange>({
    end: 1,
    start: 0,
  });
  const [scrolled, setScrolled] = useState(false);

  const update = useCallback(() => {
    const pane = paneRef.current;
    const code = codeRef.current;
    if (!pane) return;
    setScrolled(pane.scrollTop > 8);
    if (!code) {
      setViewport({ end: 1, start: 0 });
      return;
    }
    setViewport(overviewViewportFromElements(pane, code));
  }, [codeRef, paneRef]);

  useEffect(() => {
    const pane = paneRef.current;
    const code = codeRef.current;
    if (!pane) return;
    // The code root remounts with the active unit; resetKey re-attaches
    // the observer to that new node instead of tracking a stale one.
    void resetKey;
    update();
    const observer = new ResizeObserver(update);
    observer.observe(pane);
    if (code) observer.observe(code);
    return () => observer.disconnect();
  }, [codeRef, paneRef, resetKey, update]);

  const seek = useCallback(
    (ratio: number) => {
      const pane = paneRef.current;
      const code = codeRef.current;
      if (!pane || !code) return;
      seekOverviewRatio(pane, code, ratio);
      update();
    },
    [codeRef, paneRef, update],
  );

  return { scrolled, seek, update, viewport };
}
