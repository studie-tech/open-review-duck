import { eq } from "drizzle-orm";
import { FatalError, getWorkflowMetadata } from "workflow";
import { aiJobs, workflowRuns } from "@/drizzle/schema";
import { env } from "~/env";
import { failAiJob } from "~/server/ai/agent-loop";
import { db } from "~/server/db";
import { runDeepReviewDedupe } from "~/server/review/deep/dedupe";
import {
  DEEP_REVIEW_FILE_MAX_TURNS,
  executeReviewFileTurn,
  executeReviewSurveyTurn,
} from "~/server/review/deep/file-agent";
import { finalizeDeepReview } from "~/server/review/deep/finalize";
import { sealReviewPlan } from "~/server/review/deep/plan";
import { sanitizeReason } from "~/server/review/deep/redaction";
import { ensureDeepReviewSurveyItem } from "~/server/review/deep/survey";
import { ensureWorkflowRunLink } from "./run-link";

/**
 * How many files may be under review at the same instant.
 *
 * Coverage is uncapped — every selected file is reviewed — and this bounds only
 * how many of them run concurrently. Budget it against `DATABASE_POOL_MAX`: a
 * file can hold up to `DEEP_REVIEW_TOOL_SLOTS` statements at once, so the
 * product of the two wants to stay under the pool, leaving room for the status
 * polling and the maintenance cron.
 */
const DEEP_REVIEW_EXECUTION_SLOTS = env.DEEP_REVIEW_EXECUTION_SLOTS;

interface PlannedReviewFile {
  childJobId: string;
  path: string;
}

interface SealedPlanSummary {
  itemCount: number;
  maxTurns: number;
  files: PlannedReviewFile[];
  /** The whole-pull-request child, absent when nothing was selected. */
  surveyJobId: string | null;
}

/**
 * Splits the selected files into fixed lanes drained in parallel.
 *
 * Not waves: there is no barrier anywhere, so a file that takes ten minutes
 * delays only the rest of its own lane and never the other three. The lanes are
 * a static, index-derived partition rather than a work-stealing queue because a
 * workflow body is replayed, and a queue whose assignment depended on
 * completion order would hand a different file to a different lane on replay.
 */
function reviewLanes(
  files: readonly PlannedReviewFile[],
  slots: number,
): PlannedReviewFile[][] {
  const laneCount = Math.max(1, Math.min(slots, files.length));
  const lanes: PlannedReviewFile[][] = Array.from(
    { length: laneCount },
    () => [],
  );
  for (const [index, file] of files.entries()) {
    // Round-robin over a plan already ordered widest-change-first, so the
    // heaviest files spread across lanes instead of stacking in one.
    lanes[index % laneCount]?.push(file);
  }
  return lanes;
}

/**
 * Reviews one pull request as a sealed plan and a bounded file fan-out.
 *
 * The parent job holds the run's only quota reservation and makes no model call
 * of its own; every turn happens on a child, and `finalizeDeepReview` is what
 * rolls their usage back onto the parent. Because a file's own failure is
 * recorded as coverage rather than thrown, reaching the finalize step is the
 * normal path for a run in which several files failed.
 */
export async function pullRequestReviewWorkflow(parentJobId: string) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  const plan = await sealDeepReviewPlan(parentJobId, workflowRunId);
  if (plan.files.length === 0) {
    return await finalizeDeepReviewRun(parentJobId, workflowRunId, {
      expectedItemCount: plan.itemCount,
    });
  }

  let runFailure: string | undefined;
  try {
    await Promise.all(
      reviewLanes(plan.files, DEEP_REVIEW_EXECUTION_SLOTS).map(async (lane) => {
        for (const file of lane) {
          for (let turn = 0; turn < plan.maxTurns; turn += 1) {
            const result = await executeDeepReviewFileTurn(
              file.childJobId,
              turn,
              plan.maxTurns,
            );
            if (result.done) break;
          }
        }
      }),
    );
    // The survey runs after every file agent, never beside them: it is given
    // what they found so it can skip it, and a file agent given the survey's
    // half-formed output would be reviewing a guess.
    if (plan.surveyJobId) {
      for (let turn = 0; turn < plan.maxTurns; turn += 1) {
        const result = await executeDeepReviewSurveyTurn(
          plan.surveyJobId,
          turn,
          plan.maxTurns,
        );
        if (result.done) break;
      }
      await dedupeDeepReviewFindings(parentJobId, plan.surveyJobId);
    }
  } catch (cause) {
    // One file's failure is recorded on its own item and never thrown, so
    // anything arriving here ended the run rather than a single file, and the
    // sweep in finalize attributes every unreached file to it.
    runFailure = cause instanceof Error ? cause.message : "Deep review failed";
  }

  return await finalizeDeepReviewRun(parentJobId, workflowRunId, {
    expectedItemCount: plan.itemCount,
    runFailure,
  });
}

/**
 * Freezes the coverage denominator before any concurrency exists.
 *
 * Everything downstream depends on this having happened exactly once: the
 * denominator cannot move while agents run, the parent is marked running so the
 * review UI stops looking frozen, and its `startedAt` becomes the one wall
 * clock the whole fan-out measures against.
 */
