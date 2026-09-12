import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeEvaluationCase: vi.fn(),
  completeEvaluationRun: vi.fn(),
  failEvaluationRun: vi.fn(),
}));
vi.mock("~/server/evaluations/execute", () => mocks);
import { evaluationWorkflow } from "./evaluation";

beforeEach(() => vi.resetAllMocks());
it("records terminal failure and stops subsequent cases when a durable step rejects", async () => {
  const error = new Error("Persistence failed");
  mocks.executeEvaluationCase.mockRejectedValueOnce(error);
  await expect(evaluationWorkflow("run", ["first", "second"])).rejects.toBe(
    error,
  );
  expect(mocks.executeEvaluationCase).toHaveBeenCalledTimes(1);
  expect(mocks.failEvaluationRun).toHaveBeenCalledWith("run");
  expect(mocks.completeEvaluationRun).not.toHaveBeenCalled();
});
it("records failure when the completion step rejects", async () => {
  const error = new Error("Completion failed");
  mocks.completeEvaluationRun.mockRejectedValueOnce(error);
  await expect(evaluationWorkflow("run", ["first"])).rejects.toBe(error);
  expect(mocks.failEvaluationRun).toHaveBeenCalledWith("run");
});
it("completes after all cases without recording a failure", async () => {
  await evaluationWorkflow("run", ["first", "second"]);
  expect(mocks.executeEvaluationCase).toHaveBeenCalledTimes(2);
  expect(mocks.completeEvaluationRun).toHaveBeenCalledWith("run");
  expect(mocks.failEvaluationRun).not.toHaveBeenCalled();
});
