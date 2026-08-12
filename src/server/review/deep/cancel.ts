import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { aiJobs, aiReviewItems } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { type DeepReviewFinalizeResult, finalizeDeepReview } from "./finalize";

type Database = typeof database;

/** The statuses a child can still be cancelled out of. */
const LIVE_JOB_STATUSES = [
  "queued",
  "running",
  "waiting_for_provider",
  "streaming",
] as const;

const CANCELLED_ITEM_REASON =
  "The review was cancelled before this file was reviewed.";

/**
 * Closes a cancelled deep-review tree so its coverage partition stays honest.
 *
 * Cancelling the parent kills the workflow mid-run, so nothing else will ever
 * sweep the tree: without this, every child stays live and every item stays
 * `selected`, leaving the run permanently non-terminal. Call this *before*
 * settling the parent's quota — `settleAiJobQuota` is one-shot on
 * `quotaSettledAt`, so a settle that runs first would record a cancelled run's
 * child tokens as zero.
 */
export async function cancelDeepReviewTree(
  db: Database,
  parentJobId: string,
): Promise<DeepReviewFinalizeResult> {
  await db.transaction(async (tx) => {
    // One writer per tree: the sweep and the item transition have to agree on
    // what was still live, and a concurrent finalize must not interleave.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`deep-review:cancel:${parentJobId}`}))`,
    );
    const now = new Date();
    await tx
      .update(aiJobs)
      .set({
        status: "cancelled",
        completionReason: "cancelled",
        cancelledAt: now,
        completedAt: now,
      })
      .where(
        and(
          eq(aiJobs.parentJobId, parentJobId),
          inArray(aiJobs.status, [...LIVE_JOB_STATUSES]),
        ),
      );
    await tx
      .update(aiReviewItems)
      .set({
        state: "failed",
        failureClass: "cancelled",
        reason: CANCELLED_ITEM_REASON,
      })
      .where(
        and(
          eq(aiReviewItems.parentJobId, parentJobId),
          eq(aiReviewItems.state, "selected"),
        ),
      );
  });
  return await finalizeDeepReview(db, parentJobId, {
    runFailure: { failureClass: "cancelled", cause: CANCELLED_ITEM_REASON },
  });
}

/**
 * Reports whether the run owning a job has been cancelled.
 *
 * Children carry no `workflowRunId`, so cancellation only ever lands on the
 * parent row: a child that checked its own row would keep spending through a
 * cancelled run. A child id resolves parent-ward, so callers can pass either.
 */
export async function deepReviewIsCancelled(
  db: Database,
  jobId: string,
): Promise<boolean> {
  const job = await db.query.aiJobs.findFirst({
    columns: { id: true, parentJobId: true, status: true, cancelledAt: true },
    where: eq(aiJobs.id, jobId),
  });
  if (!job) return true;
  if (!job.parentJobId) return isCancelledJob(job);
  const parent = await db.query.aiJobs.findFirst({
    columns: { status: true, cancelledAt: true },
    where: eq(aiJobs.id, job.parentJobId),
  });
  // A missing parent means the tree was pruned underneath the child, which is
  // as good a reason to stop spending as an explicit cancellation.
  if (!parent) return true;
  return isCancelledJob(parent) || isCancelledJob(job);
}

/** Reads cancellation from either marker a cancelled job row can carry. */
function isCancelledJob(job: {
  status: string;
  cancelledAt: Date | null;
}): boolean {
  return job.cancelledAt !== null || job.status === "cancelled";
}
