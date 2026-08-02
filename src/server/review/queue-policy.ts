/** Decides whether an incoming sync may reactivate a removed queue item. */
export function shouldActivateQueueItem(input: {
  existingState?: "active" | "removed";
  removedHeadSha?: string | null;
  incomingHeadSha: string;
  explicit: boolean;
}) {
  return (
    input.existingState !== "removed" ||
    input.explicit ||
    input.removedHeadSha !== input.incomingHeadSha
  );
}
