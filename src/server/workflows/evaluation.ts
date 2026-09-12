/** Evaluates cases sequentially in durable steps with a bounded per-case budget. */
export async function evaluationWorkflow(runId: string, caseIds: string[]) {
  "use workflow";
  try {
    for (const caseId of caseIds) await evaluateStep(runId, caseId);
    await completeStep(runId);
  } catch (error) {
    await failStep(runId);
    throw error;
  }
}

/** Persists a single case before advancing the workflow. */
async function evaluateStep(runId: string, caseId: string) {
  "use step";
  const { executeEvaluationCase } = await import(
    "~/server/evaluations/execute"
  );
  await executeEvaluationCase(runId, caseId);
}

/** Records terminal completion after all durable steps have settled. */
async function completeStep(runId: string) {
  "use step";
  const { completeEvaluationRun } = await import(
    "~/server/evaluations/execute"
  );
  await completeEvaluationRun(runId);
}

/** Releases the active-run slot after a durable step exhausts its retries. */
async function failStep(runId: string) {
  "use step";
  const { failEvaluationRun } = await import("~/server/evaluations/execute");
  await failEvaluationRun(runId);
}
