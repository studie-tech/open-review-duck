import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  providerConnections,
  pullRequests,
  repositories,
  reviewConceptLayouts,
  reviewConceptDependencies,
  reviewConceptMembers,
  reviewConcepts,
  reviewSnapshots,
  reviewUnits,
  users,
  workspaces,
} from "@/drizzle/schema";
import { db } from "~/server/db";

const fixture = {
  userId: `integration-${randomUUID()}`,
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  repositoryId: randomUUID(),
  pullRequestId: randomUUID(),
  snapshotId: randomUUID(),
  unitId: randomUUID(),
  baselineLayoutId: randomUUID(),
  personalLayoutId: randomUUID(),
  personalConceptId: randomUUID(),
  baselineConceptId: randomUUID(),
  foreignSnapshotId: randomUUID(),
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
  await db.insert(reviewSnapshots).values([
    {
      id: fixture.snapshotId,
      pullRequestId: fixture.pullRequestId,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      version: 1,
    },
    {
      id: fixture.foreignSnapshotId,
      pullRequestId: fixture.pullRequestId,
      headSha: "c".repeat(40),
      baseSha: "b".repeat(40),
      version: 2,
    },
  ]);
  await db.insert(reviewUnits).values({
    id: fixture.unitId,
    snapshotId: fixture.snapshotId,
    stableKey: "integration:unit",
    path: "src/integration.ts",
    language: "typescript",
    kind: "function",
    name: "integration",
    startLine: 1,
    endLine: 4,
    contentHash: "c".repeat(64),
    semanticHash: "d".repeat(64),
    reviewOrder: 0,
  });
  // A shared baseline and the reviewer's personal layout coexist on one
  // snapshot, which is exactly when a concept id can be paired with the wrong
  // layout id.
  await db.insert(reviewConceptLayouts).values([
    {
      id: fixture.baselineLayoutId,
      snapshotId: fixture.snapshotId,
      source: "deterministic",
    },
    {
      id: fixture.personalLayoutId,
      snapshotId: fixture.snapshotId,
      userId: fixture.userId,
      source: "manual",
    },
  ]);
  await db.insert(reviewConcepts).values([
    {
      id: fixture.personalConceptId,
      layoutId: fixture.personalLayoutId,
      stableKey: "concept:personal",
      title: "Personal concept",
      reviewOrder: 0,
      changedLineCount: 1,
      fileCount: 1,
    },
    {
      id: fixture.baselineConceptId,
      layoutId: fixture.baselineLayoutId,
      stableKey: "concept:baseline",
      title: "Baseline concept",
      reviewOrder: 0,
      changedLineCount: 1,
      fileCount: 1,
    },
  ]);
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
});

describe("review concept membership snapshot scope", () => {
  it("confines a member to a unit of the layout's own snapshot", async () => {
    // A layout partitions one snapshot. A membership naming a unit from
    // another revision would place work the reviewer is not looking at into
    // the path they are.
    await expect(
      db.insert(reviewConceptMembers).values({
        layoutId: fixture.personalLayoutId,
        conceptId: fixture.personalConceptId,
        unitId: fixture.unitId,
        snapshotId: fixture.foreignSnapshotId,
        memberOrder: 0,
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });
});

describe("review concept dependency scope", () => {
  it("confines both ends of an edge to one layout", async () => {
    // An edge whose two concepts live in different layouts would order a
    // review path against work the reviewer is not looking at.
    await expect(
      db.insert(reviewConceptDependencies).values({
        layoutId: fixture.personalLayoutId,
        conceptId: fixture.personalConceptId,
        dependencyId: fixture.baselineConceptId,
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    await expect(
      db.insert(reviewConceptDependencies).values({
        layoutId: fixture.baselineLayoutId,
        conceptId: fixture.personalConceptId,
        dependencyId: fixture.baselineConceptId,
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });
});

describe("review concept membership scope", () => {
  it("confines a member to the layout its concept lives in", async () => {
    await expect(
      db.insert(reviewConceptMembers).values({
        layoutId: fixture.baselineLayoutId,
        conceptId: fixture.personalConceptId,
        unitId: fixture.unitId,
        snapshotId: fixture.snapshotId,
        memberOrder: 0,
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    await db.insert(reviewConceptMembers).values({
      layoutId: fixture.personalLayoutId,
      conceptId: fixture.personalConceptId,
      unitId: fixture.unitId,
      snapshotId: fixture.snapshotId,
      memberOrder: 0,
    });
    await db
      .delete(reviewConcepts)
      .where(eq(reviewConcepts.id, fixture.personalConceptId));
    await expect(
      db.query.reviewConceptMembers.findFirst({
        where: and(
          eq(reviewConceptMembers.layoutId, fixture.personalLayoutId),
          eq(reviewConceptMembers.unitId, fixture.unitId),
        ),
      }),
    ).resolves.toBeUndefined();
  });
});
