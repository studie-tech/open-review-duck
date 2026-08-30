import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  providerConnections,
  pullRequests,
  repositories,
  reviewQueueItems,
  reviewSnapshots,
  reviewUnits,
  signOffs,
  users,
  workspaceMembers,
  workspaces,
} from "@/drizzle/schema";
import { createCallerFactory } from "~/server/api/trpc";
import { db } from "~/server/db";
import { reviewRouter } from "./review";

const fixture = {
  userId: `integration-${randomUUID()}`,
  otherUserId: `integration-${randomUUID()}`,
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  repositoryId: randomUUID(),
  reviewedPullRequestId: randomUUID(),
  freshPullRequestId: randomUUID(),
  supersededSnapshotId: randomUUID(),
  latestSnapshotId: randomUUID(),
  carriedUnitId: randomUUID(),
  freshUnitId: randomUUID(),
  openUnitId: randomUUID(),
  fileUnitId: randomUUID(),
};

const unitCreatedAt = new Date("2026-03-02T00:00:00.000Z");

/** Builds one review unit of the latest snapshot with distinct identity. */
function unit(id: string, kind: "function" | "file", order: number) {
  return {
    id,
    snapshotId: fixture.latestSnapshotId,
    stableKey: `unit-${order}`,
    path: `src/unit-${order}.ts`,
    language: "typescript",
    kind,
    name: `unit${order}`,
    startLine: 1,
    endLine: 10,
    contentHash: "c".repeat(64),
    semanticHash: "d".repeat(64),
    reviewOrder: order,
    createdAt: unitCreatedAt,
  };
}

const createCaller = createCallerFactory(reviewRouter);

beforeAll(async () => {
  await db
    .insert(users)
    .values([{ id: fixture.userId }, { id: fixture.otherUserId }]);
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    ownerId: fixture.userId,
    name: "Dashboard integration workspace",
    slug: `integration-${randomUUID()}`,
  });
  await db.insert(workspaceMembers).values({
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    role: "owner",
  });
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
    name: "dashboard-counts",
    defaultBranch: "main",
    webUrl: "https://github.com/reviewduck/dashboard-counts",
  });
  await db.insert(pullRequests).values(
    [
      { id: fixture.reviewedPullRequestId, number: 1 },
      { id: fixture.freshPullRequestId, number: 2 },
    ].map(({ id, number }) => ({
      id,
      repositoryId: fixture.repositoryId,
      externalId: `pull-request-${randomUUID()}`,
      number,
      title: `Dashboard pull request ${number}`,
      authorLogin: "reviewduck",
      sourceBranch: `feature-${number}`,
      targetBranch: "main",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      webUrl: `https://github.com/reviewduck/dashboard-counts/pull/${number}`,
    })),
  );
  await db.insert(reviewQueueItems).values([
    { pullRequestId: fixture.reviewedPullRequestId, userId: fixture.userId },
    { pullRequestId: fixture.freshPullRequestId, userId: fixture.userId },
  ]);
  await db.insert(reviewSnapshots).values([
    {
      id: fixture.supersededSnapshotId,
      pullRequestId: fixture.reviewedPullRequestId,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      version: 1,
    },
    {
      id: fixture.latestSnapshotId,
      pullRequestId: fixture.reviewedPullRequestId,
      headSha: "e".repeat(40),
      baseSha: "b".repeat(40),
      version: 2,
    },
  ]);
  await db.insert(reviewUnits).values([
    unit(fixture.carriedUnitId, "function", 1),
    unit(fixture.freshUnitId, "function", 2),
    unit(fixture.openUnitId, "function", 3),
    unit(fixture.fileUnitId, "file", 4),
    {
      ...unit(randomUUID(), "function", 5),
      snapshotId: fixture.supersededSnapshotId,
    },
  ]);
  await db.insert(signOffs).values([
    {
      unitId: fixture.carriedUnitId,
      userId: fixture.userId,
      semanticHash: "d".repeat(64),
      durationSeconds: 45,
      signedOffAt: new Date("2026-03-01T00:00:00.000Z"),
    },
    {
      unitId: fixture.freshUnitId,
      userId: fixture.userId,
      semanticHash: "d".repeat(64),
      durationSeconds: 30,
      signedOffAt: new Date("2026-03-03T00:00:00.000Z"),
    },
    {
      unitId: fixture.openUnitId,
      userId: fixture.userId,
      semanticHash: "d".repeat(64),
      durationSeconds: 90,
      signedOffAt: new Date("2026-03-03T00:00:00.000Z"),
      invalidatedAt: new Date("2026-03-04T00:00:00.000Z"),
    },
    {
      unitId: fixture.openUnitId,
      userId: fixture.otherUserId,
      semanticHash: "d".repeat(64),
      durationSeconds: 120,
      signedOffAt: new Date("2026-03-03T00:00:00.000Z"),
    },
    {
      unitId: fixture.fileUnitId,
      userId: fixture.userId,
      semanticHash: "d".repeat(64),
      durationSeconds: 30,
      signedOffAt: new Date("2026-03-03T00:00:00.000Z"),
    },
  ]);
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
  await db.delete(users).where(eq(users.id, fixture.otherUserId));
});

describe("dashboard review progress", () => {
  it("counts the latest snapshot's own reviewable units and sign-offs", async () => {
    const rows = await createCaller({
      db,
      auth: { userId: fixture.userId, has: () => true },
      headers: new Headers(),
    }).dashboard();

    const reviewed = rows.find(
      ({ id }) => id === fixture.reviewedPullRequestId,
    );
    expect(reviewed).toMatchObject({
      totalUnits: 3,
      signedUnits: 2,
      carriedSignOffs: 1,
    });
    expect(
      rows.find(({ id }) => id === fixture.freshPullRequestId),
    ).toMatchObject({ totalUnits: 0, signedUnits: 0, carriedSignOffs: 0 });
  });
});

describe("achievement totals", () => {
  it("totals the reviewer's own distinct active sign-offs", async () => {
    const stats = await createCaller({
      db,
      auth: { userId: fixture.userId, has: () => true },
      headers: new Headers(),
    }).gamification();

    expect(stats).toMatchObject({
      totalSignOffs: 2,
      reviewSeconds: 75,
      currentStreak: 0,
      longestStreak: 0,
      experiencePoints: 0,
    });
  });
});
