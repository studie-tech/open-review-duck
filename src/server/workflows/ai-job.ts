import { eq } from "drizzle-orm";
import { FatalError, getWorkflowMetadata } from "workflow";
import { workflowRuns } from "@/drizzle/schema";
import { env } from "~/env";
import {
  executeAiTurn,
  failAiJob,
  finishAiJobAtInvestigationLimit,
} from "~/server/ai/agent-loop";
import { db } from "~/server/db";
import { ensureWorkflowRunLink } from "./run-link";

/** Runs the bounded investigation as individually durable model turns. */
export async function aiJobWorkflow(jobId: string) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();

  for (let turn = 0; turn < env.AI_MAX_MODEL_STEPS; turn += 1) {
    const result = await executeDurableAiTurn(jobId, turn, workflowRunId);
    if (result.done) return result;
  }
  await finishDurableAiJobAtLimit(jobId, workflowRunId);
  return { done: true, status: "completed" as const };
}

/** Executes one persisted, non-retrying inference turn. */
async function executeDurableAiTurn(
  jobId: string,
  turn: number,
  providerRunId: string,
) {
  "use step";

  try {
    const workflow = await ensureWorkflowRunLink(db, {
      kind: "ai_job",
      targetId: jobId,
      providerRunId,
    });
    const result = await executeAiTurn(db, jobId, turn);
    if (result.done) {
      await db
        .update(workflowRuns)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(workflowRuns.id, workflow.id));
    }
    return result;
  } catch (cause) {
    await failAiJob(db, jobId, cause);
    const workflow = await ensureWorkflowRunLink(db, {
      kind: "ai_job",
      targetId: jobId,
      providerRunId,
    });
    await db
      .update(workflowRuns)
      .set({
        status: "failed",
        error: cause instanceof Error ? cause.message : "AI job failed",
        completedAt: new Date(),
      })
      .where(eq(workflowRuns.id, workflow.id));
    throw new FatalError(
      cause instanceof Error ? cause.message : "AI job failed",
    );
  }
}

/** Records the investigation-limit terminal state after all durable turns. */
async function finishDurableAiJobAtLimit(jobId: string, providerRunId: string) {
  "use step";

  const workflow = await ensureWorkflowRunLink(db, {
    kind: "ai_job",
    targetId: jobId,
    providerRunId,
  });
  await finishAiJobAtInvestigationLimit(db, jobId);
  await db
    .update(workflowRuns)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(workflowRuns.id, workflow.id));
}
