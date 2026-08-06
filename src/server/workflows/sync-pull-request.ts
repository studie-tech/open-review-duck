import { and, eq, inArray } from "drizzle-orm";
import { getWorkflowMetadata } from "workflow";
import { syncQueueRequests, syncRuns, workflowRuns } from "@/drizzle/schema";
import { SYNC_PROGRESS } from "~/lib/sync-progress";
import { db } from "~/server/db";
import { assignPullRequestToQueue } from "~/server/review/queue";
import { syncPullRequest } from "~/server/sync/service";
import { ensureWorkflowRunLink } from "./run-link";

/** Durably synchronizes one pull request using identifier-only workflow state. */
export async function syncPullRequestWorkflow(syncId: string) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  try {
    return await executeSynchronization(syncId, workflowRunId);
  } catch (cause) {
    const error =
      cause instanceof Error ? cause.message : "Synchronization failed";
    await recordTerminalSynchronizationFailure(syncId, workflowRunId, error);
    throw cause;
  }
}

/** Records a workflow-level failure when a step exhausts retries without re-entering application code. */
async function recordTerminalSynchronizationFailure(
  syncId: string,
  providerRunId: string,
  error: string,
) {
  "use step";
  await db
    .update(syncRuns)
    .set({ status: "failed", error, completedAt: new Date() })
    .where(
      and(
        eq(syncRuns.id, syncId),
        inArray(syncRuns.status, ["queued", "running"]),
      ),
    );
  await db
    .update(workflowRuns)
    .set({ status: "failed", error, completedAt: new Date() })
    .where(
      and(
        eq(workflowRuns.providerRunId, providerRunId),
        inArray(workflowRuns.status, ["queued", "running"]),
      ),
    );
}

/** Runs one coarse, idempotent synchronization step from persisted identity. */
async function executeSynchronization(syncId: string, providerRunId: string) {
  "use step";
  const workflow = await ensureWorkflowRunLink(db, {
    kind: "sync_pull_request",
    targetId: syncId,
    providerRunId,
  });
  const sync = await db.query.syncRuns.findFirst({
    where: eq(syncRuns.id, syncId),
  });
  if (!sync) throw new Error("Synchronization run not found");
  await db
    .update(syncRuns)
    .set({
      status: "running",
      progress: SYNC_PROGRESS.fetching,
      startedAt: new Date(),
    })
    .where(eq(syncRuns.id, sync.id));
  await db
    .update(workflowRuns)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(workflowRuns.id, workflow.id));
  try {
    const result = await syncPullRequest(
      db,
      sync.repositoryId,
      sync.pullRequestNumber,
      {
        onProgress: async (progress) => {
          await db
            .update(syncRuns)
            .set({ progress })
            .where(eq(syncRuns.id, sync.id));
        },
      },
    );
    await db
      .update(syncRuns)
      .set({ progress: SYNC_PROGRESS.addingToQueue })
      .where(eq(syncRuns.id, sync.id));
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
      .set({
        status: "completed",
        progress: SYNC_PROGRESS.completed,
        completedAt: new Date(),
      })
      .where(eq(syncRuns.id, sync.id));
    await db
      .update(workflowRuns)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(workflowRuns.id, workflow.id));
    await continueAutomaticIntake(sync);
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
    await db
      .update(workflowRuns)
      .set({ status: "failed", error, completedAt: new Date() })
      .where(eq(workflowRuns.id, workflow.id));
    await continueAutomaticIntake(sync);
    throw cause;
  }
}

/** Starts the next eligible automatic review without retrying the failed head of a backlog. */
async function continueAutomaticIntake(sync: {
  workspaceId: string;
  repositoryId: string;
}) {
  try {
    const { reconcileRepositoryIntake } = await import(
      "~/server/providers/intake"
    );
    await reconcileRepositoryIntake(db, {
      workspaceId: sync.workspaceId,
      repositoryId: sync.repositoryId,
      force: true,
      retryFailed: false,
    });
  } catch {
    // Intake stores a safe diagnostic on the repository. A follow-up failure
    // must not change the terminal result of the synchronization just handled.
  }
}
