import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { pullRequests, reviewQueueItems } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { shouldActivateQueueItem } from "./queue-policy";

type Database = typeof database;
export type ReviewQueueSource = "manual" | "assigned" | "all";

/** Adds a synchronized PR to one user's queue without reviving the same removed revision. */
export async function assignPullRequestToQueue(
  db: Database,
  input: {
    pullRequestId: string;
    userId: string;
    source: ReviewQueueSource;
    headSha: string;
    explicit: boolean;
  },
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`review-queue:${input.pullRequestId}:${input.userId}`}))`,
    );
    const existing = await tx.query.reviewQueueItems.findFirst({
      where: and(
        eq(reviewQueueItems.pullRequestId, input.pullRequestId),
        eq(reviewQueueItems.userId, input.userId),
      ),
    });
    if (
      !shouldActivateQueueItem({
        existingState: existing?.state,
        removedHeadSha: existing?.removedHeadSha,
        incomingHeadSha: input.headSha,
        explicit: input.explicit,
      })
    ) {
      return existing;
    }
    const [queueItem] = await tx
      .insert(reviewQueueItems)
      .values({
        pullRequestId: input.pullRequestId,
        userId: input.userId,
        source: input.source,
      })
      .onConflictDoUpdate({
        target: [reviewQueueItems.pullRequestId, reviewQueueItems.userId],
        set: {
          source: input.source,
          state: "active",
          removedAt: null,
          removedHeadSha: null,
        },
      })
      .returning();
    if (!queueItem) throw new Error("Could not assign pull request");
    return queueItem;
  });
}

/** Removes an authorized PR from a user's queue while remembering its revision. */
export async function removePullRequestFromQueue(
  db: Database,
  input: { pullRequestId: string; userId: string },
) {
  const [removed] = await db
    .update(reviewQueueItems)
    .set({
      state: "removed",
      removedAt: new Date(),
      removedHeadSha: pullRequests.headSha,
    })
    .from(pullRequests)
    .where(
      and(
        eq(reviewQueueItems.pullRequestId, input.pullRequestId),
        eq(reviewQueueItems.userId, input.userId),
        eq(pullRequests.id, reviewQueueItems.pullRequestId),
      ),
    )
    .returning({ pullRequestId: reviewQueueItems.pullRequestId });
  return removed;
}

/** Restores a previously removed PR to the user's active queue. */
export async function restorePullRequestToQueue(
  db: Database,
  input: { pullRequestId: string; userId: string },
) {
  const [restored] = await db
    .update(reviewQueueItems)
    .set({
      state: "active",
      removedAt: null,
      removedHeadSha: null,
    })
    .where(
      and(
        eq(reviewQueueItems.pullRequestId, input.pullRequestId),
        eq(reviewQueueItems.userId, input.userId),
      ),
    )
    .returning({ pullRequestId: reviewQueueItems.pullRequestId });
  return restored;
}
