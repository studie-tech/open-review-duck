import { eq } from "drizzle-orm";
import { syncQueueRequests, syncRuns, workflowRuns } from "@/drizzle/schema";
import { db } from "~/server/db";
import { assignPullRequestToQueue } from "~/server/review/queue";
import { syncPullRequest } from "~/server/sync/service";

/** Durably synchronizes one pull request using identifier-only workflow state. */
export async function syncPullRequestWorkflow(syncId: string) {
  "use workflow";
  return executeSynchronization(syncId);
}

/** Runs one coarse, idempotent synchronization step from persisted identity. */
async function executeSynchronization(syncId: string) {
  "use step";
  const sync = await db.query.syncRuns.findFirst({
    where: eq(syncRuns.id, syncId),
  });
  if (!sync) throw new Error("Synchronization run not found");
  await db
    .update(syncRuns)
    .set({ status: "running", progress: 5, startedAt: new Date() })
    .where(eq(syncRuns.id, sync.id));
  if (sync.workflowRunId) {
    await db
      .update(workflowRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(workflowRuns.id, sync.workflowRunId));
  }
  try {
    const result = await syncPullRequest(
      db,
      sync.repositoryId,
      sync.pullRequestNumber,
    );
    const queueRequests = await db.query.syncQueueRequests.findMany({
      where: eq(syncQueueRequests.syncRunId, sync.id),
    });
    for (const request of queueRequests) {
      await assignPullRequestToQueue(db, {
        pullRequestId: result.pullRequest.id,
        userId: request.userId,
        source: request.source,
        headSha: result.pullRequest.headSha,
        explicit: request.explicit,
      });
    }
    await db
      .update(syncRuns)
      .set({ status: "completed", progress: 100, completedAt: new Date() })
      .where(eq(syncRuns.id, sync.id));
    if (sync.workflowRunId) {
      await db
        .update(workflowRuns)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(workflowRuns.id, sync.workflowRunId));
    }
    return {
      snapshotCreated: result.snapshotCreated,
      snapshotId: result.snapshot.id,
      syncId,
      unitCount: result.unitCount,
    };
  } catch (cause) {
    const error =
      cause instanceof Error ? cause.message : "Synchronization failed";
    await db
      .update(syncRuns)
      .set({ status: "failed", error, completedAt: new Date() })
      .where(eq(syncRuns.id, sync.id));
    if (sync.workflowRunId) {
      await db
        .update(workflowRuns)
        .set({ status: "failed", error, completedAt: new Date() })
        .where(eq(workflowRuns.id, sync.workflowRunId));
    }
    throw cause;
  }
}
