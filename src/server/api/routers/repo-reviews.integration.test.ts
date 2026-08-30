import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aiJobs,
  aiJobTurns,
  aiReviewFindings,
  aiReviewItems,
  providerConnections,
  pullRequests,
  repositories,
  repositoryBranchMonitors,
  reviewSnapshots,
  users,
  workspaceMembers,
  workspaces,
} from "@/drizzle/schema";
import { createCallerFactory } from "~/server/api/trpc";
import { db } from "~/server/db";
import { repoReviewsRouter } from "./repo-reviews";

const fixture = {
  userId: `integration-${randomUUID()}`,
  otherUserId: `integration-${randomUUID()}`,
  workspaceId: randomUUID(),
  otherWorkspaceId: randomUUID(),
  connectionId: randomUUID(),
  repositoryId: randomUUID(),
  pullRequestId: randomUUID(),
  monitorId: randomUUID(),
  snapshotId: randomUUID(),
  parentJobId: randomUUID(),
  childJobId: randomUUID(),
  itemId: randomUUID(),
  findingId: `finding-${randomUUID()}`,
  activeJobId: randomUUID(),
};

const createCaller = createCallerFactory(repoReviewsRouter);

/** Creates an authenticated repository-review caller over the integration DB. */
function caller(userId: string) {
  return createCaller({
    db,
    auth: { userId, has: () => true },
    headers: new Headers(),
  });
}

beforeAll(async () => {
  await db
    .insert(users)
    .values([{ id: fixture.userId }, { id: fixture.otherUserId }]);
  await db.insert(workspaces).values([
    {
      id: fixture.workspaceId,
      ownerId: fixture.userId,
      name: "Repository report integration workspace",
      slug: `integration-${randomUUID()}`,
    },
    {
      id: fixture.otherWorkspaceId,
      ownerId: fixture.otherUserId,
      name: "Other integration workspace",
      slug: `integration-${randomUUID()}`,
    },
  ]);
  await db.insert(workspaceMembers).values([
    {
      workspaceId: fixture.workspaceId,
      userId: fixture.userId,
      role: "owner",
    },
    {
      workspaceId: fixture.otherWorkspaceId,
      userId: fixture.otherUserId,
      role: "owner",
    },
  ]);
  await db.insert(providerConnections).values({
    id: fixture.connectionId,
    workspaceId: fixture.workspaceId,
    provider: "github",
    externalAccountId: `integration-${randomUUID()}`,
    displayName: "Integration connection",
  });
  await db.insert(repositories).values({
    id: fixture.repositoryId,
    workspaceId: fixture.workspaceId,
    connectionId: fixture.connectionId,
    externalId: `repository-${randomUUID()}`,
    owner: "reviewduck",
    name: "report-deletion",
    defaultBranch: "main",
    webUrl: "https://github.com/reviewduck/report-deletion",
  });
  await db.insert(pullRequests).values({
    id: fixture.pullRequestId,
    repositoryId: fixture.repositoryId,
    externalId: `repository-branch:${fixture.monitorId}`,
    number: 0,
    title: "Repository report deletion",
    authorLogin: "Repository branch",
    sourceBranch: "main",
    targetBranch: "main",
    headSha: "a".repeat(40),
    baseSha: "a".repeat(40),
    webUrl: "https://github.com/reviewduck/report-deletion",
  });
  await db.insert(repositoryBranchMonitors).values({
    id: fixture.monitorId,
    workspaceId: fixture.workspaceId,
    repositoryId: fixture.repositoryId,
    pullRequestId: fixture.pullRequestId,
    branch: "main",
    createdBy: fixture.userId,
  });
  await db.insert(reviewSnapshots).values({
    id: fixture.snapshotId,
    pullRequestId: fixture.pullRequestId,
    headSha: "a".repeat(40),
    baseSha: "a".repeat(40),
    version: 1,
  });
  const job = {
    workspaceId: fixture.workspaceId,
    pullRequestId: fixture.pullRequestId,
    snapshotId: fixture.snapshotId,
    userId: fixture.userId,
    reviewScope: "repository_snapshot" as const,
  };
  await db.insert(aiJobs).values([
    {
      ...job,
      id: fixture.parentJobId,
      kind: "review",
      status: "completed",
    },
    {
      ...job,
      id: fixture.childJobId,
      kind: "review_file",
      parentJobId: fixture.parentJobId,
      status: "completed",
    },
    {
      ...job,
      id: fixture.activeJobId,
      kind: "review",
      status: "running",
    },
  ]);
  await db.insert(aiReviewItems).values({
    id: fixture.itemId,
    parentJobId: fixture.parentJobId,
    workspaceId: fixture.workspaceId,
    childJobId: fixture.childJobId,
    path: "src/report.ts",
    changeType: "modified",
    fingerprint: "b".repeat(64),
  });
  await db.insert(aiJobTurns).values({
    jobId: fixture.childJobId,
    sequence: 0,
    role: "assistant",
    encryptedContent: "sealed transcript",
  });
  await db.insert(aiReviewFindings).values({
    id: fixture.findingId,
    itemId: fixture.itemId,
    jobId: fixture.childJobId,
    workspaceId: fixture.workspaceId,
    path: "src/report.ts",
    severity: "medium",
    category: "bug",
    encryptedContent: "sealed finding",
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
  await db.delete(users).where(eq(users.id, fixture.otherUserId));
});

describe("repository report deletion", () => {
  it("enforces ownership and finished status, then cascades report records", async () => {
    await expect(
      caller(fixture.otherUserId).deleteReport({
        monitorId: fixture.monitorId,
        jobId: fixture.parentJobId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller(fixture.userId).deleteReport({
        monitorId: fixture.monitorId,
        jobId: fixture.activeJobId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      caller(fixture.userId).deleteReport({
        monitorId: fixture.monitorId,
        jobId: fixture.parentJobId,
      }),
    ).resolves.toEqual({ deletedId: fixture.parentJobId });

    await expect(
      db.query.aiJobs.findFirst({
        where: eq(aiJobs.id, fixture.parentJobId),
      }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.aiJobs.findFirst({ where: eq(aiJobs.id, fixture.childJobId) }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.aiReviewItems.findFirst({
        where: eq(aiReviewItems.id, fixture.itemId),
      }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.aiJobTurns.findFirst({
        where: eq(aiJobTurns.jobId, fixture.childJobId),
      }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.aiReviewFindings.findFirst({
        where: eq(aiReviewFindings.id, fixture.findingId),
      }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.aiJobs.findFirst({
        where: eq(aiJobs.id, fixture.activeJobId),
      }),
    ).resolves.toMatchObject({ status: "running" });
  });
});

describe("repoReviews.get", () => {
  it("returns one monitor to its workspace and hides it from everyone else", async () => {
    await expect(
      caller(fixture.userId).get({ monitorId: fixture.monitorId }),
    ).resolves.toEqual({
      id: fixture.monitorId,
      branch: "main",
      pullRequestId: fixture.pullRequestId,
      repositoryOwner: "reviewduck",
      repositoryName: "report-deletion",
    });
    await expect(
      caller(fixture.otherUserId).get({ monitorId: fixture.monitorId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
