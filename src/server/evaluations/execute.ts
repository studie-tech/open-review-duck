import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { evalDatasets, evalResults, evalRuns } from "@/drizzle/schema";
import type { EvalOutput } from "~/lib/evaluations";
import { resolveAiModel } from "~/server/ai/models";
import { db } from "~/server/db";
import { evaluateCase } from "./runner";
import { type EvalSnapshot, openEval, sealEval } from "./store";

/** Executes one durable case and persists errors without scoring them as passes. */
export async function executeEvaluationCase(runId: string, caseId: string) {
  const run = await db.query.evalRuns.findFirst({
    where: eq(evalRuns.id, runId),
  });
  if (run?.status !== "running") return;
  const dataset = await db.query.evalDatasets.findFirst({
    where: eq(evalDatasets.id, run.datasetId),
  });
  if (!dataset) return;
  if (
    await db.query.evalResults.findFirst({
      where: and(eq(evalResults.runId, runId), eq(evalResults.caseId, caseId)),
    })
  )
    return;
  const snapshot = await openEval<EvalSnapshot>(
    dataset.workspaceId,
    runId,
    run.encryptedSnapshot,
  );
  const example = snapshot.cases.find((entry) => entry.id === caseId);
  if (!example) throw new Error("Evaluation case missing from snapshot");
  let output: EvalOutput;
  try {
    const model = await resolveAiModel(db, {
      workspaceId: dataset.workspaceId,
      provider: snapshot.provider,
      model: snapshot.model,
    });
    output = await evaluateCase(snapshot, example, model);
  } catch {
    output = {
      prediction: "error",
      output:
        "The provider failed, timed out, or returned an unusable response. Check AI configuration and retry in a new run.",
      inputTokens: 0,
      outputTokens: 0,
    };
  }
  const id = randomUUID();
  await db
    .insert(evalResults)
    .values({
      id,
      runId,
      caseId,
      encryptedOutput: await sealEval(dataset.workspaceId, id, output),
    })
    .onConflictDoNothing();
}

/** Completes a run only after every captured case has a persisted outcome. */
export async function completeEvaluationRun(runId: string) {
  await db
    .update(evalRuns)
    .set({ status: "completed", completedAt: new Date() })
    .where(and(eq(evalRuns.id, runId), eq(evalRuns.status, "running")));
}

/** Records workflow failure without overwriting cancellation or completion. */
export async function failEvaluationRun(runId: string) {
  await db
    .update(evalRuns)
    .set({ status: "failed", completedAt: new Date() })
    .where(and(eq(evalRuns.id, runId), eq(evalRuns.status, "running")));
}
