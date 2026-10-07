import { and, eq, inArray, sql } from "drizzle-orm";
import { getWorkflowMetadata } from "workflow";
import { syncQueueRequests, syncRuns, workflowRuns } from "@/drizzle/schema";
import { SYNC_PROGRESS } from "~/lib/sync-progress";
import { db } from "~/server/db";
import { ProviderError } from "~/server/providers/types";
import { assignPullRequestToQueue } from "~/server/review/queue";
import { reviewSyncFailureDetails } from "~/server/sync/error";
import {
  cleanupPullRequestSources,
  syncPullRequest,
} from "~/server/sync/service";
import { ensureWorkflowRunLink } from "./run-link";

/**
 * Names the failure a run ended on without keeping the query that carried it.
 *
 * A rejected statement arrives wrapped in an error whose message is the whole
 * statement and every value bound to it: private source, at a size the column
 * recording it was never meant to hold. The cause underneath that wrapper is
 * the part that says what actually went wrong, and it is the part a reviewer's
 * guidance can be read from. A provider failure already arrives named and
 * bounded, and the status it carries is what that guidance turns on, so it is
 * kept exactly as the provider stated it.
 */
function synchronizationFailureText(cause: unknown) {
  if (cause instanceof ProviderError) return cause.message.slice(0, 300);
  if (!(cause instanceof Error)) return "Synchronization failed";
  const { message, code } = reviewSyncFailureDetails(cause);
  return code ? `${message} (${code})` : message;
}

/** Durably synchronizes one pull request using identifier-only workflow state. */
export async function syncPullRequestWorkflow(
  syncId: string,
  startToken?: string,
) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  try {
    const result = await executeSynchronization(
      syncId,
      workflowRunId,
      startToken,
    );
    if (!("superseded" in result))
      await finishSynchronizationMaintenance(syncId);
    return result;
  } catch (cause) {
    await recordTerminalSynchronizationFailure(
      syncId,
      workflowRunId,
      synchronizationFailureText(cause),
    );
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
  const sync = await db.query.syncRuns.findFirst({
    where: eq(syncRuns.id, syncId),
  });
  if (sync) await continueAutomaticIntake(sync);
}

/** Runs one coarse, idempotent synchronization step from persisted identity. */
async function executeSynchronization(
  syncId: string,
  providerRunId: string,
  startToken?: string,
) {
  "use step";
  const workflow = await ensureWorkflowRunLink(db, {
    kind: "sync_pull_request",
    targetId: syncId,
    providerRunId,
    startToken,
  });
  if (!workflow) return { syncId, superseded: true as const };
  const sync = await db.query.syncRuns.findFirst({
    where: eq(syncRuns.id, syncId),
  });
  if (!sync) throw new Error("Synchronization run not found");
  if (sync.status === "completed") {
    // A worker can die between the two status writes. Reentering the step
    // repairs its mirror without publishing or downloading the source again.
    await db
      .update(workflowRuns)
      .set({ status: "completed", completedAt: sync.completedAt ?? new Date() })
      .where(eq(workflowRuns.id, workflow.id));
    return {
      syncId,
      snapshotId: sync.resultSnapshotId,
      snapshotCreated: sync.snapshotCreated,
    };
  }
  if (sync.status === "failed" || sync.status === "cancelled")
    return { syncId, superseded: true as const };
  const started = await db
    .update(syncRuns)
    .set({
      status: "running",
      progress: SYNC_PROGRESS.fetching,
      startedAt: sync.startedAt ?? new Date(),
      attempt: sql`${syncRuns.attempt} + 1`,
      error: null,
    })
    .where(
      and(
        eq(syncRuns.id, sync.id),
        inArray(syncRuns.status, ["queued", "running"]),
      ),
    )
    .returning();
  if (!started.length) return { syncId, superseded: true as const };
  await db
    .update(workflowRuns)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(workflowRuns.id, workflow.id));
  let requestVersion = sync.requestVersion;
  let verifySources = sync.verifySources;
  let result: Awaited<ReturnType<typeof syncPullRequest>> | undefined;
  // Bounded draining coalesces pushes; completed source and extraction are
  // private durable checkpoints, so another pass fetches only cache misses.
  for (let pass = 0; pass < 4; pass++) {
    result = await syncPullRequest(
      db,
      sync.repositoryId,
      sync.pullRequestNumber,
      {
        deferRetention: true,
        confirmLatest: true,
        verifySources,
        onMetrics: async (metrics) => {
          await db
            .update(syncRuns)
            .set({ metrics })
            .where(eq(syncRuns.id, sync.id));
        },
        onProgress: async (progress) => {
          await db
            .update(syncRuns)
            .set({ progress })
            .where(eq(syncRuns.id, sync.id));
        },
      },
    );
    const latest = await db.query.syncRuns.findFirst({
      where: eq(syncRuns.id, syncId),
    });
    if (latest?.requestVersion === requestVersion) break;
    requestVersion = latest?.requestVersion ?? requestVersion;
    verifySources = latest?.verifySources ?? verifySources;
    if (pass === 3)
      throw new Error(
        "New updates arrived during synchronization; retrying the latest revision",
      );
  }
  if (!result) throw new Error("Synchronization produced no result");
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
  const completed = await db
    .update(syncRuns)
    .set({
      status: "completed",
      progress: SYNC_PROGRESS.completed,
      completedAt: new Date(),
      resultSnapshotId: result.snapshot.id,
      snapshotCreated: result.snapshotCreated,
    })
    // A request racing the last metadata check must keep this owner active.
    .where(
      and(
        eq(syncRuns.id, sync.id),
        eq(syncRuns.requestVersion, requestVersion),
        eq(syncRuns.status, "running"),
      ),
    )
    .returning();
  if (!completed.length)
    throw new Error("A newer synchronization request is pending");
  await db
    .update(workflowRuns)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(workflowRuns.id, workflow.id));
  return {
    snapshotCreated: result.snapshotCreated,
    snapshotId: result.snapshot.id,
    syncId,
    unitCount: result.unitCount,
  };
}

/** Runs maintenance separately so its retries never replay source publication. */
async function finishSynchronizationMaintenance(syncId: string) {
  "use step";
  const sync = await db.query.syncRuns.findFirst({
    where: eq(syncRuns.id, syncId),
  });
  if (!sync) return;
  await cleanupPullRequestSources(db, sync.repositoryId);
  await continueAutomaticIntake(sync);
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
