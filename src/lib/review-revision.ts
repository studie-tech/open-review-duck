const REVIEW_REVISION_STORAGE_PREFIX = "reviewduck:review-revision";

export interface ReviewRevision {
  headSha: string;
  snapshotId: string;
  version: number;
}

/** Reads the last source revision that the reviewer acknowledged for a PR. */
export function acknowledgedReviewRevision(
  storage: Pick<Storage, "getItem">,
  pullRequestId: string,
) {
  try {
    const stored = storage.getItem(
      `${REVIEW_REVISION_STORAGE_PREFIX}:${pullRequestId}`,
    );
    if (!stored) return undefined;
    const revision = JSON.parse(stored) as Partial<ReviewRevision>;
    if (
      typeof revision.headSha !== "string" ||
      typeof revision.snapshotId !== "string" ||
      typeof revision.version !== "number"
    ) {
      return undefined;
    }
    return revision as ReviewRevision;
  } catch {
    return undefined;
  }
}

/** Remembers the source revision whose review transition was acknowledged. */
export function acknowledgeReviewRevision(
  storage: Pick<Storage, "setItem">,
  pullRequestId: string,
  revision: ReviewRevision,
) {
  try {
    storage.setItem(
      `${REVIEW_REVISION_STORAGE_PREFIX}:${pullRequestId}`,
      JSON.stringify(revision),
    );
  } catch {
    // Browser privacy settings can make local storage unavailable.
  }
}

/** Shortens a source revision for compact, unambiguous UI copy. */
export function shortRevision(sha: string) {
  return sha.slice(0, 7);
}
