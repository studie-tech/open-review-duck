import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  providerConnections,
  pullRequests,
  repositories,
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

const dayMs = 86_400_000;
const clock = new Date();
const today = Date.UTC(
  clock.getUTCFullYear(),
  clock.getUTCMonth(),
  clock.getUTCDate(),
);

const fixture = {
  ownerId: `integration-${randomUUID()}`,
  memberId: `integration-${randomUUID()}`,
  soloId: `integration-${randomUUID()}`,
  batchId: `integration-${randomUUID()}`,
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  repositoryId: randomUUID(),
  pullRequestId: randomUUID(),
  snapshotId: randomUUID(),
};

// Each entry covers one arm of the experience formula: the 75 point ceiling,
// the 600 second duration cap, a whole 30 second step, a half step that has to
// round the same way in Postgres as it does in JavaScript, and a row that
// repeats the preceding tuple so the distinct count stays observable.
const signedUnits = {
  capped: {
    id: randomUUID(),
    complexity: 40,
    daysAgo: 10,
    durationSeconds: 600,
    experience: 75,
    semanticHash: "a".repeat(64),
  },
  latest: {
    id: randomUUID(),
    complexity: 5,
    daysAgo: 0,
    durationSeconds: 900,
    experience: 40,
    semanticHash: "b".repeat(64),
  },
  previous: {
    id: randomUUID(),
    complexity: 1,
    daysAgo: 1,
    durationSeconds: 30,
    experience: 9,
    semanticHash: "c".repeat(64),
  },
  halfStep: {
    id: randomUUID(),
    complexity: 2,
    daysAgo: 2,
    durationSeconds: 45,
    experience: 13,
    semanticHash: "d".repeat(64),
  },
  repeated: {
    id: randomUUID(),
    complexity: 2,
    daysAgo: 2,
    durationSeconds: 45,
    experience: 0,
    semanticHash: "d".repeat(64),
  },
};

const lifetimeExperience = Object.values(signedUnits).reduce(
  (total, entry) => total + entry.experience,
  0,
);

const createCaller = createCallerFactory(reviewRouter);

/** Builds the review unit a fixture sign-off is attached to. */
function unit(
  entry: (typeof signedUnits)[keyof typeof signedUnits],
  order: number,
) {
  return {
    id: entry.id,
    snapshotId: fixture.snapshotId,
    stableKey: `unit-${order}`,
    path: `src/unit-${order}.ts`,
    language: "typescript",
    kind: "function" as const,
    name: `unit${order}`,
    startLine: 1,
    endLine: 10,
    contentHash: "c".repeat(64),
    semanticHash: entry.semanticHash,
    complexity: entry.complexity,
    reviewOrder: order,
  };
}

/** Reads back the achievement columns the recomputation writes. */
async function statsOf(userId: string) {
  const [row] = await db
    .select({
      experiencePoints: users.experiencePoints,
      currentStreak: users.currentStreak,
      longestStreak: users.longestStreak,
      lastReviewDate: users.lastReviewDate,
    })
    .from(users)
    .where(eq(users.id, userId));
  return row;
}

