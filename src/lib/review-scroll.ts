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
