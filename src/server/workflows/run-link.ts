import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { aiJobs, syncRuns, workflowRuns } from "@/drizzle/schema";
import type { db as database } from "~/server/db";

type Database = typeof database;
type WorkflowKind = "sync_pull_request" | "ai_job";

/** Idempotently attaches a durable provider run to its persisted application target. */
export async function ensureWorkflowRunLink(
  db: Database,
  input: {
    kind: WorkflowKind;
    targetId: string;
    providerRunId: string;
  },
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`workflow-link:${input.kind}:${input.targetId}`}))`,
    );

    const target =
      input.kind === "sync_pull_request"
        ? await tx.query.syncRuns.findFirst({
            where: eq(syncRuns.id, input.targetId),
          })
        : await tx.query.aiJobs.findFirst({
            where: eq(aiJobs.id, input.targetId),
          });
    if (!target) throw new Error("Workflow target not found");

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
            .set({ workflowRunId: linked.id })
            .where(eq(syncRuns.id, input.targetId));
        } else {
          await tx
            .update(aiJobs)
            .set({ workflowRunId: linked.id })
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
        .set({ workflowRunId: created.id })
        .where(eq(syncRuns.id, input.targetId));
    } else {
      await tx
        .update(aiJobs)
        .set({ workflowRunId: created.id })
        .where(eq(aiJobs.id, input.targetId));
    }
    return created;
  });
}
