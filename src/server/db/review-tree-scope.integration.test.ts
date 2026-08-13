import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aiJobEvidence,
  aiJobs,
  aiReviewFindingEvidence,
  aiReviewFindings,
  aiReviewItems,
  providerConnections,
  pullRequests,
  repositories,
  reviewSnapshots,
  sourceBlobs,
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
  blobId: randomUUID(),
  parentJobId: randomUUID(),
  childJobId: randomUUID(),
  foreignParentJobId: randomUUID(),
  foreignChildJobId: randomUUID(),
  itemId: randomUUID(),
  waivedItemId: randomUUID(),
  evidenceId: randomUUID(),
  foreignEvidenceId: randomUUID(),
  findingId: `finding-${randomUUID()}`,
  foreignFindingId: `foreign-${randomUUID()}`,
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
  await db.insert(reviewSnapshots).values({
    id: fixture.snapshotId,
    pullRequestId: fixture.pullRequestId,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    version: 1,
  });
  await db.insert(sourceBlobs).values({
    id: fixture.blobId,
    workspaceId: fixture.workspaceId,
    digest: "c".repeat(64),
    storage: "local",
    state: "ready",
    byteLength: 64,
  });
  // Two deep reviews of the same pull request, each with an agent of its own.
  // That is exactly when a child job id can be paired with the wrong run.
  const job = {
    workspaceId: fixture.workspaceId,
    pullRequestId: fixture.pullRequestId,
    snapshotId: fixture.snapshotId,
    userId: fixture.userId,
  };
  await db.insert(aiJobs).values([
    { ...job, id: fixture.parentJobId, kind: "review" },
    { ...job, id: fixture.foreignParentJobId, kind: "review" },
    {
      ...job,
      id: fixture.childJobId,
      kind: "review_file",
      parentJobId: fixture.parentJobId,
    },
    {
      ...job,
      id: fixture.foreignChildJobId,
      kind: "review_file",
      parentJobId: fixture.foreignParentJobId,
    },
  ]);
  await db.insert(aiReviewItems).values({
    id: fixture.itemId,
    parentJobId: fixture.parentJobId,
    workspaceId: fixture.workspaceId,
    childJobId: fixture.childJobId,
    path: "src/integration.ts",
    changeType: "modified",
    changedLineCount: 4,
    fingerprint: "d".repeat(64),
  });
  const evidence = {
    sourceBlobId: fixture.blobId,
    path: "src/integration.ts",
    digest: "c".repeat(64),
    startByte: 0,
    endByte: 64,
    startLine: 1,
    endLine: 4,
  };
  await db.insert(aiJobEvidence).values([
    { ...evidence, id: fixture.evidenceId, jobId: fixture.childJobId },
    {
      ...evidence,
      id: fixture.foreignEvidenceId,
      jobId: fixture.foreignChildJobId,
    },
  ]);
});

afterAll(async () => {
  // Evidence pins the blob it was read from with a restricting key, so the
  // jobs that hold it go first; the user then unwinds the rest of the fixture.
  await db.delete(aiJobs).where(eq(aiJobs.workspaceId, fixture.workspaceId));
  await db.delete(users).where(eq(users.id, fixture.userId));
});

describe("deep review item agent scope", () => {
  it("confines an item's agent to the run the item belongs to", async () => {
    // The foreign child is a real agent of a real deep review, just not this
    // one, so a single-column key would take it: an item could hand its file
    // to an agent whose findings belong to another review entirely.
    await expect(
      db.insert(aiReviewItems).values({
        parentJobId: fixture.parentJobId,
        workspaceId: fixture.workspaceId,
        childJobId: fixture.foreignChildJobId,
        path: "src/foreign.ts",
        changeType: "modified",
        changedLineCount: 1,
        fingerprint: "e".repeat(64),
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("leaves an item that claims no agent unconstrained", async () => {
    // A waived file names no child job, and MATCH SIMPLE skips a composite key
    // whenever one of its columns is null. That is what keeps a waived item in
    // the coverage denominator instead of refusing to record it at all.
    await db.insert(aiReviewItems).values({
      id: fixture.waivedItemId,
      parentJobId: fixture.parentJobId,
      workspaceId: fixture.workspaceId,
      childJobId: null,
      path: "src/waived.ts",
      changeType: "modified",
      changedLineCount: 0,
      state: "waived",
      fingerprint: "f".repeat(64),
    });
    await expect(
      db.query.aiReviewItems.findFirst({
        where: eq(aiReviewItems.id, fixture.waivedItemId),
      }),
    ).resolves.toMatchObject({ childJobId: null });
  });
});

describe("deep review finding agent scope", () => {
  it("confines a finding to the agent its item ran", async () => {
    const finding = {
      itemId: fixture.itemId,
      workspaceId: fixture.workspaceId,
      path: "src/integration.ts",
      severity: "medium" as const,
      category: "bug" as const,
      encryptedContent: "sealed",
    };
    // A finding filed against this item by another run's agent would put a
    // claim nobody in this review can audit onto this review's file.
    await expect(
      db.insert(aiReviewFindings).values({
        ...finding,
        id: fixture.foreignFindingId,
        jobId: fixture.foreignChildJobId,
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    await db
      .insert(aiReviewFindings)
      .values({ ...finding, id: fixture.findingId, jobId: fixture.childJobId });
    await expect(
      db.query.aiReviewFindings.findFirst({
        where: eq(aiReviewFindings.id, fixture.findingId),
      }),
    ).resolves.toMatchObject({ jobId: fixture.childJobId });
  });
});

describe("deep review evidence link scope", () => {
  it("grounds a finding only on what its own agent read", async () => {
    // The foreign range was genuinely read, just not by the agent that filed
    // this finding, so grounding on it would prove nothing about this claim.
    await expect(
      db.insert(aiReviewFindingEvidence).values({
        findingId: fixture.findingId,
        evidenceId: fixture.foreignEvidenceId,
        jobId: fixture.childJobId,
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    // Naming the reading agent instead moves the mismatch to the finding end.
    await expect(
      db.insert(aiReviewFindingEvidence).values({
        findingId: fixture.findingId,
        evidenceId: fixture.foreignEvidenceId,
        jobId: fixture.foreignChildJobId,
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    await db.insert(aiReviewFindingEvidence).values({
      findingId: fixture.findingId,
      evidenceId: fixture.evidenceId,
      jobId: fixture.childJobId,
    });
    await expect(
      db.query.aiReviewFindingEvidence.findFirst({
        where: and(
          eq(aiReviewFindingEvidence.findingId, fixture.findingId),
          eq(aiReviewFindingEvidence.evidenceId, fixture.evidenceId),
        ),
      }),
    ).resolves.toMatchObject({ jobId: fixture.childJobId });
  });
});

describe("deep review agent removal", () => {
  it("keeps the file counted once its agent is gone", async () => {
    // Scoping a file to its agent must not put the sealed denominator at the
    // agent's mercy: removing the job voids the item's claim on it and takes
    // the findings with it, while the file stays counted as work this run
    // committed to reviewing.
    await db.delete(aiJobs).where(eq(aiJobs.id, fixture.childJobId));
    await expect(
      db.query.aiReviewItems.findFirst({
        where: eq(aiReviewItems.id, fixture.itemId),
      }),
    ).resolves.toMatchObject({ childJobId: null });
    await expect(
      db.query.aiReviewFindings.findFirst({
        where: eq(aiReviewFindings.id, fixture.findingId),
      }),
    ).resolves.toBeUndefined();
  });
});
