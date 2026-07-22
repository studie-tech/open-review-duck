import { eq, inArray } from "drizzle-orm";
import {
  aiJobs,
  pullRequests,
  repositories,
  reviewComments,
  reviewSessions,
  reviewSnapshots,
  reviewUnitDependencies,
  reviewUnits,
  reviewWaits,
  signOffs,
} from "@/drizzle/schema";
import type { db as database } from "~/server/db";

type Database = typeof database;

/** Exports all repository-scoped review records without credentials or secrets. */
export async function exportRepositoryReviewData(
  db: Database,
  repositoryId: string,
) {
  const repository = await db.query.repositories.findFirst({
    where: eq(repositories.id, repositoryId),
  });
  if (!repository) return undefined;

  const repositoryPullRequests = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.repositoryId, repositoryId));
  const pullRequestIds = repositoryPullRequests.map(({ id }) => id);
  const snapshots = pullRequestIds.length
    ? await db
        .select()
        .from(reviewSnapshots)
        .where(inArray(reviewSnapshots.pullRequestId, pullRequestIds))
    : [];
  const snapshotIds = snapshots.map(({ id }) => id);
  const units = snapshotIds.length
    ? await db
        .select()
        .from(reviewUnits)
        .where(inArray(reviewUnits.snapshotId, snapshotIds))
    : [];
  const unitIds = units.map(({ id }) => id);

  const [dependencies, signOffRecords, comments, waits, sessions, jobs] =
    await Promise.all([
      unitIds.length
        ? db
            .select()
            .from(reviewUnitDependencies)
            .where(inArray(reviewUnitDependencies.unitId, unitIds))
        : [],
      unitIds.length
        ? db.select().from(signOffs).where(inArray(signOffs.unitId, unitIds))
        : [],
      unitIds.length
        ? db
            .select()
            .from(reviewComments)
            .where(inArray(reviewComments.unitId, unitIds))
        : [],
      unitIds.length
        ? db
            .select()
            .from(reviewWaits)
            .where(inArray(reviewWaits.unitId, unitIds))
        : [],
      pullRequestIds.length
        ? db
            .select()
            .from(reviewSessions)
            .where(inArray(reviewSessions.pullRequestId, pullRequestIds))
        : [],
      pullRequestIds.length
        ? db
            .select()
            .from(aiJobs)
            .where(inArray(aiJobs.pullRequestId, pullRequestIds))
        : [],
    ]);

  return {
    exportedAt: new Date(),
    repository,
    pullRequests: repositoryPullRequests,
    snapshots,
    units,
    dependencies,
    signOffs: signOffRecords,
    comments,
    waits,
    sessions,
    aiJobs: jobs,
  };
}
