import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  aiJobs,
  managedAiModels,
  providerConnections,
  pullRequests,
  repositories,
  reviewSnapshots,
  reviewUnits,
  users,
  workspaceMembers,
  workspaces,
} from "@/drizzle/schema";
import { db } from "~/server/db";

const modelId = `idempotency-${randomUUID()}`;

vi.mock("~/server/deployment", () => ({
  isLocalDeployment: () => false,
}));

vi.mock("~/server/ai/plan", () => ({
  managedAiMonthlyTokenLimit: () => 1_000_000,
  managedAiMonthWindow: (now: Date) => ({
    startsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    resetsAt: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ),
  }),
  managedSaasModel: () => modelId,
}));

import { createAiJob } from "./service";

const fixture = {
  userId: `question-idempotency-${randomUUID()}`,
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  repositoryId: randomUUID(),
  pullRequestId: randomUUID(),
  snapshotId: randomUUID(),
  unitId: randomUUID(),
};

beforeAll(async () => {
  await db.insert(managedAiModels).values({
    modelId,
    name: "Question idempotency integration model",
    contextLength: 128_000,
    promptNanoUsdPerToken: 1,
    completionNanoUsdPerToken: 1,
    supportsTools: true,
    synchronizedAt: new Date(),
  });
  await db.insert(users).values({ id: fixture.userId });
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    ownerId: fixture.userId,
    name: "Question idempotency integration workspace",
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
    name: "question-idempotency",
    defaultBranch: "main",
    webUrl: "https://github.com/reviewduck/question-idempotency",
  });
  await db.insert(pullRequests).values({
    id: fixture.pullRequestId,
    repositoryId: fixture.repositoryId,
    externalId: `pull-request-${randomUUID()}`,
    number: 1,
    title: "Question idempotency",
    authorLogin: "reviewduck",
    sourceBranch: "feature",
    targetBranch: "main",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    webUrl: "https://github.com/reviewduck/question-idempotency/pull/1",
  });
  await db.insert(reviewSnapshots).values({
    id: fixture.snapshotId,
    pullRequestId: fixture.pullRequestId,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    version: 1,
  });
  await db.insert(reviewUnits).values({
    id: fixture.unitId,
    snapshotId: fixture.snapshotId,
    stableKey: "src/idempotent.ts:function:review",
    path: "src/idempotent.ts",
    language: "typescript",
    kind: "function",
    name: "review",
    startLine: 1,
    endLine: 20,
    contentHash: "c".repeat(64),
    semanticHash: "d".repeat(64),
    reviewOrder: 1,
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
  await db.delete(managedAiModels).where(eq(managedAiModels.modelId, modelId));
});

describe("focused AI question idempotency", () => {
  it("returns one job when the same client request arrives concurrently", async () => {
    const clientRequestId = randomUUID();
    const input = {
      clientRequestId,
      focusLine: 12,
      kind: "explain" as const,
      pullRequestId: fixture.pullRequestId,
      question: "Why is this guard needed?",
      subscribed: false,
      threadId: randomUUID(),
      unitId: fixture.unitId,
      userId: fixture.userId,
    };

    const [first, replay] = await Promise.all([
      createAiJob(db, input),
      createAiJob(db, input),
    ]);

    expect(replay.id).toBe(first.id);
    const persisted = await db.query.aiJobs.findMany({
      where: and(
        eq(aiJobs.userId, fixture.userId),
        eq(aiJobs.clientRequestId, clientRequestId),
      ),
    });
    expect(persisted).toHaveLength(1);
  });

  it("rejects reuse of a request identity for different input", async () => {
    const clientRequestId = randomUUID();
    const input = {
      clientRequestId,
      focusLine: 12,
      kind: "explain" as const,
      pullRequestId: fixture.pullRequestId,
      question: "Why is this guard needed?",
      subscribed: false,
      threadId: randomUUID(),
      unitId: fixture.unitId,
      userId: fixture.userId,
    };
    await createAiJob(db, input);

    await expect(
      createAiJob(db, { ...input, question: "A different question" }),
    ).rejects.toThrow("AI request identity was reused for different input");
  });
});
