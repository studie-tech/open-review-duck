export interface ReviewQueueItemShape {
  queueState: "active" | "removed";
  state: "open" | "draft" | "merged" | "closed";
  signedUnits: number;
  totalUnits: number;
}

/** Separates inbox work from reviewed, provider-closed, and user-removed history. */
export function partitionReviewQueue<T extends ReviewQueueItemShape>(
  pullRequests: T[],
) {
  return {
    needsReview: pullRequests.filter(
      (pullRequest) =>
        pullRequest.queueState === "active" &&
        (pullRequest.state === "open" || pullRequest.state === "draft") &&
        (pullRequest.totalUnits === 0 ||
          pullRequest.signedUnits < pullRequest.totalUnits),
    ),
    reviewed: pullRequests.filter(
      (pullRequest) =>
        pullRequest.queueState === "active" &&
        (pullRequest.state === "open" || pullRequest.state === "draft") &&
        pullRequest.totalUnits > 0 &&
        pullRequest.signedUnits >= pullRequest.totalUnits,
    ),
    closed: pullRequests.filter(
      (pullRequest) =>
        pullRequest.state === "merged" || pullRequest.state === "closed",
    ),
    removed: pullRequests.filter(
      (pullRequest) =>
        pullRequest.queueState === "removed" &&
        (pullRequest.state === "open" || pullRequest.state === "draft"),
    ),
  };
}
