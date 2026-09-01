import "server-only";

import { and, eq, sql } from "drizzle-orm";
import {
  aiJobs,
  repositoryBranchSyncRuns,
  syncRuns,
  workflowRuns,
} from "@/drizzle/schema";
import type { db as database } from "~/server/db";

type Database = typeof database;
export type WorkflowKind =
  | "sync_pull_request"
  | "sync_repository_branch"
  | "ai_job";

/** Uses one advisory-lock namespace for reservation takeover and durable linking. */
export function workflowStartLockKey(kind: WorkflowKind, targetId: string) {
  return `workflow-start:${kind}:${targetId}`;
}

type WorkflowRun = typeof workflowRuns.$inferSelect;
interface WorkflowLinkInput {
  kind: WorkflowKind;
  targetId: string;
  providerRunId: string;
}

/** Idempotently attaches a durable provider run to its persisted application target. */
export function ensureWorkflowRunLink(
  db: Database,
  input: WorkflowLinkInput & { startToken?: undefined },
): Promise<WorkflowRun>;
export function ensureWorkflowRunLink(
  db: Database,
  input: WorkflowLinkInput & { startToken: string },
): Promise<WorkflowRun | null>;
export function ensureWorkflowRunLink(
  db: Database,
  input: WorkflowLinkInput & { startToken?: string },
): Promise<WorkflowRun | null>;
/** Implements token fencing and idempotent durable linking under the target lock. */
export async function ensureWorkflowRunLink(
  db: Database,
  input: WorkflowLinkInput & { startToken?: string },
): Promise<WorkflowRun | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${workflowStartLockKey(input.kind, input.targetId)}))`,
    );

    const target =
      input.kind === "sync_pull_request"
        ? await tx.query.syncRuns.findFirst({
            where: eq(syncRuns.id, input.targetId),
          })
        : input.kind === "sync_repository_branch"
          ? await tx.query.repositoryBranchSyncRuns.findFirst({
              where: eq(repositoryBranchSyncRuns.id, input.targetId),
            })
          : await tx.query.aiJobs.findFirst({
              where: eq(aiJobs.id, input.targetId),
            });
    if (!target) throw new Error("Workflow target not found");
    if (
      input.startToken !== undefined &&
      target.workflowStartToken !== input.startToken
    ) {
      return null;
    }

    const linked = target.workflowRunId
      ? await tx.query.workflowRuns.findFirst({
          where: eq(workflowRuns.id, target.workflowRunId),
        })
      : await tx.query.workflowRuns.findFirst({
          where: and(
            eq(workflowRuns.kind, input.kind),
            eq(workflowRuns.targetId, input.targetId),
          ),
        });
    if (linked) {
      if (linked.providerRunId !== input.providerRunId) {
        throw new Error("Workflow target is already linked to another run");
      }
      if (!target.workflowRunId) {
        if (input.kind === "sync_pull_request") {
          await tx
            .update(syncRuns)
            .set({
              workflowRunId: linked.id,
              workflowStartLeaseExpiresAt: null,
            })
            .where(eq(syncRuns.id, input.targetId));
        } else if (input.kind === "sync_repository_branch") {
          await tx
            .update(repositoryBranchSyncRuns)
            .set({
              workflowRunId: linked.id,
              workflowStartLeaseExpiresAt: null,
            })
            .where(eq(repositoryBranchSyncRuns.id, input.targetId));
        } else {
          await tx
            .update(aiJobs)
            .set({
              workflowRunId: linked.id,
              workflowStartLeaseExpiresAt: null,
            })
            .where(eq(aiJobs.id, input.targetId));
        }
      }
      return linked;
    }

    const providerRun = await tx.query.workflowRuns.findFirst({
      where: eq(workflowRuns.providerRunId, input.providerRunId),
    });
    if (providerRun) {
      throw new Error("Workflow run is already linked to another target");
    }

    const [created] = await tx
      .insert(workflowRuns)
      .values({
        workspaceId: target.workspaceId,
        providerRunId: input.providerRunId,
        kind: input.kind,
        targetId: input.targetId,
        deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
      })
      .returning();
    if (!created) throw new Error("Could not persist workflow run");

    if (input.kind === "sync_pull_request") {
      await tx
        .update(syncRuns)
        .set({
          workflowRunId: created.id,
          workflowStartLeaseExpiresAt: null,
        })
        .where(eq(syncRuns.id, input.targetId));
    } else if (input.kind === "sync_repository_branch") {
      await tx
        .update(repositoryBranchSyncRuns)
        .set({
          workflowRunId: created.id,
          workflowStartLeaseExpiresAt: null,
        })
        .where(eq(repositoryBranchSyncRuns.id, input.targetId));
    } else {
      await tx
        .update(aiJobs)
        .set({
          workflowRunId: created.id,
          workflowStartLeaseExpiresAt: null,
        })
        .where(eq(aiJobs.id, input.targetId));
    }
    return created;
  });
}
