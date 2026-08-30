/** Polls while at least one durable pull-request job is still running. */
export function followActiveReviewJobs(query: {
  state: { data?: readonly unknown[] };
}) {
  return (query.state.data?.length ?? 0) > 0 ? 1_500 : false;
}

export const SYNC_PROGRESS = {
  queued: 0,
  fetching: 10,
  analyzing: 35,
  storingSources: 60,
  savingSnapshot: 85,
  addingToQueue: 95,
  completed: 100,
} as const;

/** Describes the durable synchronization phase represented by a progress value. */
export function syncProgressLabel(status: string, progress: number) {
  if (status === "queued") return "Waiting to start";
  if (status === "completed") return "Ready for review";
  if (status === "failed") return "Could not prepare review";
  if (status === "cancelled") return "Synchronization cancelled";
  if (progress < SYNC_PROGRESS.analyzing) {
    return "Fetching pull request and changed files";
  }
  if (progress < SYNC_PROGRESS.storingSources) {
    return "Analyzing the dependency path";
  }
  if (progress < SYNC_PROGRESS.savingSnapshot) {
    return "Saving private source files";
  }
  if (progress < SYNC_PROGRESS.addingToQueue) {
    return "Saving the review snapshot";
  }
  return "Adding the review to your queue";
}
