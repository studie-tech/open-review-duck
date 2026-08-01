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
  return db.transaction(async (tx) => {
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
    if (active?.workflowRunId) {
      if (input.queue) {
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
      const workflow = await tx.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, active.workflowRunId),
      });
      if (workflow) {
        return {
          status: active.status,
          syncId: active.id,
          workflowRunId: workflow.providerRunId,
        };
      }
    }
    if (active) {
      await tx
        .update(syncRuns)
        .set({
          status: "failed",
          error: "Synchronization was not linked to a durable workflow",
          completedAt: new Date(),
        })
        .where(eq(syncRuns.id, active.id));
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
    const run = await start(syncPullRequestWorkflow, [sync.id]);
    const [workflow] = await tx
      .insert(workflowRuns)
      .values({
        workspaceId: input.workspaceId,
        providerRunId: run.runId,
        kind: "sync_pull_request",
        targetId: sync.id,
        deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
      })
      .returning();
    if (!workflow) throw new Error("Could not persist workflow run");
    await tx
      .update(syncRuns)
      .set({ workflowRunId: workflow.id })
      .where(eq(syncRuns.id, sync.id));
    return {
      status: "queued" as const,
      syncId: sync.id,
      workflowRunId: run.runId,
    };
  });
}

/** Starts one AI workflow exactly once and links its durable run to the job. */
export async function startAiJob(db: Database, jobId: string) {
  return db.transaction(async (tx) => {
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
        jobId,
        workflowRunId: existing.providerRunId,
      };
    }
    const run = await start(aiJobWorkflow, [job.id]);
    const [workflow] = await tx
      .insert(workflowRuns)
      .values({
        workspaceId: job.workspaceId,
        providerRunId: run.runId,
        kind: "ai_job",
        targetId: job.id,
        deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
      })
      .returning();
    if (!workflow) throw new Error("Could not persist AI workflow run");
    await tx
      .update(aiJobs)
      .set({ workflowRunId: workflow.id })
      .where(eq(aiJobs.id, job.id));
    return { jobId, workflowRunId: run.runId };
  });
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
