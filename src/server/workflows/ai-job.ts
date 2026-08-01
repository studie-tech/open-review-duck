import { eq } from "drizzle-orm";
import { FatalError } from "workflow";
import { aiJobs, workflowRuns } from "@/drizzle/schema";
import { env } from "~/env";
import {
  executeAiTurn,
  failAiJob,
  finishAiJobAtInvestigationLimit,
} from "~/server/ai/agent-loop";
import { db } from "~/server/db";

/** Runs the bounded investigation as individually durable model turns. */
export async function aiJobWorkflow(jobId: string) {
  "use workflow";

  for (let turn = 0; turn < env.AI_MAX_MODEL_STEPS; turn += 1) {
    const result = await executeDurableAiTurn(jobId, turn);
    if (result.done) return result;
  }
  await finishDurableAiJobAtLimit(jobId);
  return { done: true, status: "completed" as const };
}

/** Executes one persisted, non-retrying inference turn. */
async function executeDurableAiTurn(jobId: string, turn: number) {
  "use step";

  try {
    const result = await executeAiTurn(db, jobId, turn);
    if (result.done) {
      const job = await db.query.aiJobs.findFirst({
        columns: { workflowRunId: true },
        where: eq(aiJobs.id, jobId),
      });
      if (job?.workflowRunId) {
        await db
          .update(workflowRuns)
          .set({ status: "completed", completedAt: new Date() })
          .where(eq(workflowRuns.id, job.workflowRunId));
      }
    }
    return result;
  } catch (cause) {
    await failAiJob(db, jobId, cause);
    const job = await db.query.aiJobs.findFirst({
      columns: { workflowRunId: true },
      where: eq(aiJobs.id, jobId),
    });
    if (job?.workflowRunId) {
      await db
        .update(workflowRuns)
        .set({
          status: "failed",
          error: cause instanceof Error ? cause.message : "AI job failed",
          completedAt: new Date(),
        })
        .where(eq(workflowRuns.id, job.workflowRunId));
    }
    throw new FatalError(
      cause instanceof Error ? cause.message : "AI job failed",
    );
  }
}

/** Records the investigation-limit terminal state after all durable turns. */
async function finishDurableAiJobAtLimit(jobId: string) {
  "use step";

  await finishAiJobAtInvestigationLimit(db, jobId);
  const job = await db.query.aiJobs.findFirst({
    columns: { workflowRunId: true },
    where: eq(aiJobs.id, jobId),
  });
  if (job?.workflowRunId) {
    await db
      .update(workflowRuns)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(workflowRuns.id, job.workflowRunId));
  }
}
