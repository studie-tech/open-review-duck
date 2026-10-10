import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
import type { ProviderPullRequestLifecycle } from "~/server/providers/types";
import { reviewRouter } from "./review";

const remote = vi.hoisted(() => ({
  load: vi.fn(),
  merge: vi.fn(),
  lifecycle: vi.fn(),
}));
vi.mock("~/server/review/provider-thread", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/server/review/provider-thread")>()),
  providerLifecycleForConnection: remote.load,
}));

const fixture = {
  userId: `merge-bypass-${randomUUID()}`,
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  repositoryId: randomUUID(),
  pullRequestId: randomUUID(),
  snapshotId: randomUUID(),
  unitId: randomUUID(),
};
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const lifecycle: ProviderPullRequestLifecycle = {
  checks: [],
  summary: "empty",
  headSha,
  pullRequestState: "open",
  mergeable: true,
  canMerge: false,
  hasMergePermission: true,
  canBypassMergeRequirements: true,
  mergeBypassPermission: "allowed",
  mergeBlockedReason: "Required approvals are missing",
  mergeActionLabel: "Merge",
};
const caller = createCallerFactory(reviewRouter)({
  auth: { userId: fixture.userId, has: () => false },
  db,
  headers: new Headers(),
});

beforeAll(async () => {
  await db.insert(users).values({ id: fixture.userId });
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    ownerId: fixture.userId,
    name: "Merge bypass test",
    slug: `merge-bypass-${randomUUID()}`,
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
    externalAccountId: randomUUID(),
    displayName: "Test",
  });
  await db.insert(repositories).values({
    id: fixture.repositoryId,
    workspaceId: fixture.workspaceId,
    connectionId: fixture.connectionId,
    externalId: "42",
    owner: "acme",
    name: "merge",
    defaultBranch: "main",
    webUrl: "https://github.com/acme/merge",
  });
  await db.insert(pullRequests).values({
    id: fixture.pullRequestId,
    repositoryId: fixture.repositoryId,
    externalId: "12",
    number: 12,
    title: "Bypass test",
    authorLogin: "acme",
    sourceBranch: "feature",
    targetBranch: "main",
    headSha,
    baseSha,
    webUrl: "https://github.com/acme/merge/pull/12",
  });
  await db.insert(reviewSnapshots).values({
    id: fixture.snapshotId,
    pullRequestId: fixture.pullRequestId,
    headSha,
    baseSha,
    version: 1,
  });
  await db.insert(reviewUnits).values({
    id: fixture.unitId,
    snapshotId: fixture.snapshotId,
    stableKey: "test-function",
    path: "src/test.ts",
    language: "typescript",
    kind: "function",
    name: "test",
    startLine: 1,
    endLine: 3,
    contentHash: "c".repeat(64),
    semanticHash: "d".repeat(64),
    reviewOrder: 1,
  });
  await db.insert(signOffs).values({
    unitId: fixture.unitId,
    userId: fixture.userId,
    semanticHash: "d".repeat(64),
  });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db
    .update(pullRequests)
    .set({ state: "open" })
    .where(eq(pullRequests.id, fixture.pullRequestId));
  await db
    .update(signOffs)
    .set({ invalidatedAt: null })
    .where(eq(signOffs.unitId, fixture.unitId));
  remote.load.mockResolvedValue({
    provider: {
      mergePullRequest: remote.merge,
      getPullRequestLifecycle: remote.lifecycle,
    },
    lifecycle,
    remotePullRequest: { headSha, baseSha },
  });
  remote.merge.mockResolvedValue(undefined);
  remote.lifecycle.mockResolvedValue({
    ...lifecycle,
    pullRequestState: "merged",
    canBypassMergeRequirements: false,
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
});

describe("merge bypass authorization and review invariants", () => {
  it("does not bypass by default even when the credential has permission", async () => {
    await expect(
      caller.mergePullRequest({ pullRequestId: fixture.pullRequestId }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(remote.merge).not.toHaveBeenCalled();
  });

  it("rechecks live permission and passes explicit bypass at the reviewed SHA", async () => {
    expect(
      await caller.mergePullRequest({
        pullRequestId: fixture.pullRequestId,
        bypassRequirements: true,
      }),
    ).toMatchObject({ pullRequestState: "merged" });
    expect(remote.load).toHaveBeenCalledOnce();
    expect(remote.merge).toHaveBeenCalledExactlyOnceWith({
      repositoryExternalId: "42",
      pullRequestNumber: 12,
      headSha,
      bypassRequirements: true,
      bypassReason: undefined,
    });
  });

  it.each(["denied", "unknown", "unsupported"] as const)(
    "rejects forged bypass when live permission is %s",
    async (permission) => {
      remote.load.mockResolvedValueOnce({
        lifecycle: { ...lifecycle, mergeBypassPermission: permission },
        remotePullRequest: { headSha, baseSha },
      });
      await expect(
        caller.mergePullRequest({
          pullRequestId: fixture.pullRequestId,
          bypassRequirements: true,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(remote.merge).not.toHaveBeenCalled();
    },
  );

  it("keeps conflicts blocked despite bypass permission", async () => {
    remote.load.mockResolvedValueOnce({
      lifecycle: {
        ...lifecycle,
        canBypassMergeRequirements: false,
        mergeable: false,
        mergeBlockedReason: "Has merge conflicts",
      },
      remotePullRequest: { headSha, baseSha },
    });
    await expect(
      caller.mergePullRequest({
        pullRequestId: fixture.pullRequestId,
        bypassRequirements: true,
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Has merge conflicts",
    });
    expect(remote.merge).not.toHaveBeenCalled();
  });

  it.each([
    { headSha: "new-head", baseSha },
    { headSha, baseSha: "new-base" },
  ])(
    "requires synchronization when either revision moves: %j",
    async (revision) => {
      remote.load.mockResolvedValueOnce({
        lifecycle,
        remotePullRequest: revision,
      });
      await expect(
        caller.mergePullRequest({
          pullRequestId: fixture.pullRequestId,
          bypassRequirements: true,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(remote.merge).not.toHaveBeenCalled();
    },
  );

  it("rejects a lifecycle head that changed during parallel provider reads", async () => {
    remote.load.mockResolvedValueOnce({
      lifecycle: { ...lifecycle, headSha: "new-head" },
      remotePullRequest: { headSha, baseSha },
    });
    await expect(
      caller.mergePullRequest({
        pullRequestId: fixture.pullRequestId,
        bypassRequirements: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(remote.merge).not.toHaveBeenCalled();
  });

  it("requires a complete ReviewDuck review even when bypass is requested", async () => {
    await db
      .update(signOffs)
      .set({ invalidatedAt: new Date() })
      .where(eq(signOffs.unitId, fixture.unitId));
    await expect(
      caller.mergePullRequest({
        pullRequestId: fixture.pullRequestId,
        bypassRequirements: true,
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Complete every review unit before merging",
    });
    expect(remote.load).not.toHaveBeenCalled();
    expect(remote.merge).not.toHaveBeenCalled();
  });
});
