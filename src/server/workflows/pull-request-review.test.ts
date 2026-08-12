import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sealReviewPlan: vi.fn(),
  executeReviewFileTurn: vi.fn(),
  executeReviewSurveyTurn: vi.fn(),
  ensureDeepReviewSurveyItem: vi.fn(async () => "survey-item"),
  runDeepReviewDedupe: vi.fn(async () => ({ mergedCount: 0, rejected: false })),
  finalizeDeepReview: vi.fn(),
  failAiJob: vi.fn(async () => undefined),
  ensureWorkflowRunLink: vi.fn(async () => ({ id: "workflow-run" })),
  update: vi.fn(),
}));

vi.mock("workflow", () => ({
  /** Stands in for the durable metadata the runtime injects. */
  getWorkflowMetadata: () => ({ workflowRunId: "provider-run" }),
  FatalError: class FatalError extends Error {},
}));
vi.mock("~/server/db", () => ({
  db: {
    query: {
      aiJobs: {
        /** Returns the survey child the seal step reads a workspace from. */
        findFirst: async () => ({ id: "survey", workspaceId: "workspace" }),
      },
    },
    /** Records a durable status write without modelling drizzle's builder. */
    update: (table: unknown) => ({
      set: (values: unknown) => ({
        where: async () => {
          mocks.update(table, values);
        },
      }),
    }),
  },
}));
vi.mock("~/server/ai/agent-loop", () => ({ failAiJob: mocks.failAiJob }));
vi.mock("~/server/review/deep/plan", () => ({
  sealReviewPlan: mocks.sealReviewPlan,
}));
vi.mock("~/server/review/deep/file-agent", () => ({
  DEEP_REVIEW_FILE_MAX_TURNS: 3,
  executeReviewFileTurn: mocks.executeReviewFileTurn,
  executeReviewSurveyTurn: mocks.executeReviewSurveyTurn,
}));
vi.mock("~/server/review/deep/survey", () => ({
  ensureDeepReviewSurveyItem: mocks.ensureDeepReviewSurveyItem,
}));
vi.mock("~/server/review/deep/dedupe", () => ({
  runDeepReviewDedupe: mocks.runDeepReviewDedupe,
}));
vi.mock("~/server/review/deep/finalize", () => ({
  finalizeDeepReview: mocks.finalizeDeepReview,
}));
vi.mock("./run-link", () => ({
  ensureWorkflowRunLink: mocks.ensureWorkflowRunLink,
}));

import { pullRequestReviewWorkflow } from "./pull-request-review";

const parentJobId = "00000000-0000-4000-8000-000000000001";

interface PlannedItem {
  itemId: string;
  path: string;
  changeType: string;
  changedLineCount: number;
  state: "selected" | "waived";
  childJobId: string | null;
  fingerprint: string;
  reason: string | null;
}

/** Builds a sealed plan of `count` selected files, all in one review. */
function sealedPlan(count: number) {
  const items: PlannedItem[] = Array.from({ length: count }, (_, index) => ({
    itemId: `item-${index}`,
    path: `src/file-${index}.ts`,
    changeType: "modified",
    changedLineCount: 10,
    state: "selected",
    childJobId: `child-${index}`,
    fingerprint: "f",
    reason: null,
  }));
  return {
    parentJobId,
    ruleConfigDigest: "digest",
    terminalState: null,
    items,
    surveyJobId: "survey",
    itemCount: count,
    selectedCount: count,
    waivedCount: 0,
  };
}

