import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCallerFactory } from "~/server/api/trpc";
import type { db as database } from "~/server/db";
import type { PullRequestSummary } from "~/server/providers/types";
import { providerRouter } from "./provider";

const provider = vi.hoisted(() => ({ listOpenPullRequests: vi.fn() }));
vi.mock("~/server/providers/credentials", () => ({
  providerForConnection: vi.fn(async () => provider),
}));
vi.mock("~/server/security/rate-limit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("~/server/workspaces/service", () => ({
  ensurePersonalWorkspace: vi.fn(async () => ({ id: "workspace" })),
}));

/** Supplies a provider PR independently of the user's prepared review queue. */
function pullRequest(number: number): PullRequestSummary {
  return {
    externalId: String(number),
    number,
    title: `Pull request ${number}`,
    authorLogin: "author",
    sourceBranch: "feature",
    targetBranch: "main",
    headSha: "head",
    baseSha: "base",
    state: "open",
    webUrl: `https://github.com/acme/app/pull/${number}`,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    labels: [],
  };
}

/** Captures SQL scopes while returning the rows that match the fixture's queue. */
function inbox(repositories: unknown[], queued: unknown[] = []) {
  const predicates: SQL[] = [];
  const joins: SQL[] = [];
  const results = [repositories, queued, []];
  const select = vi.fn(() => {
    const rows = results.shift() ?? [];
    const query = {
      from: () => query,
      innerJoin: (_table: unknown, predicate: SQL) => {
        joins.push(predicate);
        return query;
      },
      where: async (predicate: SQL) => {
        predicates.push(predicate);
        return rows;
      },
    };
    return query;
  });
  const caller = createCallerFactory(providerRouter)({
    db: {
      select,
      query: {
        providerConnections: {
          findMany: async () => [
            {
              id: "connection",
              provider: "github",
              externalAccountId: "viewer",
              displayName: "viewer",
            },
          ],
        },
      },
    } as unknown as typeof database,
    auth: { userId: "reviewer", has: () => false },
    headers: new Headers(),
  });
  return { caller, predicates, joins };
}

beforeEach(() => provider.listOpenPullRequests.mockReset());

describe("provider inbox discovery", () => {
  it("lists open PRs for every intake mode and excludes only the viewer's queue", async () => {
    const test = inbox(
      ["manual", "assigned", "all_open"].map((mode) => ({
        id: mode,
        externalId: mode,
        connectionId: "connection",
        provider: "github",
        owner: "acme",
        name: mode,
      })),
      [{ repositoryId: "manual", number: 42 }],
    );
    provider.listOpenPullRequests.mockResolvedValue([
      pullRequest(42),
      pullRequest(43),
    ]);
    const result = await test.caller.listUnimportedPullRequests();
    expect(result.repositoryCount).toBe(3);
    expect(
      result.pullRequests.map(
        ({ repositoryId, number }) => `${repositoryId}:${number}`,
      ),
    ).toEqual([
      "all_open:43",
      "all_open:42",
      "assigned:43",
      "assigned:42",
      "manual:43",
    ]);
    const dialect = new PgDialect();
    const repositoryScope = dialect.sqlToQuery(test.predicates[0] as SQL);
    expect(repositoryScope.params).toEqual(["workspace"]);
    expect(repositoryScope.sql).not.toContain("review_intake_mode");
    const queueJoin = test.joins
      .map((join) => dialect.sqlToQuery(join))
      .find(({ sql }) => sql.includes("review_queue_item"));
    expect(queueJoin?.sql).toContain("userId");
    expect(queueJoin?.params).toContain("reviewer");
    expect(provider.listOpenPullRequests).toHaveBeenCalledWith("assigned", {
      includeMergeConflictStatus: true,
    });
  });

  it("returns conflicts for queued and unprepared PRs without confusing unknown status", async () => {
    const test = inbox(
      [
        {
          id: "repo",
          externalId: "remote",
          connectionId: "connection",
          provider: "github",
          owner: "acme",
          name: "app",
        },
      ],
      [{ repositoryId: "repo", number: 42 }],
    );
    provider.listOpenPullRequests.mockResolvedValue([
      { ...pullRequest(42), hasMergeConflicts: true },
      { ...pullRequest(43), hasMergeConflicts: true },
      { ...pullRequest(44), hasMergeConflicts: null },
    ]);
    const result = await test.caller.listUnimportedPullRequests();
    expect(result.mergeConflictKeys).toEqual([
      "github:acme/app:42",
      "github:acme/app:43",
    ]);
    expect(result.pullRequests.map(({ number }) => number)).toEqual([44, 43]);
    expect(result.pullRequests[0]?.hasMergeConflicts).toBeNull();
  });

  it("keeps successful repository results when another repository cannot be checked", async () => {
    const test = inbox(
      ["good", "bad"].map((id) => ({
        id,
        externalId: id,
        connectionId: "connection",
        provider: "github",
        owner: "acme",
        name: id,
      })),
    );
    provider.listOpenPullRequests.mockImplementation(async (id) => {
      if (id === "bad") throw new Error("Unavailable");
      return [pullRequest(43)];
    });
    const result = await test.caller.listUnimportedPullRequests();
    expect(result.pullRequests).toHaveLength(1);
    expect(result.errors).toEqual([
      expect.objectContaining({ repositoryId: "bad" }),
    ]);
  });
});
