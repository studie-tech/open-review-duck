import { asc, eq, inArray, sql } from "drizzle-orm";
import { pullRequests, repositories, reviewSnapshots } from "@/drizzle/schema";
import type { db as database } from "~/server/db";

type Database = typeof database;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

interface SnapshotRetentionCandidate {
  id: string;
  createdAt: Date;
}

/** Selects snapshots outside either retention boundary, preserving an active snapshot. */
export function expiredSnapshotIds(
  snapshots: SnapshotRetentionCandidate[],
  input: {
    retentionDays: number;
    retentionSnapshots: number;
    retainedSnapshotId?: string;
    now?: Date;
  },
) {
  const cutoff = new Date(
    (input.now ?? new Date()).getTime() - input.retentionDays * 86_400_000,
  );
  const countExpired = new Set(
    snapshots
      .slice(0, Math.max(0, snapshots.length - input.retentionSnapshots))
      .map(({ id }) => id),
  );
  return snapshots.flatMap((snapshot) =>
    snapshot.id !== input.retainedSnapshotId &&
    (snapshot.createdAt < cutoff || countExpired.has(snapshot.id))
      ? [snapshot.id]
      : [],
  );
}

/** Prunes one pull request using its repository's age and count boundaries. */
async function prunePullRequestSnapshots(
  tx: Transaction,
  input: {
    pullRequestId: string;
    retentionDays: number;
    retentionSnapshots: number;
    retainedSnapshotId?: string;
  },
) {
  const snapshots = await tx.query.reviewSnapshots.findMany({
    where: eq(reviewSnapshots.pullRequestId, input.pullRequestId),
    orderBy: [asc(reviewSnapshots.createdAt)],
  });
  const expiredIds = expiredSnapshotIds(snapshots, input);
  if (expiredIds.length > 0) {
    await tx
      .delete(reviewSnapshots)
      .where(inArray(reviewSnapshots.id, expiredIds));
  }
  return expiredIds.length;
}

/** Sweeps expired source snapshots for every repository or one selected repository. */
export async function pruneExpiredReviewSnapshots(
  db: Database,
  repositoryId?: string,
) {
  const scopes = await db
    .select({
      repositoryId: repositories.id,
      pullRequestId: pullRequests.id,
      pullRequestNumber: pullRequests.number,
      retentionDays: repositories.sourceRetentionDays,
      retentionSnapshots: repositories.sourceRetentionSnapshots,
    })
    .from(repositories)
    .innerJoin(pullRequests, eq(pullRequests.repositoryId, repositories.id))
    .where(repositoryId ? eq(repositories.id, repositoryId) : undefined);
  let deleted = 0;
  for (const scope of scopes) {
    deleted += await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${scope.repositoryId}:${scope.pullRequestNumber}`}))`,
      );
      return prunePullRequestSnapshots(tx, scope);
    });
  }
  return deleted;
}
