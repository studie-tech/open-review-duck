import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  aiJobs,
  aiReviewItems,
  providerConnections,
  pullRequests,
  repositories,
  reviewSnapshots,
  snapshotFiles,
  users,
  workspaces,
} from "@/drizzle/schema";
import { db } from "~/server/db";
import { cancelDeepReviewTree } from "./cancel";
import { finalizeDeepReview } from "./finalize";
import { sealReviewPlan } from "./plan";

const fixture = {
  userId: `deep-locks-${randomUUID()}`,
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  repositoryId: randomUUID(),
  pullRequestId: randomUUID(),
  snapshotId: randomUUID(),
};

beforeAll(async () => {
  await db.insert(users).values({ id: fixture.userId });
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    ownerId: fixture.userId,
    name: "Deep review lock workspace",
    slug: `deep-locks-${randomUUID()}`,
  });
  await db.insert(providerConnections).values({
    id: fixture.connectionId,
    workspaceId: fixture.workspaceId,
    provider: "github",
    externalAccountId: `deep-locks-${randomUUID()}`,
    displayName: "Deep review lock connection",
  });
  await db.insert(repositories).values({
    id: fixture.repositoryId,
    workspaceId: fixture.workspaceId,
    connectionId: fixture.connectionId,
    externalId: `repository-${randomUUID()}`,
    owner: "reviewduck",
    name: "deep-locks",
    defaultBranch: "main",
    webUrl: "https://github.com/reviewduck/deep-locks",
  });
  await db.insert(pullRequests).values({
    id: fixture.pullRequestId,
    repositoryId: fixture.repositoryId,
    externalId: `pull-request-${randomUUID()}`,
    number: 1,
    title: "Deep review locks",
    authorLogin: "reviewduck",
    sourceBranch: "feature",
    targetBranch: "main",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    webUrl: "https://github.com/reviewduck/deep-locks/pull/1",
  });
  await db.insert(reviewSnapshots).values({
    id: fixture.snapshotId,
    pullRequestId: fixture.pullRequestId,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    version: 1,
  });
});

afterEach(async () => {
  await db.delete(aiJobs).where(eq(aiJobs.workspaceId, fixture.workspaceId));
  await db
    .delete(snapshotFiles)
    .where(eq(snapshotFiles.snapshotId, fixture.snapshotId));
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
});

describe("deep review locks", () => {
  it("seals one plan when two callers race", async () => {
    await db.insert(snapshotFiles).values([
      {
        snapshotId: fixture.snapshotId,
        path: "src/a.bin",
        language: "text",
        changeType: "added",
        isBinary: true,
        additions: 4,
        deletions: 0,
      },
      {
        snapshotId: fixture.snapshotId,
        path: "src/b.bin",
        language: "text",
        changeType: "added",
        isBinary: true,
        additions: 3,
        deletions: 0,
      },
    ]);
    const parentId = randomUUID();
    await db.insert(aiJobs).values({
      id: parentId,
      workspaceId: fixture.workspaceId,
      pullRequestId: fixture.pullRequestId,
      snapshotId: fixture.snapshotId,
      userId: fixture.userId,
      kind: "review",
      status: "queued",
    });

    const [first, second] = await Promise.all([
      sealReviewPlan(db, parentId),
      sealReviewPlan(db, parentId),
    ]);
    expect(first).toEqual(second);
    const items = await db.query.aiReviewItems.findMany({
      where: eq(aiReviewItems.parentJobId, parentId),
    });
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.path))).toEqual(
      new Set(["src/a.bin", "src/b.bin"]),
    );
    expect(items.every((item) => item.state === "waived")).toBe(true);
  });

  it("keeps finalize and cancel on one cancelled coverage partition", async () => {
    const parentId = randomUUID();
    const childId = randomUUID();
    const itemId = randomUUID();
    await db.insert(aiJobs).values({
      id: parentId,
      workspaceId: fixture.workspaceId,
      pullRequestId: fixture.pullRequestId,
      snapshotId: fixture.snapshotId,
      userId: fixture.userId,
      kind: "review",
      status: "running",
    });
    await db.insert(aiJobs).values({
      id: childId,
      workspaceId: fixture.workspaceId,
      pullRequestId: fixture.pullRequestId,
      snapshotId: fixture.snapshotId,
      userId: fixture.userId,
      parentJobId: parentId,
      kind: "review_file",
      status: "running",
    });
    await db.insert(aiReviewItems).values({
      id: itemId,
      parentJobId: parentId,
      workspaceId: fixture.workspaceId,
      childJobId: childId,
      path: "src/file.ts",
      changeType: "modified",
      changedLineCount: 8,
      state: "selected",
      fingerprint: "e".repeat(64),
    });

    await Promise.all([
      cancelDeepReviewTree(db, parentId),
      finalizeDeepReview(db, parentId),
    ]);

    const item = await db.query.aiReviewItems.findFirst({
      where: eq(aiReviewItems.id, itemId),
    });
    expect(item).toMatchObject({
      state: "failed",
      failureClass: "cancelled",
    });
    const parent = await db.query.aiJobs.findFirst({
      where: eq(aiJobs.id, parentId),
    });
    expect(parent?.deepReviewTerminalState).toBeTruthy();
  });
});
