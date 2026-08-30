export type ReviewSessionState =
  | "reviewing"
  | "synchronizing"
  | "completedOverlay"
  | "completedBrowsing";

export type ReviewSessionEvent =
  | { type: "SYNC_STARTED" }
  | { type: "SYNC_FINISHED" }
  | { type: "REVIEW_COMPLETED" }
  | { type: "REVIEW_BROWSED" }
  | { type: "REVIEW_REOPENED" };

export const initialReviewSessionState: ReviewSessionState = "reviewing";

/** Owns review lifecycle transitions; server and view state stay outside. */
const reviewSessionTransitions: Record<
  ReviewSessionState,
  Partial<Record<ReviewSessionEvent["type"], ReviewSessionState>>
> = {
  reviewing: {
    SYNC_STARTED: "synchronizing",
    REVIEW_COMPLETED: "completedOverlay",
  },
  synchronizing: {
    SYNC_FINISHED: "reviewing",
    REVIEW_COMPLETED: "completedOverlay",
  },
  completedOverlay: {
    REVIEW_BROWSED: "completedBrowsing",
    REVIEW_REOPENED: "reviewing",
    SYNC_STARTED: "synchronizing",
  },
  completedBrowsing: {
    REVIEW_REOPENED: "reviewing",
    SYNC_STARTED: "synchronizing",
  },
};

/** Advances the session, holding the state when it ignores the event. */
export function reviewSessionReducer(
  state: ReviewSessionState,
  event: ReviewSessionEvent,
): ReviewSessionState {
  return reviewSessionTransitions[state][event.type] ?? state;
}