/** Reports one file settled on its first turn, as a healthy scout does. */
const settledOnFirstTurn = async () => ({
  done: true,
  state: "completed" as const,
  itemId: "item",
  path: "src/file.ts",
  failureClass: null,
  reason: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureWorkflowRunLink.mockResolvedValue({ id: "workflow-run" });
  mocks.executeReviewFileTurn.mockImplementation(settledOnFirstTurn);
  mocks.executeReviewSurveyTurn.mockImplementation(settledOnFirstTurn);
  mocks.ensureDeepReviewSurveyItem.mockResolvedValue("survey-item");
  mocks.runDeepReviewDedupe.mockResolvedValue({
    mergedCount: 0,
    rejected: false,
  });
  mocks.finalizeDeepReview.mockResolvedValue({
    terminalState: "complete",
    runFailureClass: null,
    completionReason: "answered",
    coverage: { total: 1, completed: 1, reused: 0, waived: 0, failed: 0 },
    sweptCount: 0,
    surfacedFindingCount: 2,
    usage: {},
    summary: "Deep review covered every file.",
    accepted: true,
  });
});

describe("pullRequestReviewWorkflow", () => {
  it("reviews every selected file and finalizes the sealed denominator", async () => {
    mocks.sealReviewPlan.mockResolvedValue(sealedPlan(9));

    const result = await pullRequestReviewWorkflow(parentJobId);

    expect(mocks.executeReviewFileTurn).toHaveBeenCalledTimes(9);
    const reviewed = mocks.executeReviewFileTurn.mock.calls.map(
      (call) => (call[1] as { childJobId: string }).childJobId,
    );
    expect(new Set(reviewed).size).toBe(9);
    expect(mocks.finalizeDeepReview).toHaveBeenCalledWith(
      expect.anything(),
      parentJobId,
      expect.objectContaining({ expectedItemCount: 10 }),
    );
    expect(result.terminalState).toBe("complete");
  });

  it("takes every turn one file needs before moving on", async () => {
    mocks.sealReviewPlan.mockResolvedValue(sealedPlan(1));
    mocks.executeReviewFileTurn
      .mockResolvedValueOnce({ done: false, state: "selected" })
      .mockResolvedValueOnce({ done: false, state: "selected" })
      .mockResolvedValueOnce({ done: true, state: "completed" });

    await pullRequestReviewWorkflow(parentJobId);

    expect(mocks.executeReviewFileTurn).toHaveBeenCalledTimes(3);
    expect(
      mocks.executeReviewFileTurn.mock.calls.map(
        (call) => (call[1] as { turnIndex: number }).turnIndex,
      ),
    ).toEqual([0, 1, 2]);
  });

  it("stops taking turns once a file settles", async () => {
    mocks.sealReviewPlan.mockResolvedValue(sealedPlan(1));

    await pullRequestReviewWorkflow(parentJobId);

    expect(mocks.executeReviewFileTurn).toHaveBeenCalledTimes(1);
  });

  it("runs files concurrently without a barrier between them", async () => {
    mocks.sealReviewPlan.mockResolvedValue(sealedPlan(8));
    const started: string[] = [];
    const release: Array<() => void> = [];
    mocks.executeReviewFileTurn.mockImplementation(
      async (_db: unknown, input: { childJobId: string }) => {
        started.push(input.childJobId);
        await new Promise<void>((resolve) => release.push(resolve));
        return { done: true, state: "completed" };
      },
    );

    const run = pullRequestReviewWorkflow(parentJobId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Four lanes, so exactly four files are in flight while none has finished:
    // a wave design would have dispatched all eight and then waited.
    expect(started).toHaveLength(4);
    expect(new Set(started).size).toBe(4);
    for (let index = 0; index < 8; index += 1) {
      release.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await run;
    expect(started).toHaveLength(8);
  });

  it("finalizes without dispatching when the plan selected nothing", async () => {
    mocks.sealReviewPlan.mockResolvedValue({
      ...sealedPlan(0),
      terminalState: "skipped",
      surveyJobId: null,
    });

    await pullRequestReviewWorkflow(parentJobId);

    expect(mocks.executeReviewFileTurn).not.toHaveBeenCalled();
    expect(mocks.finalizeDeepReview).toHaveBeenCalledWith(
      expect.anything(),
      parentJobId,
      expect.objectContaining({ expectedItemCount: 0 }),
    );
  });

  it("dispatches only the files a child job was created for", async () => {
    const plan = sealedPlan(2);
    plan.items.push({
      itemId: "item-waived",
      path: "vendor/bundle.min.js",
      changeType: "modified",
      changedLineCount: 0,
      state: "waived",
      childJobId: null,
      fingerprint: "f",
      reason: "vendored",
    });
    plan.itemCount = 3;
    mocks.sealReviewPlan.mockResolvedValue(plan);

    await pullRequestReviewWorkflow(parentJobId);

    expect(mocks.executeReviewFileTurn).toHaveBeenCalledTimes(2);
    expect(mocks.finalizeDeepReview).toHaveBeenCalledWith(
      expect.anything(),
      parentJobId,
      expect.objectContaining({ expectedItemCount: 4 }),
    );
  });

  it("still finalizes when the fan-out itself dies", async () => {
    mocks.sealReviewPlan.mockResolvedValue(sealedPlan(2));
    mocks.executeReviewFileTurn.mockRejectedValue(
      new Error("Workflow step infrastructure failed"),
    );

    await pullRequestReviewWorkflow(parentJobId);

    expect(mocks.finalizeDeepReview).toHaveBeenCalledWith(
      expect.anything(),
      parentJobId,
      expect.objectContaining({
        runFailure: { cause: "Workflow step infrastructure failed" },
      }),
    );
  });

  it("fails the job and its durable run when the plan cannot be sealed", async () => {
    mocks.sealReviewPlan.mockRejectedValue(new Error("Snapshot not found"));

    await expect(pullRequestReviewWorkflow(parentJobId)).rejects.toThrow(
      "Snapshot not found",
    );
    expect(mocks.failAiJob).toHaveBeenCalled();
    expect(mocks.finalizeDeepReview).not.toHaveBeenCalled();
  });

  it("fails the job when the coverage partition does not close", async () => {
    mocks.sealReviewPlan.mockResolvedValue(sealedPlan(1));
    mocks.finalizeDeepReview.mockRejectedValue(
      new Error("Deep review coverage does not partition the sealed plan"),
    );

    await expect(pullRequestReviewWorkflow(parentJobId)).rejects.toThrow(
      "does not partition",
    );
    expect(mocks.failAiJob).toHaveBeenCalled();
  });

  it("surveys and dedupes only after every file agent has reported", async () => {
    mocks.sealReviewPlan.mockResolvedValue(sealedPlan(4));
    const order: string[] = [];
    mocks.executeReviewFileTurn.mockImplementation(async () => {
      order.push("file");
      return { done: true, state: "completed" };
    });
    mocks.executeReviewSurveyTurn.mockImplementation(async () => {
      order.push("survey");
      return { done: true, state: "completed" };
    });
    mocks.runDeepReviewDedupe.mockImplementation(async () => {
      order.push("dedupe");
      return { mergedCount: 0, rejected: false };
    });

    await pullRequestReviewWorkflow(parentJobId);

    expect(order).toEqual(["file", "file", "file", "file", "survey", "dedupe"]);
  });

  it("counts the survey in the sealed denominator", async () => {
    mocks.sealReviewPlan.mockResolvedValue(sealedPlan(2));

    await pullRequestReviewWorkflow(parentJobId);

    expect(mocks.ensureDeepReviewSurveyItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ parentJobId, childJobId: "survey" }),
    );
    expect(mocks.finalizeDeepReview).toHaveBeenCalledWith(
      expect.anything(),
      parentJobId,
      expect.objectContaining({ expectedItemCount: 3 }),
    );
  });

  it("neither surveys nor dedupes a run that selected nothing", async () => {
    mocks.sealReviewPlan.mockResolvedValue({
      ...sealedPlan(0),
      terminalState: "skipped",
      surveyJobId: null,
    });

    await pullRequestReviewWorkflow(parentJobId);

    expect(mocks.executeReviewSurveyTurn).not.toHaveBeenCalled();
    expect(mocks.runDeepReviewDedupe).not.toHaveBeenCalled();
    expect(mocks.ensureDeepReviewSurveyItem).not.toHaveBeenCalled();
  });
});
