import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  aiConfigurations,
  aiJobs,
  aiUsage,
  providerConnections,
  pullRequests,
  rateLimits,
  repositories,
  reviewComments,
  reviewSnapshots,
  reviewUnits,
  signOffs,
  users,
  workspaceMembers,
  workspaces,
} from "@/drizzle/schema";
import { env } from "~/env";
import { createCaller } from "~/server/api/root";
import { db } from "~/server/db";
import { claimFailedCommentForPublication } from "~/server/review/comments";
import { reviewCompletionCounts } from "~/server/review/completion";
import { encryptSecret } from "~/server/security/encryption";
import {
  enforceRateLimit,
  pruneExpiredRateLimits,
} from "~/server/security/rate-limit";
import { pruneExpiredReviewSnapshots } from "~/server/sync/retention";
import { syncPullRequest } from "~/server/sync/service";
import { requireWorkspaceAdministrator } from "~/server/workspaces/access";
import {
  acceptAiJobResult,
  createAiExplanationJobs,
  createAiJob,
  settleAiJobQuota,
} from "./service";

vi.mock("server-only", () => ({}));
const providerMock = vi.hoisted(() => vi.fn());
vi.mock("~/server/providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/server/providers")>()),
  createProvider: providerMock,
}));

const createdUsers: string[] = [];

/** Creates a complete isolated review scope for lifecycle integration tests. */
async function createReviewScope() {
  const suffix = randomUUID();
  const userId = `integration-${suffix}`;
  createdUsers.push(userId);
  await db.insert(users).values({ id: userId, displayName: "Integration" });
  const [workspace] = await db
    .insert(workspaces)
    .values({
      ownerId: userId,
      name: "Integration",
      slug: `integration-${suffix}`,
    })
    .returning();
  if (!workspace) throw new Error("workspace setup failed");
  await db.insert(workspaceMembers).values({
    workspaceId: workspace.id,
    userId,
    role: "owner",
  });
  const [connection] = await db
    .insert(providerConnections)
    .values({
      workspaceId: workspace.id,
      provider: "github",
      externalAccountId: suffix,
      credentialFingerprint: "a".repeat(64),
      displayName: "Integration",
      encryptedAccessToken: encryptSecret("unused", env.ENCRYPTION_KEY),
    })
    .returning();
  if (!connection) throw new Error("connection setup failed");
  const [repository] = await db
    .insert(repositories)
    .values({
      connectionId: connection.id,
      externalId: suffix,
      owner: "integration",
      name: "reviewduck",
      defaultBranch: "main",
      webUrl: "https://example.com/repository",
    })
    .returning();
  if (!repository) throw new Error("repository setup failed");
  const [pullRequest] = await db
    .insert(pullRequests)
    .values({
      repositoryId: repository.id,
      externalId: suffix,
      number: 1,
      title: "Integration",
      authorLogin: "reviewer",
      sourceBranch: "feature",
      targetBranch: "main",
      headSha: "1".repeat(40),
      baseSha: "2".repeat(40),
      webUrl: "https://example.com/pull/1",
    })
    .returning();
  if (!pullRequest) throw new Error("pull request setup failed");
  const [snapshot] = await db
    .insert(reviewSnapshots)
    .values({
      pullRequestId: pullRequest.id,
      headSha: pullRequest.headSha,
      baseSha: pullRequest.baseSha,
      version: 1,
    })
    .returning();
  if (!snapshot) throw new Error("snapshot setup failed");
  const [unit] = await db
    .insert(reviewUnits)
    .values({
      snapshotId: snapshot.id,
      stableKey: `function:${suffix}`,
      path: "src/example.ts",
      language: "typescript",
      kind: "function",
      name: "example",
      startLine: 1,
      endLine: 3,
      source: "/** Example. */\nfunction example() { return 1; }",
      previousSource: "/** Previous. */\nfunction example() { return 0; }",
      contentHash: "3".repeat(64),
      semanticHash: "4".repeat(64),
      reviewOrder: 0,
    })
    .returning();
  if (!unit) throw new Error("unit setup failed");
  await db.insert(aiConfigurations).values({
    workspaceId: workspace.id,
    provider: "openai",
    model: "managed-test",
    useManagedModels: true,
  });
  return { userId, workspace, repository, pullRequest, snapshot, unit };
}