async function sealDeepReviewPlan(
  parentJobId: string,
  providerRunId: string,
): Promise<SealedPlanSummary> {
  "use step";

  const workflow = await ensureWorkflowRunLink(db, {
    kind: "ai_job",
    targetId: parentJobId,
    providerRunId,
  });
  try {
    await db
      .update(workflowRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(workflowRuns.id, workflow.id));
    const plan = await sealReviewPlan(db, parentJobId);
    // The survey earns its own item in the same breath as the file items, so
    // the denominator finalize asserts against already covers it and a survey
    // that never runs is a swept row rather than a silent absence.
    if (plan.surveyJobId) {
      const survey = await db.query.aiJobs.findFirst({
        columns: { workspaceId: true },
        where: eq(aiJobs.id, plan.surveyJobId),
      });
      if (!survey) throw new Error("Deep review survey job not found");
      await ensureDeepReviewSurveyItem(db, {
        parentJobId,
        workspaceId: survey.workspaceId,
        childJobId: plan.surveyJobId,
      });
    }
    return {
      itemCount: plan.itemCount + (plan.surveyJobId ? 1 : 0),
      // Carried through the plan rather than read in the workflow body: the
      // turn ceiling belongs to the agent module, and workflow state holds
      // identifiers and plain data only.
      maxTurns: DEEP_REVIEW_FILE_MAX_TURNS,
      surveyJobId: plan.surveyJobId,
      files: plan.items.flatMap((item) =>
        item.childJobId
          ? [{ childJobId: item.childJobId, path: item.path }]
          : [],
      ),
    };
  } catch (cause) {
    throw new FatalError(
      await failDeepReviewRun(parentJobId, workflow.id, cause),
    );
  }
}

/**
 * Executes one durable model turn for one file.
 *
 * The step returns only whether the file is settled: the item row is the
 * durable record of what happened to it, and a workflow journal that repeated
 * findings or reasons would be a second, divergent copy of that record.
 */
async function executeDeepReviewFileTurn(
  childJobId: string,
  turnIndex: number,
  maxTurns: number,
) {
  "use step";

  const result = await executeReviewFileTurn(db, {
    childJobId,
    turnIndex,
    maxTurns,
  });
  return { done: result.done, state: result.state };
}

/** Executes one durable model turn of the cross-file survey agent. */
async function executeDeepReviewSurveyTurn(
  childJobId: string,
  turnIndex: number,
  maxTurns: number,
) {
  "use step";

  const result = await executeReviewSurveyTurn(db, {
    childJobId,
    turnIndex,
    maxTurns,
  });
  return { done: result.done, state: result.state };
}

/**
 * Collapses the run's duplicate findings once every agent has reported.
 *
 * Deduplication is attributed to the survey child because it is the one job
 * that reasons over the whole pull request, and a failure here must not cost
 * the run its findings: the deterministic pass is all-or-nothing already, so a
 * thrown clustering call leaves every finding exactly as it was reported.
 */
async function dedupeDeepReviewFindings(
  parentJobId: string,
  surveyJobId: string,
) {
  "use step";

  const job = await db.query.aiJobs.findFirst({
    where: eq(aiJobs.id, surveyJobId),
  });
  if (!job) return { mergedCount: 0, rejected: false };
  const result = await runDeepReviewDedupe(db, { parentJobId, job });
  return { mergedCount: result.mergedCount, rejected: result.rejected };
}

/**
 * Closes the run: sweeps coverage, rolls usage up, and publishes the result.
 *
 * This is the only place a deep review reaches a terminal state on the happy
 * path, and the only place the tree's tokens are settled against the parent's
 * reservation, so it runs whether the fan-out succeeded or died.
 */
async function finalizeDeepReviewRun(
  parentJobId: string,
  providerRunId: string,
  options: { expectedItemCount: number; runFailure?: string },
) {
  "use step";

  const workflow = await ensureWorkflowRunLink(db, {
    kind: "ai_job",
    targetId: parentJobId,
    providerRunId,
  });
  try {
    const result = await finalizeDeepReview(db, parentJobId, {
      expectedItemCount: options.expectedItemCount,
      runFailure: options.runFailure
        ? { cause: options.runFailure }
        : undefined,
    });
    await db
      .update(workflowRuns)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(workflowRuns.id, workflow.id));
    return {
      terminalState: result.terminalState,
      coverage: result.coverage,
      findingCount: result.surfacedFindingCount,
    };
  } catch (cause) {
    throw new FatalError(
      await failDeepReviewRun(parentJobId, workflow.id, cause),
    );
  }
}

/**
 * Records a terminal run failure on both the job and its durable run.
 *
 * The returned message is redacted before it is stored or re-thrown: a provider
 * error carrying a bearer token would otherwise reach `workflow_run.error`, the
 * workflow provider's own state, and the client that polls the job.
 */
async function failDeepReviewRun(
  parentJobId: string,
  workflowId: string,
  cause: unknown,
) {
  const error = sanitizeReason(cause);
  await failAiJob(db, parentJobId, cause);
  await db
    .update(workflowRuns)
    .set({ status: "failed", error, completedAt: new Date() })
    .where(eq(workflowRuns.id, workflowId));
  return error;
}
