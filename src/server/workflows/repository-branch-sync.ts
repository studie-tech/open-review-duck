import { and, eq, inArray } from "drizzle-orm";
import { getWorkflowMetadata } from "workflow";
import {
  repositoryBranchMonitors,
  repositoryBranchSyncRuns,
  workflowRuns,
} from "@/drizzle/schema";
import { db } from "~/server/db";
import { ProviderError } from "~/server/providers/types";
import {
  REPOSITORY_SYNC_PROGRESS,
  syncRepositoryBranch,
} from "~/server/repo-reviews/sync";
import { reviewSyncFailureDetails } from "~/server/sync/error";
import { ensureWorkflowRunLink } from "./run-link";

/** Extracts a safe bounded synchronization failure for durable storage. */
function failureText(cause: unknown) {
  if (cause instanceof ProviderError) return cause.message.slice(0, 300);
  if (!(cause instanceof Error)) return "Repository synchronization failed";
  const { message, code } = reviewSyncFailureDetails(cause);
  return (code ? `${message} (${code})` : message).slice(0, 300);
}

/** Durably captures one monitored repository branch. */
export async function repositoryBranchSyncWorkflow(
  syncId: string,
  startToken?: string,
) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  try {
    return await executeRepositoryBranchSync(syncId, workflowRunId, startToken);
  } catch (cause) {
    await recordTerminalFailure(syncId, workflowRunId, failureText(cause));
    throw cause;
  }
}

/** Records a terminal workflow failure that exhausted step retries. */
async function recordTerminalFailure(
  syncId: string,
  providerRunId: string,
  error: string,
) {
  "use step";
  const updatedRuns = await db
    .update(repositoryBranchSyncRuns)
    .set({ status: "failed", error, completedAt: new Date() })
    .where(
      and(
        eq(repositoryBranchSyncRuns.id, syncId),
        inArray(repositoryBranchSyncRuns.status, ["queued", "running"]),
      ),
    )
    .returning({ monitorId: repositoryBranchSyncRuns.monitorId });
  const updatedRun = updatedRuns[0];
  if (updatedRun) {
    await db
      .update(repositoryBranchMonitors)
      .set({ lastCheckedAt: new Date(), lastError: error })
      .where(eq(repositoryBranchMonitors.id, updatedRun.monitorId));
  }
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

/** Executes the idempotent application step behind a repository sync run. */
async function executeRepositoryBranchSync(
  syncId: string,
  providerRunId: string,
  startToken?: string,
) {
  "use step";
  const workflow = await ensureWorkflowRunLink(db, {
    kind: "sync_repository_branch",
    targetId: syncId,
    providerRunId,
    startToken,
  });
  if (!workflow) return { syncId, superseded: true as const };
  const run = await db.query.repositoryBranchSyncRuns.findFirst({
    where: eq(repositoryBranchSyncRuns.id, syncId),
  });
  if (!run) throw new Error("Repository synchronization run not found");
  await db
    .update(repositoryBranchSyncRuns)
    .set({
      status: "running",
      progress: REPOSITORY_SYNC_PROGRESS.fetching,
      error: null,
      startedAt: new Date(),
      completedAt: null,
    })
    .where(eq(repositoryBranchSyncRuns.id, run.id));
  await db
    .update(workflowRuns)
    .set({
      status: "running",
      error: null,
      startedAt: new Date(),
      completedAt: null,
    })
    .where(eq(workflowRuns.id, workflow.id));
  try {
    const result = await syncRepositoryBranch(db, run.monitorId, {
      force: run.force,
      onProgress: async (progress) => {
        await db
          .update(repositoryBranchSyncRuns)
          .set({ progress })
          .where(eq(repositoryBranchSyncRuns.id, run.id));
      },
    });
    await db
      .update(repositoryBranchSyncRuns)
      .set({
        status: "completed",
        progress: REPOSITORY_SYNC_PROGRESS.completed,
        error: null,
        completedAt: new Date(),
      })
      .where(eq(repositoryBranchSyncRuns.id, run.id));
    await db
      .update(workflowRuns)
      .set({ status: "completed", error: null, completedAt: new Date() })
      .where(eq(workflowRuns.id, workflow.id));
    return { ...result, syncId };
  } catch (cause) {
    const error = failureText(cause);
    await db
      .update(repositoryBranchSyncRuns)
      .set({ status: "failed", error, completedAt: new Date() })
      .where(eq(repositoryBranchSyncRuns.id, run.id));
    await db
      .update(repositoryBranchMonitors)
      .set({ lastCheckedAt: new Date(), lastError: error })
      .where(eq(repositoryBranchMonitors.id, run.monitorId));
    await db
      .update(workflowRuns)
      .set({ status: "failed", error, completedAt: new Date() })
      .where(eq(workflowRuns.id, workflow.id));
    throw cause;
  }
}
