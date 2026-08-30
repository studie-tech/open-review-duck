import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  providerConnections,
  pullRequests,
  repositories,
  reviewSnapshots,
  users,
  workspaces,
} from "@/drizzle/schema";
import { db } from "~/server/db";
import { pruneExpiredReviewSnapshots } from "./retention";

const fixture = {
  userId: `integration-${randomUUID()}`,
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  repositoryId: randomUUID(),
  retainedPullRequestId: randomUUID(),
  agedPullRequestId: randomUUID(),
  countedPullRequestId: randomUUID(),
};

/** Returns a timestamp the given number of days before the fixture run. */
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

/** Builds the columns a snapshot needs beyond its identity and ordering. */
const snapshot = (pullRequestId: string, version: number, createdAt: Date) => ({
  id: randomUUID(),
  pullRequestId,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  version,
  createdAt,
});

/** Builds the columns a pull request needs beyond its identity. */
const pullRequest = (id: string, number: number) => ({
  id,
  repositoryId: fixture.repositoryId,
  externalId: `pull-request-${randomUUID()}`,
  number,
  title: `Integration pull request ${number}`,
  authorLogin: "reviewduck",
  sourceBranch: "feature",
  targetBranch: "main",
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  webUrl: `https://github.com/reviewduck/integration/pull/${number}`,
});

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
    sourceRetentionDays: 30,
    sourceRetentionSnapshots: 2,
  });
  await db
    .insert(pullRequests)
    .values([
      pullRequest(fixture.retainedPullRequestId, 1),
      pullRequest(fixture.agedPullRequestId, 2),
      pullRequest(fixture.countedPullRequestId, 3),
    ]);
  await db
    .insert(reviewSnapshots)
    .values([
      snapshot(fixture.retainedPullRequestId, 1, daysAgo(3)),
      snapshot(fixture.retainedPullRequestId, 2, daysAgo(1)),
      snapshot(fixture.agedPullRequestId, 1, daysAgo(40)),
      snapshot(fixture.agedPullRequestId, 2, daysAgo(1)),
      snapshot(fixture.countedPullRequestId, 1, daysAgo(4)),
      snapshot(fixture.countedPullRequestId, 2, daysAgo(3)),
      snapshot(fixture.countedPullRequestId, 3, daysAgo(2)),
      snapshot(fixture.countedPullRequestId, 4, daysAgo(1)),
    ]);
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
});

/** Returns the surviving snapshot versions of one pull request. */
async function survivingVersions(pullRequestId: string) {
  const rows = await db
    .select({ version: reviewSnapshots.version })
    .from(reviewSnapshots)
    .where(eq(reviewSnapshots.pullRequestId, pullRequestId))
    .orderBy(asc(reviewSnapshots.version));
  return rows.map(({ version }) => version);
}

describe("pruneExpiredReviewSnapshots", () => {
  it("prunes past both boundaries and leaves compliant pull requests whole", async () => {
    expect(await pruneExpiredReviewSnapshots(db, fixture.repositoryId)).toEqual(
      3,
    );

    expect(await survivingVersions(fixture.retainedPullRequestId)).toEqual([
      1, 2,
    ]);
    expect(await survivingVersions(fixture.agedPullRequestId)).toEqual([2]);
    expect(await survivingVersions(fixture.countedPullRequestId)).toEqual([
      3, 4,
    ]);
  });
});
