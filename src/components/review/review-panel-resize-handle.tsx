"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "~/lib/utils";

export type ReviewPanelSide = "left" | "right";

export const REVIEW_PATH_PANEL_WIDTHS = {
  default: 250,
  maximum: 480,
  minimum: 220,
} as const;

export const REVIEW_INSIGHTS_PANEL_WIDTHS = {
  default: 320,
  maximum: 560,
  minimum: 280,
} as const;

/** Distance from the outside window edge that magnetically hides a panel. */
export const REVIEW_PANEL_COLLAPSE_WIDTH = 96;

/** Converts horizontal pointer travel into the width of either edge panel. */
export function reviewPanelWidthFromPointer(input: {
  clientX: number;
  side: ReviewPanelSide;
  startClientX: number;
  startWidth: number;
}) {
  const travel = input.clientX - input.startClientX;
  return input.startWidth + (input.side === "left" ? travel : -travel);
}

/** Applies the panel's snap-to-close zone and useful-width constraints. */
export function previewReviewPanelWidth(
  width: number,
  minimumWidth: number,
  maximumWidth: number,
) {
  if (width <= REVIEW_PANEL_COLLAPSE_WIDTH) return 0;
  return Math.min(maximumWidth, Math.max(minimumWidth, width));
}

/** Accessible desktop split-pane handle shared by both workspace sidebars. */
export function ReviewPanelResizeHandle({
  className,
  controls,
  defaultWidth,
  label,
  maximumWidth,
  minimumWidth,
  onCollapse,
  onResize,
  side,
  width,
}: {
  className?: string;
  controls: string;
  defaultWidth: number;
  label: string;
  maximumWidth: number;
  minimumWidth: number;
  onCollapse: () => void;
  onResize: (width: number) => void;
  side: ReviewPanelSide;
  width: number;
}) {
  const clearDragListeners = useRef<() => void>(() => undefined);
  const [dragging, setDragging] = useState(false);

  useEffect(
    () => () => {
      clearDragListeners.current();
    },
    [],
  );

  /** Resizes with physical arrow direction and collapses past minimum width. */
  function handleKeyDown(event: ReactKeyboardEvent<HTMLHRElement>) {
    if (event.key === "Home") {
      event.preventDefault();
      onResize(minimumWidth);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      onResize(maximumWidth);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const pointerDirection = event.key === "ArrowRight" ? 1 : -1;
    const widthDirection =
      side === "left" ? pointerDirection : -pointerDirection;
    const step = event.shiftKey ? 32 : 16;
    const nextWidth = width + widthDirection * step;
    if (nextWidth < minimumWidth) {
      onCollapse();
      return;
    }
    onResize(Math.min(maximumWidth, nextWidth));
  }

  /** Tracks the gesture on the window so leaving the narrow handle is harmless. */
  function beginDrag(event: ReactPointerEvent<HTMLHRElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    clearDragListeners.current();
    setDragging(true);
    const pointerId = event.pointerId;
    const startClientX = event.clientX;
    const startWidth = width;
    let lastExpandedWidth = width;
    let pendingClientX: number | undefined;
    let resizeFrame: number | undefined;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    /** Returns the raw width represented by one pointer position. */
    const rawWidthAt = (clientX: number) =>
      reviewPanelWidthFromPointer({
        clientX,
        side,
        startClientX,
        startWidth,
      });

    /** Commits the latest width once per paint while retaining reopen width. */
    function applyPendingResize() {
      resizeFrame = undefined;
      if (pendingClientX === undefined) return;
      const nextWidth = previewReviewPanelWidth(
        rawWidthAt(pendingClientX),
        minimumWidth,
        maximumWidth,
      );
      if (nextWidth > 0) lastExpandedWidth = nextWidth;
      onResize(nextWidth);
    }

    /** Restores global interaction state after any drag outcome. */
    function cleanupDrag() {
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      resizeFrame = undefined;
      window.removeEventListener("pointermove", previewDrag, true);
      window.removeEventListener("pointerup", finishDrag, true);
      window.removeEventListener("pointercancel", cancelDrag, true);
      window.removeEventListener("keydown", cancelFromKeyboard, true);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setDragging(false);
      clearDragListeners.current = () => undefined;
    }

    /** Queues a live preview without doing more than one render per frame. */
    function previewDrag(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== pointerId) return;
      pointerEvent.preventDefault();
      pendingClientX = pointerEvent.clientX;
      resizeFrame ??= requestAnimationFrame(applyPendingResize);
    }

    /** Keeps the last useful width, or hides the panel in the edge snap zone. */
    function finishDrag(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== pointerId) return;
      pointerEvent.preventDefault();
      const rawWidth = rawWidthAt(pointerEvent.clientX);
      const finalWidth = previewReviewPanelWidth(
        rawWidth,
        minimumWidth,
        maximumWidth,
      );
      cleanupDrag();
      if (finalWidth === 0) {
        onResize(lastExpandedWidth);
        onCollapse();
        return;
      }
      onResize(finalWidth);
    }

    /** Cancels a pointer drag and returns to its starting width. */
    function cancelDrag(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== pointerId) return;
      cleanupDrag();
      onResize(startWidth);
    }

    /** Escape offers the same non-destructive cancel as a native dialog. */
    function cancelFromKeyboard(keyboardEvent: KeyboardEvent) {
      if (keyboardEvent.key !== "Escape") return;
      keyboardEvent.preventDefault();
      cleanupDrag();
      onResize(startWidth);
    }

    clearDragListeners.current = cleanupDrag;
    window.addEventListener("pointermove", previewDrag, true);
    window.addEventListener("pointerup", finishDrag, true);
    window.addEventListener("pointercancel", cancelDrag, true);
    window.addEventListener("keydown", cancelFromKeyboard, true);
  }

  return (
    <hr
      tabIndex={0}
      aria-controls={controls}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={maximumWidth}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      aria-description="Use arrow keys to resize. Drag toward the outside edge to hide."
      data-dragging={dragging || undefined}
      title="Drag to resize · Double-click to reset"
      onDoubleClick={() => onResize(defaultWidth)}
      onKeyDown={handleKeyDown}
      onPointerDown={beginDrag}
      className={cn(
        "before:bg-cyan absolute inset-y-0 z-30 m-0 hidden h-auto w-2 touch-none cursor-col-resize border-0 before:absolute before:top-1/2 before:h-12 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:opacity-0 before:shadow-[0_0_10px_color-mix(in_srgb,var(--app-cyan)_45%,transparent)] before:transition-opacity before:content-[''] hover:before:opacity-70 focus-visible:outline-none focus-visible:before:opacity-100 data-[dragging=true]:before:opacity-100",
        side === "left" ? "right-0 before:right-0" : "left-0 before:left-0",
        className,
      )}
    />
  );
}
