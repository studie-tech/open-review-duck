import { randomUUID } from "node:crypto";
import type { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  providerConnections,
  pullRequests,
  rateLimits,
  repositories,
  reviewQueueItems,
  users,
  workspaces,
} from "@/drizzle/schema";
import { db } from "~/server/db";
import {
  enforceRateLimit,
  pruneExpiredRateLimits,
} from "~/server/security/rate-limit";
import {
  assignPullRequestToQueue,
  removePullRequestFromQueue,
  restorePullRequestToQueue,
} from "./queue";

const fixture = {
  userId: `integration-${randomUUID()}`,
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  repositoryId: randomUUID(),
  pullRequestId: randomUUID(),
};

beforeAll(async () => {
  await db.insert(users).values({ id: fixture.userId });
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    ownerId: fixture.userId,
    name: "Integration workspace",
    slug: `integration-${randomUUID()}`,
  });
  await db.insert(providerConnections).values({
    id: fixture.connectionId,
    workspaceId: fixture.workspaceId,
    provider: "github",
    externalAccountId: "integration-account",
    displayName: "Integration connection",
  });
  await db.insert(repositories).values({
    id: fixture.repositoryId,
    workspaceId: fixture.workspaceId,
    connectionId: fixture.connectionId,
    externalId: `repository-${randomUUID()}`,
    owner: "reviewduck",
    name: "integration",
    defaultBranch: "main",
    webUrl: "https://github.com/reviewduck/integration",
  });
  await db.insert(pullRequests).values({
    id: fixture.pullRequestId,
    repositoryId: fixture.repositoryId,
    externalId: `pull-request-${randomUUID()}`,
    number: 1,
    title: "Integration pull request",
    authorLogin: "reviewduck",
    sourceBranch: "feature",
    targetBranch: "main",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    webUrl: "https://github.com/reviewduck/integration/pull/1",
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
});

describe("database-backed rate limits", () => {
  it("atomically rejects excess calls and resets expired windows", async () => {
    const key = `integration:rate:${randomUUID()}`;
    await expect(enforceRateLimit(db, key, 2, 60_000)).resolves.toBeUndefined();
    await expect(enforceRateLimit(db, key, 2, 60_000)).resolves.toBeUndefined();
    await expect(enforceRateLimit(db, key, 2, 60_000)).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    } satisfies Partial<TRPCError>);

    await db
      .update(rateLimits)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(rateLimits.key, key));
    await expect(enforceRateLimit(db, key, 2, 60_000)).resolves.toBeUndefined();
    const reset = await db.query.rateLimits.findFirst({
      where: eq(rateLimits.key, key),
    });
    expect(reset?.count).toBe(1);

    await db
      .update(rateLimits)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(rateLimits.key, key));
    expect(await pruneExpiredRateLimits(db)).toBeGreaterThanOrEqual(1);
    await expect(
      db.query.rateLimits.findFirst({ where: eq(rateLimits.key, key) }),
    ).resolves.toBeUndefined();
  });
});

describe("review queue persistence", () => {
  it("preserves removal intent until a new revision or explicit restore", async () => {
    const initial = await assignPullRequestToQueue(db, {
      pullRequestId: fixture.pullRequestId,
      userId: fixture.userId,
      source: "assigned",
      headSha: "a".repeat(40),
      explicit: false,
    });
    expect(initial?.state).toBe("active");

    await removePullRequestFromQueue(db, {
      pullRequestId: fixture.pullRequestId,
      userId: fixture.userId,
    });
    const unchanged = await assignPullRequestToQueue(db, {
      pullRequestId: fixture.pullRequestId,
      userId: fixture.userId,
      source: "assigned",
      headSha: "a".repeat(40),
      explicit: false,
    });
    expect(unchanged?.state).toBe("removed");
    expect(unchanged?.removedHeadSha).toBe("a".repeat(40));

    await db
      .update(pullRequests)
      .set({ headSha: "c".repeat(40) })
      .where(eq(pullRequests.id, fixture.pullRequestId));
    const revised = await assignPullRequestToQueue(db, {
      pullRequestId: fixture.pullRequestId,
      userId: fixture.userId,
      source: "assigned",
      headSha: "c".repeat(40),
      explicit: false,
    });
    expect(revised?.state).toBe("active");

    await removePullRequestFromQueue(db, {
      pullRequestId: fixture.pullRequestId,
      userId: fixture.userId,
    });
    await restorePullRequestToQueue(db, {
      pullRequestId: fixture.pullRequestId,
      userId: fixture.userId,
    });
    const restored = await db.query.reviewQueueItems.findFirst({
      where: eq(reviewQueueItems.pullRequestId, fixture.pullRequestId),
    });
    expect(restored).toMatchObject({
      state: "active",
      removedAt: null,
      removedHeadSha: null,
    });
  });

  it("serializes concurrent assignments into one queue record", async () => {
    await Promise.all(
      Array.from({ length: 6 }, () =>
        assignPullRequestToQueue(db, {
          pullRequestId: fixture.pullRequestId,
          userId: fixture.userId,
          source: "manual",
          headSha: "c".repeat(40),
          explicit: true,
        }),
      ),
    );
    const rows = await db.query.reviewQueueItems.findMany({
      where: eq(reviewQueueItems.pullRequestId, fixture.pullRequestId),
    });
    expect(rows).toHaveLength(1);
  });
});
