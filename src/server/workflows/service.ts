import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getRun, start } from "workflow/api";
import {
  aiJobs,
  repositories,
  syncQueueRequests,
  syncRuns,
  workflowRuns,
} from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import type { ReviewQueueSource } from "~/server/review/queue";
import { aiJobWorkflow } from "./ai-job";
import { pullRequestReviewWorkflow } from "./pull-request-review";
import { ensureWorkflowRunLink } from "./run-link";
import { syncPullRequestWorkflow } from "./sync-pull-request";

type Database = typeof database;

/** Starts an idempotent durable pull-request synchronization. */
export async function startPullRequestSync(
  db: Database,
  input: {
    workspaceId: string;
    repositoryId: string;
    pullRequestNumber: number;
    queue?: {
      userId: string;
      source: ReviewQueueSource;
      explicit: boolean;
    };
  },
) {
  const reservation = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`sync-workflow:${input.repositoryId}:${input.pullRequestNumber}`}))`,
    );
    const repository = await tx.query.repositories.findFirst({
      where: and(
        eq(repositories.id, input.repositoryId),
        eq(repositories.workspaceId, input.workspaceId),
      ),
    });
    if (!repository) throw new Error("Repository not found");
    const active = await tx.query.syncRuns.findFirst({
      where: and(
        eq(syncRuns.repositoryId, input.repositoryId),
        eq(syncRuns.pullRequestNumber, input.pullRequestNumber),
        inArray(syncRuns.status, ["queued", "running"]),
      ),
      orderBy: [desc(syncRuns.createdAt)],
    });
    if (active && input.queue) {
      await tx
        .insert(syncQueueRequests)
        .values({
          syncRunId: active.id,
          userId: input.queue.userId,
          source: input.queue.source,
          explicit: input.queue.explicit,
        })
        .onConflictDoUpdate({
          target: [syncQueueRequests.syncRunId, syncQueueRequests.userId],
          set: {
            source: input.queue.source,
            explicit: input.queue.explicit,
          },
        });
    }
    if (active?.workflowRunId) {
      const workflow = await tx.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, active.workflowRunId),
      });
      if (workflow) {
        return {
          shouldStart: false as const,
          status: active.status,
          syncId: active.id,
          workflowRunId: workflow.providerRunId,
        };
      }
    }
    if (active) {
      return {
        shouldStart: false as const,
        status: active.status,
        syncId: active.id,
        workflowRunId: null,
      };
    }
    const [sync] = await tx
      .insert(syncRuns)
      .values({
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId,
        pullRequestNumber: input.pullRequestNumber,
      })
      .returning();
    if (!sync) throw new Error("Could not create synchronization run");
    if (input.queue) {
      await tx.insert(syncQueueRequests).values({
        syncRunId: sync.id,
        userId: input.queue.userId,
        source: input.queue.source,
        explicit: input.queue.explicit,
      });
    }
    return {
      shouldStart: true as const,
      status: "queued" as const,
      syncId: sync.id,
      workflowRunId: null,
    };
  });

  if (!reservation.shouldStart) {
    const workflowRunId =
      reservation.workflowRunId ??
      (await waitForWorkflowLink(db, "sync_pull_request", reservation.syncId));
    return {
      status: reservation.status,
      syncId: reservation.syncId,
      workflowRunId,
    };
  }

  let run: Awaited<ReturnType<typeof start>>;
  try {
    run = await start(syncPullRequestWorkflow, [reservation.syncId]);
  } catch (cause) {
    await db
      .update(syncRuns)
      .set({
        status: "failed",
        error: cause instanceof Error ? cause.message : "Workflow start failed",
        completedAt: new Date(),
      })
      .where(
        and(eq(syncRuns.id, reservation.syncId), eq(syncRuns.status, "queued")),
      );
    throw cause;
  }
  await ensureWorkflowRunLink(db, {
    kind: "sync_pull_request",
    targetId: reservation.syncId,
    providerRunId: run.runId,
  });
  return {
    status: reservation.status,
    syncId: reservation.syncId,
    workflowRunId: run.runId,
  };
}

/** Starts one AI workflow exactly once and links its durable run to the job. */
export async function startAiJob(db: Database, jobId: string) {
  const reservation = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`ai-workflow:${jobId}`}))`,
    );
    const job = await tx.query.aiJobs.findFirst({
      where: eq(aiJobs.id, jobId),
    });
    if (!job) throw new Error("AI job not found");
    if (job.workflowRunId) {
      const existing = await tx.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, job.workflowRunId),
      });
      if (!existing) throw new Error("AI workflow link is invalid");
      return {
        shouldStart: false as const,
        jobId,
        workflowRunId: existing.providerRunId,
      };
    }
    if (job.status === "waiting_for_provider") {
      return {
        shouldStart: false as const,
        jobId,
        workflowRunId: null,
      };
    }
    if (job.status !== "queued") {
      throw new Error(`Cannot start an AI job in ${job.status} state`);
    }
    await tx
      .update(aiJobs)
      .set({ status: "waiting_for_provider" })
      .where(eq(aiJobs.id, job.id));
    return {
      shouldStart: true as const,
      jobId,
      workflowRunId: null,
      // A deep review keeps the parent's identity exactly as the read paths
      // already hardcode it, so the pair is the discriminator rather than a
      // new column: a whole-pull-request review carries no unit.
      isDeepReview: job.kind === "review" && job.unitId === null,
    };
  });

  if (!reservation.shouldStart) {
    const workflowRunId =
      reservation.workflowRunId ??
      (await waitForWorkflowLink(db, "ai_job", reservation.jobId));
    return { jobId, workflowRunId };
  }

  let run: Awaited<ReturnType<typeof start>>;
  try {
    run = reservation.isDeepReview
      ? await start(pullRequestReviewWorkflow, [jobId])
      : await start(aiJobWorkflow, [jobId]);
  } catch (cause) {
    const { failAiJob } = await import("~/server/ai/agent-loop");
    await failAiJob(db, jobId, cause);
    throw cause;
  }
  await ensureWorkflowRunLink(db, {
    kind: "ai_job",
    targetId: jobId,
    providerRunId: run.runId,
  });
  return { jobId, workflowRunId: run.runId };
}

/** Waits briefly for a concurrent starter or the workflow itself to persist its link. */
async function waitForWorkflowLink(
  db: Database,
  kind: "sync_pull_request" | "ai_job",
  targetId: string,
) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const workflow = await db.query.workflowRuns.findFirst({
      where: and(
        eq(workflowRuns.kind, kind),
        eq(workflowRuns.targetId, targetId),
      ),
      orderBy: [desc(workflowRuns.createdAt)],
    });
    if (workflow) return workflow.providerRunId;
    await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
  }
  throw new Error(
    "Workflow start is still being established; try again shortly",
  );
}

/** Cancels a durable run and records the application terminal state. */
export async function cancelWorkflowRun(db: Database, providerRunId: string) {
  const workflow = await db.query.workflowRuns.findFirst({
    where: eq(workflowRuns.providerRunId, providerRunId),
  });
  if (!workflow) throw new Error("Workflow run not found");
  await getRun(providerRunId).cancel();
  await db
    .update(workflowRuns)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(eq(workflowRuns.id, workflow.id));
}
