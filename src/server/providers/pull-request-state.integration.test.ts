import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  providerConnections,
  pullRequests,
  repositories,
  users,
  workspaces,
} from "@/drizzle/schema";
import { db } from "~/server/db";
import type { ConnectionAccess } from "./credentials";
import { refreshRepositoryPullRequestStates } from "./pull-request-state";

const mocks = vi.hoisted(() => ({
  startPullRequestSync: vi.fn(async () => ({})),
}));

vi.mock("~/server/workflows/service", () => ({
  startPullRequestSync: mocks.startPullRequestSync,
}));

const fixture = {
  userId: `pr-state-${randomUUID()}`,
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  repositoryId: randomUUID(),
  pullRequestId: randomUUID(),
};

/** Builds access that records whether the provider listing was reached. */
function listingAccess() {
  const connection = vi.fn(async () => ({ provider: "github" as const }));
  const listOpenPullRequests = vi.fn(async () => [
    {
      externalId: "1",
      number: 1,
      title: "PR state",
      authorLogin: "reviewduck",
      sourceBranch: "feature",
      targetBranch: "main",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      state: "open" as const,
      webUrl: "https://github.com/reviewduck/pr-state/pull/1",
      additions: 0,
      deletions: 0,
      changedFiles: 0,
    },
  ]);
  const access = {
    connection,
    provider: async () => ({
      listOpenPullRequests,
      getPullRequest: async () => {
        throw new Error("unexpected detail fetch");
      },
    }),
  } as unknown as ConnectionAccess;
  return { access, connection, listOpenPullRequests };
}

beforeAll(async () => {
  await db.insert(users).values({ id: fixture.userId });
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    ownerId: fixture.userId,
    name: "PR state integration workspace",
    slug: `pr-state-${randomUUID()}`,
  });
  await db.insert(providerConnections).values({
    id: fixture.connectionId,
    workspaceId: fixture.workspaceId,
    provider: "github",
    externalAccountId: `pr-state-${randomUUID()}`,
    displayName: "PR state connection",
  });
  await db.insert(repositories).values({
    id: fixture.repositoryId,
    workspaceId: fixture.workspaceId,
    connectionId: fixture.connectionId,
    externalId: `repository-${randomUUID()}`,
    owner: "reviewduck",
    name: "pr-state",
    defaultBranch: "main",
    webUrl: "https://github.com/reviewduck/pr-state",
    reviewIntakeMode: "manual",
  });
  await db.insert(pullRequests).values({
    id: fixture.pullRequestId,
    repositoryId: fixture.repositoryId,
    externalId: `pull-request-${randomUUID()}`,
    number: 1,
    title: "PR state",
    authorLogin: "reviewduck",
    sourceBranch: "feature",
    targetBranch: "main",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    webUrl: "https://github.com/reviewduck/pr-state/pull/1",
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
});

/** Reloads the repository row the claim SQL mutates. */
async function loadRepository() {
  const repository = await db.query.repositories.findFirst({
    where: eq(repositories.id, fixture.repositoryId),
  });
  if (!repository) throw new Error("repository fixture missing");
  return repository;
}

describe("pull request state claim", () => {
  it("claims a never-checked repository and skips a fresh stamp", async () => {
    await db
      .update(repositories)
      .set({
        pullRequestStateLastCheckedAt: null,
        pullRequestStateLastError: "stale",
      })
      .where(eq(repositories.id, fixture.repositoryId));
    const firstAccess = listingAccess();
    await expect(
      refreshRepositoryPullRequestStates(
        db,
        await loadRepository(),
        firstAccess.access,
      ),
    ).resolves.toMatchObject({ checked: true });
    expect(firstAccess.connection).toHaveBeenCalledOnce();
    const claimed = await loadRepository();
    expect(claimed.pullRequestStateLastCheckedAt).toBeTruthy();
    expect(claimed.pullRequestStateLastError).toBeNull();

    const secondAccess = listingAccess();
    await expect(
      refreshRepositoryPullRequestStates(db, claimed, secondAccess.access),
    ).resolves.toEqual({ checked: false, changed: 0, queued: 0 });
    expect(secondAccess.connection).not.toHaveBeenCalled();
    await expect(loadRepository()).resolves.toMatchObject({
      pullRequestStateLastCheckedAt: claimed.pullRequestStateLastCheckedAt,
    });
  });

  it("reclaims a repository whose stamp is older than five minutes", async () => {
    await db
      .update(repositories)
      .set({
        pullRequestStateLastCheckedAt: new Date(Date.now() - 6 * 60_000),
      })
      .where(eq(repositories.id, fixture.repositoryId));
    const access = listingAccess();
    await expect(
      refreshRepositoryPullRequestStates(
        db,
        await loadRepository(),
        access.access,
      ),
    ).resolves.toMatchObject({ checked: true });
    expect(access.connection).toHaveBeenCalledOnce();
  });

  it("lets only one concurrent caller claim the same repository", async () => {
    await db
      .update(repositories)
      .set({ pullRequestStateLastCheckedAt: null })
      .where(eq(repositories.id, fixture.repositoryId));
    const first = listingAccess();
    const second = listingAccess();
    const repository = await loadRepository();
    const results = await Promise.all([
      refreshRepositoryPullRequestStates(db, repository, first.access),
      refreshRepositoryPullRequestStates(db, repository, second.access),
    ]);
    expect(results.filter((result) => result.checked)).toHaveLength(1);
    expect(results.filter((result) => !result.checked)).toHaveLength(1);
    expect(
      first.connection.mock.calls.length + second.connection.mock.calls.length,
    ).toBe(1);
  });
});
