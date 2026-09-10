import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  aiJobs,
  aiUsage,
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

const modelId = `quota-${randomUUID()}`;

vi.mock("~/server/deployment", () => ({
  isLocalDeployment: () => false,
}));

vi.mock("~/server/ai/plan", () => ({
  managedAiMonthlyTokenLimit: () => 100_000,
  managedAiMonthWindow: (now: Date) => ({
    startsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    resetsAt: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ),
  }),
  managedSaasModel: () => modelId,
}));

import { createAiJob, settleAiJobQuota } from "./service";

const fixture = {
  userId: `managed-quota-${randomUUID()}`,
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
    name: "Managed quota integration model",
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
    name: "Managed quota workspace",
    slug: `managed-quota-${randomUUID()}`,
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
    externalAccountId: `quota-${randomUUID()}`,
    displayName: "Quota connection",
  });
  await db.insert(repositories).values({
    id: fixture.repositoryId,
    workspaceId: fixture.workspaceId,
    connectionId: fixture.connectionId,
    externalId: `repository-${randomUUID()}`,
    owner: "reviewduck",
    name: "managed-quota",
    defaultBranch: "main",
    webUrl: "https://github.com/reviewduck/managed-quota",
  });
  await db.insert(pullRequests).values({
    id: fixture.pullRequestId,
    repositoryId: fixture.repositoryId,
    externalId: `pull-request-${randomUUID()}`,
    number: 1,
    title: "Managed quota",
    authorLogin: "reviewduck",
    sourceBranch: "feature",
    targetBranch: "main",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    webUrl: "https://github.com/reviewduck/managed-quota/pull/1",
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
    stableKey: "src/quota.ts:function:review",
    path: "src/quota.ts",
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

/** Builds a unique explain job so reservation tests do not collide. */
function explainInput() {
  return {
    clientRequestId: randomUUID(),
    focusLine: 12,
    kind: "explain" as const,
    pullRequestId: fixture.pullRequestId,
    question: "Why is this guard needed?",
    subscribed: false,
    threadId: randomUUID(),
    unitId: fixture.unitId,
    userId: fixture.userId,
  };
}

/** Returns midnight UTC for the current day, matching reserveManagedQuota. */
function utcDayStart() {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

describe("managed AI quota", () => {
  it("reserves one daily request when a managed job is created", async () => {
    const job = await createAiJob(db, explainInput());
    const usage = await db.query.aiUsage.findFirst({
      where: and(
        eq(aiUsage.workspaceId, fixture.workspaceId),
        eq(aiUsage.userId, fixture.userId),
        eq(aiUsage.day, utcDayStart()),
      ),
    });
    expect(job.id).toBeTruthy();
    expect(usage?.requests).toBeGreaterThanOrEqual(1);
  });

  it("enforces the user daily cap under concurrent creates", async () => {
    await db
      .insert(aiUsage)
      .values({
        workspaceId: fixture.workspaceId,
        userId: fixture.userId,
        day: utcDayStart(),
        requests: 9,
      })
      .onConflictDoUpdate({
        target: [aiUsage.workspaceId, aiUsage.userId, aiUsage.day],
        set: { requests: 9 },
      });

    const results = await Promise.allSettled([
      createAiJob(db, explainInput()),
      createAiJob(db, explainInput()),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      rejected[0] && rejected[0].status === "rejected"
        ? rejected[0].reason
        : undefined,
    ).toMatchObject({ message: "Daily user AI request limit reached" });

    const usage = await db.query.aiUsage.findFirst({
      where: and(
        eq(aiUsage.workspaceId, fixture.workspaceId),
        eq(aiUsage.userId, fixture.userId),
        eq(aiUsage.day, utcDayStart()),
      ),
    });
    expect(usage?.requests).toBe(10);
  });

  it("rejects a create once settled monthly tokens are at the ceiling", async () => {
    await db
      .insert(aiUsage)
      .values({
        workspaceId: fixture.workspaceId,
        userId: fixture.userId,
        day: utcDayStart(),
        requests: 0,
        inputTokens: 60_000,
        outputTokens: 40_000,
      })
      .onConflictDoUpdate({
        target: [aiUsage.workspaceId, aiUsage.userId, aiUsage.day],
        set: { requests: 0, inputTokens: 60_000, outputTokens: 40_000 },
      });

    await expect(createAiJob(db, explainInput())).rejects.toThrow(
      "Monthly AI token limit reached",
    );
  });

  it("settles usage once and ignores a second settle", async () => {
    await db
      .insert(aiUsage)
      .values({
        workspaceId: fixture.workspaceId,
        userId: fixture.userId,
        day: utcDayStart(),
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
      })
      .onConflictDoUpdate({
        target: [aiUsage.workspaceId, aiUsage.userId, aiUsage.day],
        set: { inputTokens: 0, outputTokens: 0, requests: 0 },
      });
    const job = await createAiJob(db, explainInput());
    const usage = {
      input: 50,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 60,
    };
    await settleAiJobQuota(db, job.id, usage);
    await settleAiJobQuota(db, job.id, usage);

    const persisted = await db.query.aiJobs.findFirst({
      where: eq(aiJobs.id, job.id),
    });
    expect(persisted?.quotaSettledAt).toBeTruthy();
    expect(persisted?.inputTokens).toBe(50);
    expect(persisted?.outputTokens).toBe(10);

    const day = await db.query.aiUsage.findFirst({
      where: and(
        eq(aiUsage.workspaceId, fixture.workspaceId),
        eq(aiUsage.userId, fixture.userId),
        eq(aiUsage.day, utcDayStart()),
      ),
    });
    expect(day?.inputTokens).toBe(50);
    expect(day?.outputTokens).toBe(10);
  });
});
