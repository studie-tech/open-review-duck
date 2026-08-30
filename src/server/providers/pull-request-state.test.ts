import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startPullRequestSync: vi.fn(async () => ({})),
}));

vi.mock("~/server/workflows/service", () => ({
  startPullRequestSync: mocks.startPullRequestSync,
}));

import { pullRequests, type repositories } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import type { ConnectionAccess } from "./credentials";
import { refreshRepositoryPullRequestStates } from "./pull-request-state";
import type { PullRequestSummary } from "./types";

type Database = typeof database;
type TrackedPullRequest = typeof pullRequests.$inferSelect;

/** Builds a database whose throttle claim rejects the pass. */
function createThrottledDb() {
  const update = {
    set: () => update,
    where: () => update,
    returning: async () => [],
  };
  return { update: () => update } as unknown as Database;
}

/** Builds connection access that fails if the pass reaches the provider. */
function createUnusedAccess() {
  const connection = vi.fn(async () => {
    throw new Error("connection read");
  });
  const access = {
    connection,
    provider: async () => {
      throw new Error("provider resolved");
    },
  } as unknown as ConnectionAccess;
  return { access, connection };
}

/** Builds a database that claims the pass and records every write it issues. */
function createClaimedDb(tracked: TrackedPullRequest[]) {
  const writes: { table: unknown; values: Record<string, unknown> }[] = [];
  const db = {
    update(table: unknown) {
      let values: Record<string, unknown> = {};
      const builder = {
        set(next: Record<string, unknown>) {
          values = next;
          return builder;
        },
        where() {
          writes.push({ table, values });
          return Object.assign(Promise.resolve(), {
            returning: async () => [{ id: "repository-1" }],
          });
        },
      };
      return builder;
    },
    query: { pullRequests: { findMany: async () => tracked } },
  } as unknown as Database;
  return { db, writes };
}

/** Builds connection access serving a fixed open pull-request listing. */
function createListingAccess(open: PullRequestSummary[]) {
  return {
    connection: async () => ({ provider: "github" }),
    provider: async () => ({
      listOpenPullRequests: async () => open,
      getPullRequest: async () => {
        throw new Error("unexpected detail fetch");
      },
    }),
  } as unknown as ConnectionAccess;
}

const repository = {
  id: "repository-1",
  workspaceId: "workspace-1",
  connectionId: "connection-1",
  externalId: "octo/repo",
  reviewIntakeMode: "manual",
  intakeOwnerId: null,
} as typeof repositories.$inferSelect;

/** Builds a tracked row that agrees with the remote summary below. */
function createTracked(
  overrides: Partial<TrackedPullRequest> = {},
): TrackedPullRequest {
  return {
    id: "pull-request-1",
    repositoryId: repository.id,
    externalId: "10",
    number: 10,
    title: "Add the reader",
    description: "Body",
    authorLogin: "octocat",
    authorAvatarUrl: "https://example.test/avatar.png",
    sourceBranch: "feature",
    targetBranch: "main",
    headSha: "aaa",
    baseSha: "bbb",
    state: "open",
    webUrl: "https://example.test/pull/10",
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    lastSyncedAt: new Date("2026-08-01T00:00:00Z"),
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  } as TrackedPullRequest;
}

/** Builds the remote summary matching the tracked row above. */
function createSummary(
  overrides: Partial<PullRequestSummary> = {},
): PullRequestSummary {
  return {
    externalId: "10",
    number: 10,
    title: "Add the reader",
    description: "Body",
    authorLogin: "octocat",
    authorAvatarUrl: "https://example.test/avatar.png",
    sourceBranch: "feature",
    targetBranch: "main",
    headSha: "aaa",
    baseSha: "bbb",
    state: "open",
    webUrl: "https://example.test/pull/10",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    ...overrides,
  };
}

describe("repository pull-request state refresh", () => {
  beforeEach(() => {
    mocks.startPullRequestSync.mockClear();
  });

  it("skips the connection read when the throttle claim fails", async () => {
    const { access, connection } = createUnusedAccess();

    const result = await refreshRepositoryPullRequestStates(
      createThrottledDb(),
      {
        id: "repository-1",
        workspaceId: "workspace-1",
        connectionId: "connection-1",
      } as typeof repositories.$inferSelect,
      access,
    );

    expect(result).toEqual({ checked: false, changed: 0, queued: 0 });
    expect(connection).not.toHaveBeenCalled();
  });

  it("writes nothing for tracked rows the provider still agrees with", async () => {
    const { db, writes } = createClaimedDb([createTracked()]);

    const result = await refreshRepositoryPullRequestStates(
      db,
      repository,
      createListingAccess([createSummary()]),
    );

    expect(result).toEqual({ checked: true, changed: 0, queued: 0 });
    expect(writes.filter((write) => write.table === pullRequests)).toEqual([]);
    expect(mocks.startPullRequestSync).not.toHaveBeenCalled();
  });

  it("writes and resyncs only the pull requests whose revision moved", async () => {
    const { db, writes } = createClaimedDb([
      createTracked(),
      createTracked({
        id: "pull-request-2",
        externalId: "11",
        number: 11,
        headSha: "ccc",
      }),
    ]);

    const result = await refreshRepositoryPullRequestStates(
      db,
      repository,
      createListingAccess([
        createSummary(),
        createSummary({ externalId: "11", number: 11, headSha: "ddd" }),
      ]),
    );

    expect(result).toEqual({ checked: true, changed: 1, queued: 1 });
    const pullRequestWrites = writes.filter(
      (write) => write.table === pullRequests,
    );
    expect(pullRequestWrites).toHaveLength(1);
    expect(pullRequestWrites[0]?.values).toMatchObject({ headSha: "ddd" });
    expect(pullRequestWrites[0]?.values.lastSyncedAt).toBeInstanceOf(Date);
    expect(mocks.startPullRequestSync).toHaveBeenCalledTimes(1);
    expect(mocks.startPullRequestSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ pullRequestNumber: 11 }),
    );
  });

  it("keeps the stored diff counts for pull requests seen only in the listing", async () => {
    const { db, writes } = createClaimedDb([
      createTracked({ title: "Old title" }),
    ]);

    await refreshRepositoryPullRequestStates(
      db,
      repository,
      createListingAccess([createSummary()]),
    );

    const [write] = writes.filter((entry) => entry.table === pullRequests);
    expect(write?.values).toMatchObject({
      title: "Add the reader",
      additions: 12,
      deletions: 3,
      changedFiles: 2,
    });
  });
});
