export interface VerticalRange {
  top: number;
  bottom: number;
}

export interface LeadingContextState {
  atPhysicalBoundary: boolean;
  unitStartVisible: boolean;
  sideBySideVisible: boolean;
  contextAvailable: boolean;
  contextBefore: number;
  availableBefore: number;
}

const DEFAULT_CONTEXT_SCROLL_STEP = 72;

/** Reports whether an inner vertical range intersects its viewport. */
export function verticalRangesOverlap(
  viewport: VerticalRange,
  inner: VerticalRange,
) {
  return inner.bottom >= viewport.top && inner.top <= viewport.bottom;
}

/** Decides when Arrow Up should reveal source context before the review unit. */
export function shouldRevealLeadingContext({
  atPhysicalBoundary,
  unitStartVisible,
  sideBySideVisible,
  contextAvailable,
  contextBefore,
  availableBefore,
}: LeadingContextState) {
  return (
    !sideBySideVisible &&
    contextAvailable &&
    contextBefore < availableBefore &&
    (atPhysicalBoundary || unitStartVisible)
  );
}

/**
 * Chooses the post-reveal scroll offset so newly disclosed context is entered
 * in the same direction without yanking existing lines around.
 */
export function scrollTopAfterContextReveal({
  direction,
  previousScrollTop,
  previousScrollHeight,
  nextScrollHeight,
  viewportHeight,
  step = DEFAULT_CONTEXT_SCROLL_STEP,
}: {
  direction: -1 | 1;
  previousScrollTop: number;
  previousScrollHeight: number;
  nextScrollHeight: number;
  viewportHeight: number;
  step?: number;
}) {
  const addedHeight = Math.max(0, nextScrollHeight - previousScrollHeight);
  const maxScroll = Math.max(0, nextScrollHeight - viewportHeight);
  if (nextScrollHeight < previousScrollHeight) {
    // Content deshrank (e.g. temporary layout). Stay put without leaping upward.
    return Math.min(previousScrollTop, maxScroll);
  }
  if (addedHeight === 0) {
    return Math.max(
      0,
      Math.min(maxScroll, previousScrollTop + direction * step),
    );
  }
  // Enter roughly a third of the viewport into the new content, never past it.
  const enterBy = Math.min(
    addedHeight,
    Math.max(step, Math.floor(viewportHeight * 0.35)),
  );
  if (direction === -1) {
    // Content was prepended: keep the previous top pinned, then peek upward.
    return Math.max(
      0,
      Math.min(maxScroll, previousScrollTop + addedHeight - enterBy),
    );
  }
  // Content was appended: keep previous lines put, then peek downward.
  return Math.min(maxScroll, previousScrollTop + enterBy);
}

/** Waits until layout settles after a reactive expand, then runs the callback. */
export function afterLayoutSettle(
  measure: () => number,
  previousValue: number,
  onSettle: () => void,
  maximumFrames = 12,
) {
  let frames = 0;
  /** Checks whether the reactive layout has changed or exhausted its frame budget. */
  const tick = () => {
    frames += 1;
    if (measure() !== previousValue || frames >= maximumFrames) {
      onSettle();
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