beforeAll(async () => {
  await db
    .insert(users)
    .values([
      { id: fixture.ownerId },
      { id: fixture.memberId },
      { id: fixture.soloId },
      { id: fixture.batchId },
    ]);
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    ownerId: fixture.ownerId,
    name: "Review stats integration workspace",
    slug: `integration-${randomUUID()}`,
  });
  await db.insert(workspaceMembers).values([
    {
      workspaceId: fixture.workspaceId,
      userId: fixture.ownerId,
      role: "owner",
    },
    {
      workspaceId: fixture.workspaceId,
      userId: fixture.memberId,
      role: "member",
    },
    {
      workspaceId: fixture.workspaceId,
      userId: fixture.soloId,
      role: "member",
    },
    {
      workspaceId: fixture.workspaceId,
      userId: fixture.batchId,
      role: "member",
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
    name: "review-stats",
    defaultBranch: "main",
    webUrl: "https://github.com/reviewduck/review-stats",
  });
  await db.insert(pullRequests).values({
    id: fixture.pullRequestId,
    repositoryId: fixture.repositoryId,
    externalId: `pull-request-${randomUUID()}`,
    number: 1,
    title: "Review stats pull request",
    authorLogin: "reviewduck",
    sourceBranch: "feature",
    targetBranch: "main",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    webUrl: "https://github.com/reviewduck/review-stats/pull/1",
  });
  await db.insert(reviewSnapshots).values({
    id: fixture.snapshotId,
    pullRequestId: fixture.pullRequestId,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    version: 1,
  });
  await db
    .insert(reviewUnits)
    .values(
      Object.values(signedUnits).map((entry, index) => unit(entry, index)),
    );
  await db.insert(signOffs).values([
    ...[fixture.ownerId, fixture.memberId].flatMap((userId) =>
      Object.values(signedUnits).map((entry) => ({
        unitId: entry.id,
        userId,
        semanticHash: entry.semanticHash,
        durationSeconds: entry.durationSeconds,
        signedOffAt: new Date(today - entry.daysAgo * dayMs),
      })),
    ),
    {
      unitId: signedUnits.previous.id,
      userId: fixture.soloId,
      semanticHash: signedUnits.previous.semanticHash,
      durationSeconds: signedUnits.previous.durationSeconds,
      signedOffAt: new Date(today - signedUnits.previous.daysAgo * dayMs),
    },
    ...Object.values(signedUnits).map((entry) => ({
      unitId: entry.id,
      userId: fixture.batchId,
      semanticHash: entry.semanticHash,
      durationSeconds: entry.durationSeconds,
      signedOffAt: new Date(today - entry.daysAgo * dayMs),
    })),
  ]);
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.ownerId));
  await db.delete(users).where(eq(users.id, fixture.memberId));
  await db.delete(users).where(eq(users.id, fixture.soloId));
  await db.delete(users).where(eq(users.id, fixture.batchId));
});

describe("review achievement recomputation", () => {
  it("totals the reviewer's distinct active sign-offs", async () => {
    await createCaller({
      db,
      auth: { userId: fixture.ownerId, has: () => true },
      headers: new Headers(),
    }).unreview({ unitId: signedUnits.capped.id });

    expect(await statsOf(fixture.ownerId)).toEqual({
      experiencePoints: lifetimeExperience - signedUnits.capped.experience,
      currentStreak: 3,
      longestStreak: 3,
      lastReviewDate: new Date(today),
    });
  });

  it("drops the undone day from the streak walk", async () => {
    await createCaller({
      db,
      auth: { userId: fixture.memberId, has: () => true },
      headers: new Headers(),
    }).unreview({ unitId: signedUnits.latest.id });

    expect(await statsOf(fixture.memberId)).toEqual({
      experiencePoints: lifetimeExperience - signedUnits.latest.experience,
      currentStreak: 2,
      longestStreak: 2,
      lastReviewDate: new Date(today - dayMs),
    });
  });

  it("clears the achievements once no sign-off is left", async () => {
    await createCaller({
      db,
      auth: { userId: fixture.soloId, has: () => true },
      headers: new Headers(),
    }).unreview({ unitId: signedUnits.previous.id });

    expect(await statsOf(fixture.soloId)).toEqual({
      experiencePoints: 0,
      currentStreak: 0,
      longestStreak: 0,
      lastReviewDate: null,
    });
  });

  it("recomputes achievements once for a batch of undos", async () => {
    const results = await createCaller({
      db,
      auth: { userId: fixture.batchId, has: () => true },
      headers: new Headers(),
    }).unreviewBatch({
      undos: [
        { unitId: signedUnits.latest.id },
        { unitId: signedUnits.previous.id },
      ],
    });

    expect(results).toEqual([
      { ok: true, unitId: signedUnits.latest.id, unreviewed: true },
      { ok: true, unitId: signedUnits.previous.id, unreviewed: true },
    ]);
    expect(await statsOf(fixture.batchId)).toEqual({
      experiencePoints:
        lifetimeExperience -
        signedUnits.latest.experience -
        signedUnits.previous.experience,
      currentStreak: 0,
      longestStreak: 1,
      lastReviewDate: new Date(today - 2 * dayMs),
    });
  });
});
