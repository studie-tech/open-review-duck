import { TRPCError } from "@trpc/server";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCallerFactory } from "~/server/api/trpc";
import type { db as database } from "~/server/db";
import { providerForReviewerRead } from "~/server/providers/user-credentials";
import { providerScopeForPullRequest } from "~/server/review/provider-thread";
import { reviewRouter } from "./review";

vi.mock("~/server/review/provider-thread", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/server/review/provider-thread")>()),
  providerScopeForPullRequest: vi.fn(),
}));
vi.mock("~/server/providers/user-credentials", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/server/providers/user-credentials")
  >()),
  providerForReviewerRead: vi.fn(),
}));
vi.mock("~/server/security/rate-limit", () => ({ enforceRateLimit: vi.fn() }));

const input = {
  pullRequestId: "11111111-1111-4111-8111-111111111111",
  snapshotId: "22222222-2222-4222-8222-222222222222",
};
const snapshot = {
  id: input.snapshotId,
  headSha: "reviewed-head",
  baseSha: "base",
};

/** Provides only the metadata reads needed by the authorized size endpoint. */
function fixture(foundSnapshot: unknown = snapshot) {
  const findFirst = vi.fn().mockResolvedValue(foundSnapshot);
  const findMany = vi
    .fn()
    .mockResolvedValue([{ path: "blocks.parquet", changeType: "added" }]);
  const db = {
    query: {
      reviewSnapshots: { findFirst },
      snapshotFiles: { findMany },
    },
  } as unknown as typeof database;
  const caller = createCallerFactory(reviewRouter)({
    db,
    auth: { userId: "reviewer", has: () => false },
    headers: new Headers(),
  });
  return { caller, db, findFirst, findMany };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(providerScopeForPullRequest).mockResolvedValue({
    connection: { id: "connection" },
    repositoryExternalId: "42",
  } as never);
});

describe("review file size metadata access", () => {
  it("authorizes the reviewer and pins metadata to a snapshot belonging to the PR", async () => {
    const getRepositoryFileSizes = vi.fn().mockResolvedValue(
      new Map([
        ["blocks.parquet", 120_000_000],
        ["other.bin", 1],
      ]),
    );
    vi.mocked(providerForReviewerRead).mockResolvedValue({
      getRepositoryFileSizes,
    } as never);
    const { caller, db, findFirst } = fixture();
    expect(await caller.fileSizes(input)).toEqual({
      "blocks.parquet": 120_000_000,
    });
    expect(providerScopeForPullRequest).toHaveBeenCalledWith(
      db,
      "reviewer",
      input.pullRequestId,
    );
    expect(providerForReviewerRead).toHaveBeenCalledWith(
      db,
      { id: "connection" },
      "reviewer",
    );
    const predicate = new PgDialect().sqlToQuery(
      findFirst.mock.calls[0]?.[0]?.where,
    );
    expect(predicate.params).toEqual([input.snapshotId, input.pullRequestId]);
    expect(getRepositoryFileSizes).toHaveBeenCalledWith("42", "reviewed-head");
  });

  it("rejects an inaccessible PR before any metadata lookup", async () => {
    vi.mocked(providerScopeForPullRequest).mockRejectedValue(
      new TRPCError({ code: "NOT_FOUND" }),
    );
    const { caller, findFirst } = fixture();
    await expect(caller.fileSizes(input)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(findFirst).not.toHaveBeenCalled();
    expect(providerForReviewerRead).not.toHaveBeenCalled();
  });

  it("rejects a snapshot outside the authorized PR", async () => {
    const other = fixture(null);
    await expect(other.caller.fileSizes(input)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(other.findMany).not.toHaveBeenCalled();
    expect(providerForReviewerRead).not.toHaveBeenCalled();
  });
});
