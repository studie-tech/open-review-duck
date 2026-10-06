import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { createCallerFactory } from "~/server/api/trpc";
import type { db as database } from "~/server/db";
import { reviewRouter } from "./review";

const repository = {
  id: "00000000-0000-4000-8000-000000000001",
  owner: "team",
  name: "repo",
  webUrl: "https://github.com/team/repo",
  provider: "github",
};
const url = "https://github.com/team/repo/pull/42";
const createCaller = createCallerFactory(reviewRouter);

/** Creates a scoped read double and records the actual authorization predicate. */
function reader(rows: unknown[], userId: string | null = "reviewer") {
  let predicate: SQL | undefined;
  const joins: unknown[] = [];
  const query = {
    from: () => query,
    innerJoin: (_table: unknown, condition: SQL) => {
      joins.push(condition);
      return query;
    },
    leftJoin: () => query,
    where: (condition: SQL) => {
      predicate = condition;
      return Object.assign(Promise.resolve(rows), { limit: async () => rows });
    },
  };
  const findFirst = vi.fn().mockResolvedValue({ id: "prepared-pr" });
  const select = vi.fn(() => query);
  const caller = createCaller({
    db: {
      select,
      query: { pullRequests: { findFirst } },
    } as unknown as typeof database,
    auth: { userId, has: () => false },
    headers: new Headers(),
  });
  return {
    caller,
    select,
    findFirst,
    authorization: () =>
      predicate ? new PgDialect().sqlToQuery(predicate) : undefined,
    joins,
  };
}

describe("PR import link API", () => {
  it("resolves a connected repository using reviewer membership", async () => {
    const test = reader([repository]);
    await expect(test.caller.resolveImportLink({ url })).resolves.toEqual({
      repositoryId: repository.id,
      repositoryName: "team/repo",
      number: 42,
    });
    expect(test.authorization()?.sql).toContain("workspace_member");
    expect(test.authorization()?.params).toContain("reviewer");
    expect(test.joins).toHaveLength(2);
  });
  it("rejects unsigned callers before reading repositories", async () => {
    const test = reader([repository], null);
    await expect(test.caller.resolveImportLink({ url })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(test.select).not.toHaveBeenCalled();
  });
  it("does not resolve inaccessible or unrelated repositories", async () => {
    for (const rows of [
      [],
      [{ ...repository, webUrl: "https://github.com/other/repo" }],
    ]) {
      await expect(
        reader(rows).caller.resolveImportLink({ url }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });
  it("rejects ambiguous connections and invalid links", async () => {
    await expect(
      reader([repository, repository]).caller.resolveImportLink({ url }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const test = reader([]);
    await expect(
      test.caller.resolveImportLink({ url: "https://example.com" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(test.select).not.toHaveBeenCalled();
  });
  it.each(["queued", "running", "failed", "cancelled", "completed"])(
    "exposes a review destination only for a completed %s job",
    async (status) => {
      const test = reader([
        {
          sync: {
            id: repository.id,
            repositoryId: repository.id,
            pullRequestNumber: 42,
            status,
          },
          providerRunId: "workflow-id",
        },
      ]);
      const result = await test.caller.syncStatus({ syncId: repository.id });
      expect(result.pullRequestId).toBe(
        status === "completed" ? "prepared-pr" : null,
      );
      expect(test.findFirst).toHaveBeenCalledTimes(
        status === "completed" ? 1 : 0,
      );
      expect(test.authorization()?.params).toContain("reviewer");
    },
  );
});
