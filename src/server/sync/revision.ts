/** Checks whether provider metadata represents a new pull-request revision. */
export function pullRequestRevisionChanged(
  current: { headSha: string; baseSha: string },
  remote: { headSha: string; baseSha: string },
) {
  return (
    current.headSha !== remote.headSha || current.baseSha !== remote.baseSha
  );
}

/** Checks whether a persisted review was produced by the active analyzer. */
export function reviewAnalysisNeedsRefresh(
  persistedAnalysisVersion: number | null | undefined,
  currentAnalysisVersion: number,
) {
  return persistedAnalysisVersion !== currentAnalysisVersion;
}

/** Checks whether a prepared snapshot can satisfy a metadata-only synchronization. */
export function reviewSnapshotCanBeReused(
  snapshot: {
    analysisVersion: number;
    baseSha: string;
    createdAt: Date;
    headSha: string;
  },
  remote: { baseSha: string; headSha: string },
  currentAnalysisVersion: number,
  retentionCutoff: Date,
) {
  return (
    snapshot.headSha === remote.headSha &&
    snapshot.baseSha === remote.baseSha &&
    snapshot.analysisVersion === currentAnalysisVersion &&
    snapshot.createdAt >= retentionCutoff
  );
}

/** Rejects partial provider responses before they can become review snapshots. */
export function assertCompleteChangedFileSet(
  remote: {
    additions: number;
    deletions: number;
    changedFiles: number;
  },
  receivedFileCount: number,
) {
  if (
    (remote.changedFiles > 0 && receivedFileCount < remote.changedFiles) ||
    (receivedFileCount === 0 && remote.additions + remote.deletions > 0)
  ) {
    throw new Error(
      `The provider returned ${receivedFileCount} of ${remote.changedFiles || "an unknown number of"} changed files; refusing to prepare an incomplete review`,
    );
  }
}
