import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  aiJobs,
  providerConnections,
  pullRequests,
  repositories,
  repositoryBranchMonitors,
  repositoryBranchSyncRuns,
  reviewSnapshots,
  syncRuns,
  users,
  workspaces,
} from "@/drizzle/schema";
import { db } from "~/server/db";
import {
  startAiJob,
  startPullRequestSync,
  startRepositoryBranchSync,
} from "./service";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  getRun: vi.fn(),
  start: mocks.start,
}));

const fixture = {
  userId: `workflow-service-${randomUUID()}`,
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  repositoryId: randomUUID(),
  pullRequestId: randomUUID(),
  monitorPullRequestId: randomUUID(),
  snapshotId: randomUUID(),
  monitorId: randomUUID(),
  branchSyncId: randomUUID(),
  pullRequestSyncId: randomUUID(),
  aiJobId: randomUUID(),
};

beforeAll(async () => {
  await db.insert(users).values({ id: fixture.userId });
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    ownerId: fixture.userId,
    name: "Workflow service integration workspace",
    slug: `workflow-service-${randomUUID()}`,
  });
  await db.insert(providerConnections).values({
    id: fixture.connectionId,
    workspaceId: fixture.workspaceId,
    provider: "github",
    externalAccountId: `workflow-service-${randomUUID()}`,
    displayName: "Workflow service integration connection",
  });
  await db.insert(repositories).values({
    id: fixture.repositoryId,
    workspaceId: fixture.workspaceId,
    connectionId: fixture.connectionId,
    externalId: `workflow-service-${randomUUID()}`,
    owner: "reviewduck",
    name: "workflow-service",
    defaultBranch: "main",
    webUrl: "https://github.com/reviewduck/workflow-service",
  });
  await db.insert(pullRequests).values([
    {
      id: fixture.pullRequestId,
      repositoryId: fixture.repositoryId,
      externalId: `pull-${randomUUID()}`,
      number: 41,
      title: "Workflow service pull request",
      authorLogin: "reviewduck",
      sourceBranch: "feature",
      targetBranch: "main",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      webUrl: "https://github.com/reviewduck/workflow-service/pull/41",
    },
    {
      id: fixture.monitorPullRequestId,
      repositoryId: fixture.repositoryId,
      externalId: `branch-${randomUUID()}`,
      number: 0,
      title: "Workflow service branch",
      authorLogin: "reviewduck",
      sourceBranch: "main",
      targetBranch: "main",
      headSha: "c".repeat(40),
      baseSha: "c".repeat(40),
      webUrl: "https://github.com/reviewduck/workflow-service/tree/main",
    },
  ]);
  await db.insert(reviewSnapshots).values({
    id: fixture.snapshotId,
    pullRequestId: fixture.pullRequestId,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    version: 1,
  });
  await db.insert(repositoryBranchMonitors).values({
    id: fixture.monitorId,
    workspaceId: fixture.workspaceId,
    repositoryId: fixture.repositoryId,
    pullRequestId: fixture.monitorPullRequestId,
    branch: "main",
    createdBy: fixture.userId,
  });

  const staleLease = {
    workflowStartToken: randomUUID(),
    workflowStartLeaseExpiresAt: new Date(Date.now() - 1000),
  };
  await db.insert(repositoryBranchSyncRuns).values({
    ...staleLease,
    id: fixture.branchSyncId,
    workspaceId: fixture.workspaceId,
    monitorId: fixture.monitorId,
  });
  await db.insert(syncRuns).values({
    ...staleLease,
    id: fixture.pullRequestSyncId,
    workspaceId: fixture.workspaceId,
    repositoryId: fixture.repositoryId,
    pullRequestNumber: 41,
  });
  await db.insert(aiJobs).values({
    ...staleLease,
    id: fixture.aiJobId,
    workspaceId: fixture.workspaceId,
    pullRequestId: fixture.pullRequestId,
    snapshotId: fixture.snapshotId,
    userId: fixture.userId,
    kind: "explain",
    status: "waiting_for_provider",
  });
});

beforeEach(() => {
  mocks.start.mockReset();
  mocks.start.mockImplementation(async (_workflow, [targetId]) => ({
    runId: `wrun_${targetId}`,
  }));
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
});

describe("recoverable workflow service reservations", () => {
  it("recovers stale repository, pull-request, and AI reservations", async () => {
    const repositoryRun = await startRepositoryBranchSync(db, {
      workspaceId: fixture.workspaceId,
      monitorId: fixture.monitorId,
    });
    const pullRequestRun = await startPullRequestSync(db, {
      workspaceId: fixture.workspaceId,
      repositoryId: fixture.repositoryId,
      pullRequestNumber: 41,
    });
    const aiRun = await startAiJob(db, fixture.aiJobId);

    expect(repositoryRun.workflowRunId).toBe(`wrun_${fixture.branchSyncId}`);
    expect(pullRequestRun.workflowRunId).toBe(
      `wrun_${fixture.pullRequestSyncId}`,
    );
    expect(aiRun.workflowRunId).toBe(`wrun_${fixture.aiJobId}`);
    expect(mocks.start).toHaveBeenCalledTimes(3);
    for (const [, [targetId, startToken]] of mocks.start.mock.calls) {
      expect(targetId).toEqual(expect.any(String));
      expect(startToken).toEqual(expect.any(String));
    }
  });

  it("reuses a recovered link without starting a duplicate", async () => {
    const run = await startPullRequestSync(db, {
      workspaceId: fixture.workspaceId,
      repositoryId: fixture.repositoryId,
      pullRequestNumber: 41,
    });

    expect(run.workflowRunId).toBe(`wrun_${fixture.pullRequestSyncId}`);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("marks an owned reservation failed when the provider rejects its start", async () => {
    mocks.start.mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(
      startPullRequestSync(db, {
        workspaceId: fixture.workspaceId,
        repositoryId: fixture.repositoryId,
        pullRequestNumber: 42,
      }),
    ).rejects.toThrow("provider unavailable");

    await expect(
      db.query.syncRuns.findFirst({
        where: and(
          eq(syncRuns.repositoryId, fixture.repositoryId),
          eq(syncRuns.pullRequestNumber, 42),
        ),
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: "provider unavailable",
      workflowStartLeaseExpiresAt: null,
    });
  });
});
