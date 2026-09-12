/** Evaluates cases sequentially in durable steps with a bounded per-case budget. */
export async function evaluationWorkflow(runId: string, caseIds: string[]) {
  "use workflow";
  for (const caseId of caseIds) await evaluateStep(runId, caseId);
  await completeStep(runId);
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