afterAll(async () => {
  for (const userId of createdUsers) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("AI job lifecycle", () => {
  it("creates pending explanations in one deduplicated batch", async () => {
    const scope = await createReviewScope();
    const [secondUnit] = await db
      .insert(reviewUnits)
      .values({
        snapshotId: scope.snapshot.id,
        stableKey: `function:${randomUUID()}`,
        path: "src/second.ts",
        language: "typescript",
        kind: "function",
        name: "second",
        startLine: 1,
        endLine: 2,
        source: "/** Returns two. */\nfunction second() { return 2; }",
        contentHash: "7".repeat(64),
        semanticHash: "8".repeat(64),
        reviewOrder: 1,
      })
      .returning();
    if (!secondUnit) throw new Error("second unit setup failed");
    const input = {
      pullRequestId: scope.pullRequest.id,
      unitIds: [scope.unit.id, secondUnit.id],
      userId: scope.userId,
      hasManagedAi: true,
    };

    const first = await createAiExplanationJobs(db, input);
    const second = await createAiExplanationJobs(db, input);

    expect(first.created).toBe(2);
    expect(first.alreadyRunning).toBe(0);
    expect(second.created).toBe(0);
    expect(second.alreadyRunning).toBe(2);
    const usage = await db.query.aiUsage.findFirst({
      where: eq(aiUsage.workspaceId, scope.workspace.id),
    });
    expect(usage?.requests).toBe(2);
  });

  it("deduplicates concurrent starts and refunds a failed reservation once", async () => {
    const scope = await createReviewScope();
    const input = {
      pullRequestId: scope.pullRequest.id,
      unitId: scope.unit.id,
      kind: "explain" as const,
      userId: scope.userId,
      hasManagedAi: true,
    };
    const [first, second] = await Promise.all([
      createAiJob(db, input),
      createAiJob(db, input),
    ]);
    expect(second.id).toBe(first.id);
    const reserved = await db.query.aiUsage.findFirst({
      where: eq(aiUsage.workspaceId, scope.workspace.id),
    });
    expect(reserved?.requests).toBe(1);
    expect(reserved?.reservedInputTokens).toBeGreaterThan(0);
    expect(reserved?.reservedOutputTokens).toBe(2_000);

    await Promise.all([
      settleAiJobQuota(db, first.id),
      settleAiJobQuota(db, first.id),
    ]);
    const settled = await db.query.aiUsage.findFirst({
      where: eq(aiUsage.workspaceId, scope.workspace.id),
    });
    expect(settled?.reservedInputTokens).toBe(0);
    expect(settled?.reservedOutputTokens).toBe(0);
    expect(settled?.inputTokens).toBe(0);
  });

  it("charges the full reservation when completed usage cannot be recovered", async () => {
    const scope = await createReviewScope();
    const job = await createAiJob(db, {
      pullRequestId: scope.pullRequest.id,
      unitId: scope.unit.id,
      kind: "explain",
      userId: scope.userId,
      hasManagedAi: true,
    });
    await db
      .update(aiJobs)
      .set({ status: "running" })
      .where(eq(aiJobs.id, job.id));
    await acceptAiJobResult(db, job.id, {
      summary: "Reviewed",
      annotations: [],
      findings: [],
    });

    await settleAiJobQuota(db, job.id);

    const settledJob = await db.query.aiJobs.findFirst({
      where: eq(aiJobs.id, job.id),
    });
    const usage = await db.query.aiUsage.findFirst({
      where: eq(aiUsage.workspaceId, scope.workspace.id),
    });
    expect(settledJob?.inputTokens).toBe(job.reservedInputTokens);
    expect(settledJob?.outputTokens).toBe(job.reservedOutputTokens);
    expect(settledJob?.totalTokens).toBe(
      job.reservedInputTokens + job.reservedOutputTokens,
    );
    expect(usage?.reservedInputTokens).toBe(0);
    expect(usage?.reservedOutputTokens).toBe(0);
    expect(usage?.inputTokens).toBe(job.reservedInputTokens);
    expect(usage?.outputTokens).toBe(job.reservedOutputTokens);
  });

  it("serializes reservations so concurrent jobs cannot exceed the weekly cap", async () => {
    const scope = await createReviewScope();
    const largeSource = "x".repeat(62_000);
    await db
      .update(reviewUnits)
      .set({ source: largeSource, previousSource: largeSource })
      .where(eq(reviewUnits.id, scope.unit.id));
    const [secondUnit] = await db
      .insert(reviewUnits)
      .values({
        snapshotId: scope.snapshot.id,
        stableKey: `function:${randomUUID()}`,
        path: "src/second.ts",
        language: "typescript",
        kind: "function",
        name: "second",
        startLine: 1,
        endLine: 2,
        source: largeSource,
        previousSource: largeSource,
        contentHash: "7".repeat(64),
        semanticHash: "8".repeat(64),
        reviewOrder: 1,
      })
      .returning();
    if (!secondUnit) throw new Error("second unit setup failed");

    const results = await Promise.allSettled(
      [scope.unit.id, secondUnit.id].map((unitId) =>
        createAiJob(db, {
          pullRequestId: scope.pullRequest.id,
          unitId,
          kind: "explain",
          userId: scope.userId,
          hasManagedAi: true,
        }),
      ),
    );
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    const usage = await db.query.aiUsage.findFirst({
      where: eq(aiUsage.workspaceId, scope.workspace.id),
    });
    expect(
      (usage?.reservedInputTokens ?? 0) + (usage?.reservedOutputTokens ?? 0),
    ).toBeLessThanOrEqual(env.MANAGED_AI_WEEKLY_TOKEN_LIMIT);
  });

  it("rejects a user from another tenant", async () => {
    const scope = await createReviewScope();
    const outsider = `integration-${randomUUID()}`;
    createdUsers.push(outsider);
    await db.insert(users).values({ id: outsider, displayName: "Outsider" });
    await expect(
      createAiJob(db, {
        pullRequestId: scope.pullRequest.id,
        unitId: scope.unit.id,
        kind: "explain",
        userId: outsider,
        hasManagedAi: true,
      }),
    ).rejects.toThrow("Pull request not found");
  });

  it("does not let an ordinary workspace member change shared settings", async () => {
    const scope = await createReviewScope();
    const member = `integration-${randomUUID()}`;
    createdUsers.push(member);
    await db.insert(users).values({ id: member, displayName: "Member" });
    await db.insert(workspaceMembers).values({
      workspaceId: scope.workspace.id,
      userId: member,
      role: "member",
    });
    await expect(
      requireWorkspaceAdministrator(db, scope.workspace.id, member),
    ).rejects.toThrow("Workspace administrator access required");
  });

  it("leases a failed provider comment to only one concurrent retry", async () => {
    const scope = await createReviewScope();
    const [comment] = await db
      .insert(reviewComments)
      .values({
        unitId: scope.unit.id,
        userId: scope.userId,
        source: "user",
        body: "Please clarify this branch.",
        line: 2,
        status: "failed",
        error: "Provider temporarily unavailable",
      })
      .returning();
    if (!comment) throw new Error("comment setup failed");

    const claimed = await Promise.all([
      claimFailedCommentForPublication(db, comment.id),
      claimFailedCommentForPublication(db, comment.id),
    ]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
  });

  it("shares rate-limit state through the database", async () => {
    const key = `integration:${randomUUID()}`;
    await expect(enforceRateLimit(db, key, 1, 60_000)).resolves.toBeUndefined();
    await expect(enforceRateLimit(db, key, 1, 60_000)).rejects.toThrow(
      "Too many requests",
    );
  });

  it("removes limiter windows after they expire", async () => {
    const key = `expired:${randomUUID()}`;
    await db.insert(rateLimits).values({
      key,
      count: 10,
      expiresAt: new Date(Date.now() - 1_000),
    });

    await expect(pruneExpiredRateLimits(db)).resolves.toBeGreaterThan(0);
    await expect(
      db.query.rateLimits.findFirst({ where: eq(rateLimits.key, key) }),
    ).resolves.toBeUndefined();
  });

  it("exports review decisions and AI history with repository source data", async () => {
    const scope = await createReviewScope();
    await db.insert(signOffs).values({
      unitId: scope.unit.id,
      userId: scope.userId,
      semanticHash: scope.unit.semanticHash,
    });
    await db.insert(reviewComments).values({
      unitId: scope.unit.id,
      userId: scope.userId,
      source: "user",
      body: "Please clarify this branch.",
      line: 2,
      status: "published",
      providerExternalId: "42",
    });
    await createAiJob(db, {
      pullRequestId: scope.pullRequest.id,
      unitId: scope.unit.id,
      kind: "explain",
      userId: scope.userId,
      hasManagedAi: true,
    });

    const caller = createCaller({
      db,
      auth: { userId: scope.userId, has: () => false },
      headers: new Headers(),
    });
    const [exported, workspace, configuration, guidance] = await Promise.all([
      caller.provider.exportRepositoryData({
        repositoryId: scope.repository.id,
      }),
      caller.review.workspace({ pullRequestId: scope.pullRequest.id }),
      caller.ai.configuration(),
      caller.workspace.guidance(),
    ]);

    expect(exported.units).toHaveLength(1);
    expect(exported.signOffs).toHaveLength(1);
    expect(exported.comments).toHaveLength(1);
    expect(exported.aiJobs).toHaveLength(1);
    expect(exported).toHaveProperty("waits");
    expect(exported).toHaveProperty("sessions");
    expect(workspace.units).toHaveLength(1);
    expect(configuration.configuration?.model).toBe("managed-test");
    expect(guidance.hasProviderConnection).toBe(true);
  });

  it("sweeps expired source even when a pull request is inactive", async () => {
    const scope = await createReviewScope();
    await db
      .update(repositories)
      .set({ sourceRetentionDays: 1 })
      .where(eq(repositories.id, scope.repository.id));
    await db
      .update(reviewSnapshots)
      .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(eq(reviewSnapshots.id, scope.snapshot.id));

    await expect(
      pruneExpiredReviewSnapshots(db, scope.repository.id),
    ).resolves.toBe(1);
    await expect(
      db.query.reviewSnapshots.findFirst({
        where: eq(reviewSnapshots.id, scope.snapshot.id),
      }),
    ).resolves.toBeUndefined();
  });

  it("downloads provider data before committing a fenced synchronization", async () => {
    const scope = await createReviewScope();
    const remote = {
      externalId: scope.pullRequest.externalId,
      number: scope.pullRequest.number,
      title: "Updated integration review",
      authorLogin: "reviewer",
      sourceBranch: "feature",
      targetBranch: "main",
      headSha: "5".repeat(40),
      baseSha: scope.pullRequest.baseSha,
      state: "open" as const,
      webUrl: scope.pullRequest.webUrl,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    };
    providerMock.mockReturnValue({
      getPullRequest: vi.fn().mockResolvedValue(remote),
      getChangedFiles: vi.fn().mockResolvedValue([
        {
          path: "src/updated.ts",
          content:
            "/** Returns one. */\nexport function updated() { return 1; }",
          changeType: "added",
        },
      ]),
    });

    const synchronized = await syncPullRequest(
      db,
      scope.repository.id,
      scope.pullRequest.number,
    );

    expect(synchronized.snapshotCreated).toBe(true);
    expect(synchronized.pullRequest.headSha).toBe(remote.headSha);
    expect(synchronized.unitCount).toBeGreaterThan(0);
  });

  it("persists large analyses in bounded batches", async () => {
    const scope = await createReviewScope();
    const remote = {
      externalId: scope.pullRequest.externalId,
      number: scope.pullRequest.number,
      title: "Large integration review",
      authorLogin: "reviewer",
      sourceBranch: "feature",
      targetBranch: "main",
      headSha: "6".repeat(40),
      baseSha: scope.pullRequest.baseSha,
      state: "open" as const,
      webUrl: scope.pullRequest.webUrl,
      additions: 300,
      deletions: 0,
      changedFiles: 1,
    };
    const content = Array.from(
      { length: 300 },
      (_, index) =>
        `/** Returns ${index}. */\nexport function unit${index}() { return ${index}; }`,
    ).join("\n\n");
    providerMock.mockReturnValue({
      getPullRequest: vi.fn().mockResolvedValue(remote),
      getChangedFiles: vi.fn().mockResolvedValue([
        {
          path: "src/large.ts",
          content,
          changeType: "added",
        },
      ]),
    });

    const synchronized = await syncPullRequest(
      db,
      scope.repository.id,
      scope.pullRequest.number,
    );

    expect(synchronized.snapshotCreated).toBe(true);
    expect(synchronized.unitCount).toBe(300);
    const persistedUnits = await db.query.reviewUnits.findMany({
      where: eq(reviewUnits.snapshotId, synchronized.snapshot.id),
    });
    expect(persistedUnits).toHaveLength(301);
  });

  it("does not let hidden file context prevent session completion", async () => {
    const scope = await createReviewScope();
    await db.insert(reviewUnits).values({
      snapshotId: scope.snapshot.id,
      stableKey: `file:${randomUUID()}`,
      path: "src/example.ts",
      language: "typescript",
      kind: "file",
      name: "example.ts",
      startLine: 1,
      endLine: 3,
      source: "function example() { return 1; }",
      contentHash: "5".repeat(64),
      semanticHash: "6".repeat(64),
      reviewOrder: 1,
    });
    await db.insert(signOffs).values({
      unitId: scope.unit.id,
      userId: scope.userId,
      semanticHash: scope.unit.semanticHash,
    });
    await expect(
      reviewCompletionCounts(db, scope.snapshot.id, scope.userId),
    ).resolves.toEqual({ total: 1, signed: 1 });
  });

  it("completes a submitted result idempotently without the dispatcher", async () => {
    const scope = await createReviewScope();
    const job = await createAiJob(db, {
      pullRequestId: scope.pullRequest.id,
      unitId: scope.unit.id,
      kind: "explain",
      userId: scope.userId,
      hasManagedAi: true,
    });
    await db
      .update(aiJobs)
      .set({ status: "running" })
      .where(eq(aiJobs.id, job.id));
    const result = {
      summary: "A focused explanation.",
      annotations: [
        {
          title: "Return value",
          body: "The function returns one.",
          path: scope.unit.path,
          line: 2,
        },
      ],
      findings: [],
    };
    await expect(acceptAiJobResult(db, job.id, result)).resolves.toBe(true);
    await expect(acceptAiJobResult(db, job.id, result)).resolves.toBe(true);
    await expect(
      db.query.aiJobs.findFirst({ where: eq(aiJobs.id, job.id) }),
    ).resolves.toMatchObject({ status: "completed", result });
  });
});
