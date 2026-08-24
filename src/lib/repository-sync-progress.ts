/** Durable progress landmarks shared by the repository sync and its UI. */
export const REPOSITORY_SYNC_PROGRESS = {
  fetching: 10,
  listing: 18,
  downloading: 28,
  analyzing: 55,
  storing: 72,
  saving: 88,
  completed: 100,
} as const;

/** Describes the work represented by a persisted repository-sync percentage. */
export function repositorySyncActivity(progress: number) {
  if (progress < REPOSITORY_SYNC_PROGRESS.fetching) return "Waiting to start";
  if (progress < REPOSITORY_SYNC_PROGRESS.listing) return "Resolving branch";
  if (progress < REPOSITORY_SYNC_PROGRESS.downloading)
    return "Loading repository tree";
  if (progress < REPOSITORY_SYNC_PROGRESS.analyzing)
    return "Fetching source files";
  if (progress < REPOSITORY_SYNC_PROGRESS.storing)
    return "Analyzing repository structure";
  if (progress < REPOSITORY_SYNC_PROGRESS.saving)
    return "Storing source snapshot";
  if (progress < REPOSITORY_SYNC_PROGRESS.completed)
    return "Saving review units";
  return "Repository ready";
}
