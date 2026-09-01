import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getRun, start } from "workflow/api";
import {
  aiJobs,
  repositories,
  repositoryBranchMonitors,
  repositoryBranchSyncRuns,
  syncQueueRequests,
  syncRuns,
  workflowRuns,
} from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import type { ReviewQueueSource } from "~/server/review/queue";
import { aiJobWorkflow } from "./ai-job";
import { pullRequestReviewWorkflow } from "./pull-request-review";
import { repositoryBranchSyncWorkflow } from "./repository-branch-sync";
import { ensureWorkflowRunLink, workflowStartLockKey } from "./run-link";
import {
  establishReservedWorkflow,
  newWorkflowStartLease,
  reserveWorkflowStart,
} from "./start-reservation";
import { syncPullRequestWorkflow } from "./sync-pull-request";

type Database = typeof database;

/** Starts one idempotent durable synchronization of a monitored branch. */
export async function startRepositoryBranchSync(
  db: Database,
  input: { workspaceId: string; monitorId: string; force?: boolean },
) {
  return establishReservedWorkflow({
    reserve: () =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`repository-sync-workflow:${input.monitorId}`}))`,
        );
        const monitor = await tx.query.repositoryBranchMonitors.findFirst({
          where: and(
            eq(repositoryBranchMonitors.id, input.monitorId),
            eq(repositoryBranchMonitors.workspaceId, input.workspaceId),
          ),
        });
        if (!monitor) throw new Error("Repository monitor not found");
        const active = await tx.query.repositoryBranchSyncRuns.findFirst({
          where: and(
            eq(repositoryBranchSyncRuns.monitorId, input.monitorId),
            inArray(repositoryBranchSyncRuns.status, ["queued", "running"]),
          ),
          orderBy: [desc(repositoryBranchSyncRuns.createdAt)],
        });
        if (active) {
          return reserveWorkflowStart({
            lock: () =>
              tx.execute(
                sql`select pg_advisory_xact_lock(hashtext(${workflowStartLockKey("sync_repository_branch", active.id)}))`,
              ),
            load: () =>
              tx.query.repositoryBranchSyncRuns.findFirst({
                where: eq(repositoryBranchSyncRuns.id, active.id),
              }),
            missingMessage: "Repository synchronization run not found",
            linked: async (current, workflowRunId) => {
              const workflow = await tx.query.workflowRuns.findFirst({
                where: eq(workflowRuns.id, workflowRunId),
              });
              return workflow
                ? {
                    status: current.status,
                    syncId: current.id,
                    workflowRunId: workflow.providerRunId,
                  }
                : undefined;
            },
            claim: async (current, lease) => {
              await tx
                .update(repositoryBranchSyncRuns)
                .set({
                  workflowStartToken: lease.startToken,
                  workflowStartLeaseExpiresAt: lease.leaseExpiresAt,
                })
                .where(eq(repositoryBranchSyncRuns.id, current.id));
              return { status: current.status, syncId: current.id };
            },
          });
        }
        const lease = newWorkflowStartLease();
        const [run] = await tx
          .insert(repositoryBranchSyncRuns)
          .values({
            workspaceId: input.workspaceId,
            monitorId: input.monitorId,
            force: input.force ?? false,
            workflowStartToken: lease.startToken,
            workflowStartLeaseExpiresAt: lease.leaseExpiresAt,
          })
          .returning();
        if (!run)
          throw new Error("Could not create repository synchronization run");
        return {
          state: "claimed" as const,
          claim: { status: "queued" as const, syncId: run.id },
          ...lease,
        };
      }),
    start: async (claim, startToken) =>
      (await start(repositoryBranchSyncWorkflow, [claim.syncId, startToken]))
        .runId,
    link: async (claim, startToken, providerRunId) =>
      Boolean(
        await ensureWorkflowRunLink(db, {
          kind: "sync_repository_branch",
          targetId: claim.syncId,
          providerRunId,
          startToken,
        }),
      ),
    fail: async (claim, startToken, cause) => {
      await db
        .update(repositoryBranchSyncRuns)
        .set({
          status: "failed",
          error:
            cause instanceof Error
              ? cause.message.slice(0, 300)
              : "Workflow start failed",
          completedAt: new Date(),
          workflowStartLeaseExpiresAt: null,
        })
        .where(
          and(
            eq(repositoryBranchSyncRuns.id, claim.syncId),
            eq(repositoryBranchSyncRuns.status, "queued"),
            eq(repositoryBranchSyncRuns.workflowStartToken, startToken),
          ),
        );
    },
    result: (claim, workflowRunId) => ({ ...claim, workflowRunId }),
  });
}

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
  return establishReservedWorkflow({
    reserve: () =>
      db.transaction(async (tx) => {
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
        if (active) {
          return reserveWorkflowStart({
            lock: () =>
              tx.execute(
                sql`select pg_advisory_xact_lock(hashtext(${workflowStartLockKey("sync_pull_request", active.id)}))`,
              ),
            load: () =>
              tx.query.syncRuns.findFirst({
                where: eq(syncRuns.id, active.id),
              }),
            missingMessage: "Synchronization run not found",
            prepare: async (current) => {
              if (!input.queue) return;
              await tx
                .insert(syncQueueRequests)
                .values({
                  syncRunId: current.id,
                  userId: input.queue.userId,
                  source: input.queue.source,
                  explicit: input.queue.explicit,
                })
                .onConflictDoUpdate({
                  target: [
                    syncQueueRequests.syncRunId,
                    syncQueueRequests.userId,
                  ],
                  set: {
                    source: input.queue.source,
                    explicit: input.queue.explicit,
                  },
                });
            },
            linked: async (current, workflowRunId) => {
              const workflow = await tx.query.workflowRuns.findFirst({
                where: eq(workflowRuns.id, workflowRunId),
              });
              return workflow
                ? {
                    status: current.status,
                    syncId: current.id,
                    workflowRunId: workflow.providerRunId,
                  }
                : undefined;
            },
            claim: async (current, lease) => {
              await tx
                .update(syncRuns)
                .set({
                  workflowStartToken: lease.startToken,
                  workflowStartLeaseExpiresAt: lease.leaseExpiresAt,
                })
                .where(eq(syncRuns.id, current.id));
              return { status: current.status, syncId: current.id };
            },
          });
        }
        const lease = newWorkflowStartLease();
        const [sync] = await tx
          .insert(syncRuns)
          .values({
            workspaceId: input.workspaceId,
            repositoryId: input.repositoryId,
            pullRequestNumber: input.pullRequestNumber,
            workflowStartToken: lease.startToken,
            workflowStartLeaseExpiresAt: lease.leaseExpiresAt,
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
          state: "claimed" as const,
          claim: { status: "queued" as const, syncId: sync.id },
          ...lease,
        };
      }),
    start: async (claim, startToken) =>
      (await start(syncPullRequestWorkflow, [claim.syncId, startToken])).runId,
    link: async (claim, startToken, providerRunId) =>
      Boolean(
        await ensureWorkflowRunLink(db, {
          kind: "sync_pull_request",
          targetId: claim.syncId,
          providerRunId,
          startToken,
        }),
      ),
    fail: async (claim, startToken, cause) => {
      await db
        .update(syncRuns)
        .set({
          status: "failed",
          error:
            cause instanceof Error ? cause.message : "Workflow start failed",
          completedAt: new Date(),
          workflowStartLeaseExpiresAt: null,
        })
        .where(
          and(
            eq(syncRuns.id, claim.syncId),
            eq(syncRuns.status, "queued"),
            eq(syncRuns.workflowStartToken, startToken),
          ),
        );
    },
    result: (claim, workflowRunId) => ({ ...claim, workflowRunId }),
  });
}

/** Starts one AI workflow exactly once and links its durable run to the job. */
export async function startAiJob(db: Database, jobId: string) {
  return establishReservedWorkflow({
    reserve: () =>
      db.transaction(async (tx) => {
        return reserveWorkflowStart({
          lock: () =>
            tx.execute(
              sql`select pg_advisory_xact_lock(hashtext(${workflowStartLockKey("ai_job", jobId)}))`,
            ),
          load: () =>
            tx.query.aiJobs.findFirst({
              where: eq(aiJobs.id, jobId),
            }),
          missingMessage: "AI job not found",
          linked: async (_job, workflowRunId) => {
            const existing = await tx.query.workflowRuns.findFirst({
              where: eq(workflowRuns.id, workflowRunId),
            });
            if (!existing) throw new Error("AI workflow link is invalid");
            return { jobId, workflowRunId: existing.providerRunId };
          },
          claim: async (job, lease) => {
            if (
              job.status !== "queued" &&
              job.status !== "waiting_for_provider"
            ) {
              throw new Error(`Cannot start an AI job in ${job.status} state`);
            }
            await tx
              .update(aiJobs)
              .set({
                status: "waiting_for_provider",
                workflowStartToken: lease.startToken,
                workflowStartLeaseExpiresAt: lease.leaseExpiresAt,
              })
              .where(eq(aiJobs.id, job.id));
            return {
              jobId,
              isDeepReview: job.kind === "review" && job.unitId === null,
            };
          },
        });
      }),
    start: async (claim, startToken) =>
      (
        await (claim.isDeepReview
          ? start(pullRequestReviewWorkflow, [claim.jobId, startToken])
          : start(aiJobWorkflow, [claim.jobId, startToken]))
      ).runId,
    link: async (claim, startToken, providerRunId) =>
      Boolean(
        await ensureWorkflowRunLink(db, {
          kind: "ai_job",
          targetId: claim.jobId,
          providerRunId,
          startToken,
        }),
      ),
    fail: async (claim, startToken, cause) => {
      const [owned] = await db
        .update(aiJobs)
        .set({
          status: "failed",
          completionReason: "provider_failure",
          error: cause instanceof Error ? cause.message : "AI provider failed",
          completedAt: new Date(),
          workflowStartLeaseExpiresAt: null,
        })
        .where(
          and(
            eq(aiJobs.id, claim.jobId),
            eq(aiJobs.status, "waiting_for_provider"),
            eq(aiJobs.workflowStartToken, startToken),
          ),
        )
        .returning({ id: aiJobs.id });
      if (owned) {
        const { failAiJob } = await import("~/server/ai/agent-loop");
        await failAiJob(db, claim.jobId, cause);
      }
    },
    result: (claim, workflowRunId) => ({
      jobId: claim.jobId,
      workflowRunId,
    }),
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
