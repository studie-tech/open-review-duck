import { describe, expect, it } from "vitest";

import {
  initialReviewSessionState,
  reviewSessionReducer,
} from "./review-session-machine";

describe("reviewSessionReducer", () => {
  it("starts a review in the reviewing state", () => {
    expect(initialReviewSessionState).toBe("reviewing");
  });

  it("moves through a synchronization round trip", () => {
    const synchronizing = reviewSessionReducer(initialReviewSessionState, {
      type: "SYNC_STARTED",
    });
    expect(synchronizing).toBe("synchronizing");
    expect(reviewSessionReducer(synchronizing, { type: "SYNC_FINISHED" })).toBe(
      "reviewing",
    );
  });

  it("browses and reopens a completed review", () => {
    const overlay = reviewSessionReducer("reviewing", {
      type: "REVIEW_COMPLETED",
    });
    expect(overlay).toBe("completedOverlay");
    const browsing = reviewSessionReducer(overlay, { type: "REVIEW_BROWSED" });
    expect(browsing).toBe("completedBrowsing");
    expect(reviewSessionReducer(browsing, { type: "REVIEW_REOPENED" })).toBe(
      "reviewing",
    );
  });

  it("synchronizes from either completed state", () => {
    expect(
      reviewSessionReducer("completedOverlay", { type: "SYNC_STARTED" }),
    ).toBe("synchronizing");
    expect(
      reviewSessionReducer("completedBrowsing", { type: "SYNC_STARTED" }),
    ).toBe("synchronizing");
  });

  it("holds the state for events the state does not accept", () => {
    expect(reviewSessionReducer("reviewing", { type: "SYNC_FINISHED" })).toBe(
      "reviewing",
    );
    expect(
      reviewSessionReducer("synchronizing", { type: "REVIEW_BROWSED" }),
    ).toBe("synchronizing");
    expect(
      reviewSessionReducer("completedBrowsing", { type: "REVIEW_COMPLETED" }),
    ).toBe("completedBrowsing");
  });
});
