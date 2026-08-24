const REVIEW_REVISION_STORAGE_PREFIX = "reviewduck:review-revision";
const REVIEW_POSITION_STORAGE_PREFIX = "reviewduck:review-position";

export interface ReviewRevision {
  headSha: string;
  snapshotId: string;
  version: number;
}

interface ReviewPosition {
  snapshotId: string;
  unitId: string;
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

/** Reads the last unit the reviewer viewed on one immutable snapshot. */
export function rememberedReviewPosition(
  storage: Pick<Storage, "getItem">,
  pullRequestId: string,
  snapshotId: string,
) {
  try {
    const stored = storage.getItem(
      `${REVIEW_POSITION_STORAGE_PREFIX}:${pullRequestId}`,
    );
    if (!stored) return undefined;
    const position = JSON.parse(stored) as Partial<ReviewPosition>;
    return position.snapshotId === snapshotId &&
      typeof position.unitId === "string"
      ? position.unitId
      : undefined;
  } catch {
    return undefined;
  }
}

/** Remembers the exact unit where review should resume on this snapshot. */
export function rememberReviewPosition(
  storage: Pick<Storage, "setItem">,
  pullRequestId: string,
  snapshotId: string,
  unitId: string,
) {
  try {
    storage.setItem(
      `${REVIEW_POSITION_STORAGE_PREFIX}:${pullRequestId}`,
      JSON.stringify({ snapshotId, unitId } satisfies ReviewPosition),
    );
  } catch {
    // Browser privacy settings can make local storage unavailable.
  }
}

/** Shortens a source revision for compact, unambiguous UI copy. */
export function shortRevision(sha: string) {
  return sha.slice(0, 7);
}
