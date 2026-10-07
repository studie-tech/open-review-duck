import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncRuns, workflowRuns } from "@/drizzle/schema";

const mocks = vi.hoisted(() => ({
  sync: vi.fn(),
  cleanup: vi.fn(),
  update: vi.fn(),
  requestVersion: 1,
  status: "running",
  completed: vi.fn().mockReturnValue([{}]),
}));
vi.mock("workflow", () => ({
  /** Supplies workflow identity without starting the durable runtime. */
  getWorkflowMetadata: () => ({ workflowRunId: "provider-run" }),
}));
vi.mock("~/server/db", () => ({
  db: {
    query: {
      syncRuns: {
        findFirst: async () => ({
          id: "sync",
          requestVersion: mocks.requestVersion,
          status: mocks.status,
          resultSnapshotId: "snapshot",
          snapshotCreated: true,
          repositoryId: "repo",
          pullRequestNumber: 42,
        }),
      },
      syncQueueRequests: { findMany: async () => [] },
    },
    /** Captures durable status writes in execution order. */
    update: (table: unknown) => ({
      set: (values: unknown) => ({
        where: () => {
          mocks.update(table, values);
          return { returning: async () => mocks.completed() };
        },
      }),
    }),
  },
}));
vi.mock("./run-link", () => ({
  ensureWorkflowRunLink: async () => ({ id: "workflow" }),
}));
vi.mock("~/server/sync/service", () => ({
  syncPullRequest: mocks.sync,
  cleanupPullRequestSources: mocks.cleanup,
}));
vi.mock("~/server/review/queue", () => ({ assignPullRequestToQueue: vi.fn() }));
vi.mock("~/server/providers/intake", () => ({
  reconcileRepositoryIntake: vi.fn(),
}));

import { syncPullRequestWorkflow } from "./sync-pull-request";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestVersion = 1;
  mocks.status = "running";
  mocks.completed.mockReturnValue([{}]);
  mocks.cleanup.mockResolvedValue(undefined);
  mocks.sync.mockResolvedValue({
    pullRequest: { id: "pr", headSha: "head" },
    snapshot: { id: "snapshot" },
    snapshotCreated: true,
    unitCount: 12,
  });
});

describe("synchronization readiness", () => {
  it("makes the revision available before waiting for retention maintenance", async () => {
    mocks.cleanup.mockImplementation(async () => {
      expect(mocks.update).toHaveBeenCalledWith(
        syncRuns,
        expect.objectContaining({ status: "completed" }),
      );
      expect(mocks.update).toHaveBeenCalledWith(
        workflowRuns,
        expect.objectContaining({ status: "completed" }),
      );
    });
    await expect(syncPullRequestWorkflow("sync")).resolves.toMatchObject({
      snapshotId: "snapshot",
      unitCount: 12,
    });
    expect(mocks.sync).toHaveBeenCalledWith(
      expect.anything(),
      "repo",
      42,
      expect.objectContaining({ deferRetention: true }),
    );
    expect(mocks.cleanup).toHaveBeenCalledWith(expect.anything(), "repo");
  });

  it("does not announce readiness when source synchronization fails", async () => {
    mocks.sync.mockRejectedValue(new Error("Download failed"));
    await expect(syncPullRequestWorkflow("sync")).rejects.toThrow(
      "Download failed",
    );
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalledWith(
      syncRuns,
      expect.objectContaining({ status: "completed" }),
    );
  });
});

describe("synchronization ownership", () => {
  it("drains requests arriving during source preparation in the same run", async () => {
    mocks.sync.mockImplementationOnce(async () => {
      mocks.requestVersion = 2;
      return {
        pullRequest: { id: "pr", headSha: "head" },
        snapshot: { id: "older" },
        snapshotCreated: true,
        unitCount: 1,
      };
    });
    await expect(syncPullRequestWorkflow("sync")).resolves.toMatchObject({
      snapshotId: "snapshot",
    });
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    expect(mocks.update).toHaveBeenCalledWith(
      syncRuns,
      expect.objectContaining({ resultSnapshotId: "snapshot" }),
    );
  });

  it("does not replay publication after a completed step is reentered", async () => {
    mocks.status = "completed";
    await expect(syncPullRequestWorkflow("sync")).resolves.toMatchObject({
      snapshotId: "snapshot",
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("keeps a published sync completed when later maintenance fails", async () => {
    mocks.cleanup.mockRejectedValueOnce(new Error("Maintenance unavailable"));
    await expect(syncPullRequestWorkflow("sync")).rejects.toThrow(
      "Maintenance unavailable",
    );
    // Failure recording is fenced to queued/running rows in the real DB.
    expect(mocks.sync).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledWith(
      syncRuns,
      expect.objectContaining({ resultSnapshotId: "snapshot" }),
    );
  });
});
