import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aiJobs,
  aiStreamLeases,
  providerConnections,
  pullRequests,
  repositories,
  reviewSnapshots,
  users,
  workspaces,
} from "@/drizzle/schema";
import { db } from "~/server/db";
import { pruneExpiredAiStreamLeases } from "./stream-leases";

const fixture = {
  userId: `stream-lease-${randomUUID()}`,
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  repositoryId: randomUUID(),
  pullRequestId: randomUUID(),
  snapshotId: randomUUID(),
  jobId: randomUUID(),
};

beforeAll(async () => {
  await db.insert(users).values({ id: fixture.userId });
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    ownerId: fixture.userId,
    name: "Stream lease workspace",
    slug: `stream-lease-${randomUUID()}`,
  });
  await db.insert(providerConnections).values({
    id: fixture.connectionId,
    workspaceId: fixture.workspaceId,
    provider: "github",
    externalAccountId: `stream-lease-${randomUUID()}`,
    displayName: "Stream lease connection",
  });
  await db.insert(repositories).values({
    id: fixture.repositoryId,
    workspaceId: fixture.workspaceId,
    connectionId: fixture.connectionId,
    externalId: `repository-${randomUUID()}`,
    owner: "reviewduck",
    name: "stream-lease",
    defaultBranch: "main",
    webUrl: "https://github.com/reviewduck/stream-lease",
  });
  await db.insert(pullRequests).values({
    id: fixture.pullRequestId,
    repositoryId: fixture.repositoryId,
    externalId: `pull-request-${randomUUID()}`,
    number: 1,
    title: "Stream lease",
    authorLogin: "reviewduck",
    sourceBranch: "feature",
    targetBranch: "main",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    webUrl: "https://github.com/reviewduck/stream-lease/pull/1",
  });
  await db.insert(reviewSnapshots).values({
    id: fixture.snapshotId,
    pullRequestId: fixture.pullRequestId,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    version: 1,
  });
  await db.insert(aiJobs).values({
    id: fixture.jobId,
    workspaceId: fixture.workspaceId,
    pullRequestId: fixture.pullRequestId,
    snapshotId: fixture.snapshotId,
    userId: fixture.userId,
    kind: "review",
    status: "running",
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
});

describe("AI stream lease prune", () => {
  it("deletes expired leases and keeps live ones", async () => {
    const [expired, live] = await db
      .insert(aiStreamLeases)
      .values([
        {
          jobId: fixture.jobId,
          userId: fixture.userId,
          expiresAt: new Date(Date.now() - 60_000),
        },
        {
          jobId: fixture.jobId,
          userId: fixture.userId,
          expiresAt: new Date(Date.now() + 60_000),
        },
      ])
      .returning();

    const removed = await pruneExpiredAiStreamLeases(db);
    expect(removed).toBeGreaterThanOrEqual(1);
    const remaining = await db.query.aiStreamLeases.findMany({
      where: eq(aiStreamLeases.jobId, fixture.jobId),
    });
    expect(remaining.map((row) => row.id)).toEqual([live?.id]);
    expect(remaining.some((row) => row.id === expired?.id)).toBe(false);
    expect(await pruneExpiredAiStreamLeases(db)).toBe(0);
    await expect(
      db.query.aiStreamLeases.findMany({
        where: eq(aiStreamLeases.jobId, fixture.jobId),
      }),
    ).resolves.toHaveLength(1);
  });
});
