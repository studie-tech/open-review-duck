import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiReviewItems } from "@/drizzle/schema";

const mocks = vi.hoisted(() => ({ finalizeDeepReview: vi.fn() }));

vi.mock("./finalize", () => ({
  finalizeDeepReview: mocks.finalizeDeepReview,
}));

import { cancelDeepReviewTree, deepReviewIsCancelled } from "./cancel";

interface FakeJob {
  id: string;
  parentJobId: string | null;
  status: string;
  cancelledAt: Date | null;
}

interface RecordedUpdate {
  table: "aiJobs" | "aiReviewItems";
  values: Record<string, unknown>;
}

const finalizeResult = {
  terminalState: "failed" as const,
  runFailureClass: "cancelled" as const,
  completionReason: "deep_review_partial" as const,
};

/** Builds a database double that records writes and answers job lookups. */
function createFakeDb(jobs: FakeJob[]) {
  const updates: RecordedUpdate[] = [];
  const locks: unknown[] = [];
  const order: string[] = [];
  // The double cannot read a drizzle predicate, so each case states the lookup
  // order it expects instead: the addressed job first, then its parent.
  const lookups = [...jobs];

  const writer = {
    execute: async (statement: unknown) => {
      locks.push(statement);
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          const name = table === aiReviewItems ? "aiReviewItems" : "aiJobs";
          updates.push({ table: name, values });
          order.push(`sweep:${name}`);
          return { where: async () => undefined };
        },
      };
    },
  };

  const db = {
    ...writer,
    query: {
      aiJobs: { findFirst: async () => lookups.shift() },
    },
    transaction: async (run: (tx: typeof writer) => Promise<void>) => {
      await run(writer);
    },
  };
  return { db: db as never, updates, locks, order };
}

const now = new Date("2026-01-01T00:00:00.000Z");

beforeEach(() => {
  mocks.finalizeDeepReview.mockReset();
  mocks.finalizeDeepReview.mockResolvedValue(finalizeResult);
});

describe("cancelDeepReviewTree", () => {
  it("cancels every live child and fails every selected item at once", async () => {
    const { db, updates, locks } = createFakeDb([]);
    await cancelDeepReviewTree(db, "parent-1");

    expect(locks).toHaveLength(1);
    expect(updates).toEqual([
      {
        table: "aiJobs",
        values: expect.objectContaining({
          status: "cancelled",
          completionReason: "cancelled",
        }),
      },
      {
        table: "aiReviewItems",
        values: expect.objectContaining({
          state: "failed",
          failureClass: "cancelled",
        }),
      },
    ]);
  });

  it("finalizes afterwards so the coverage partition closes", async () => {
    const { db } = createFakeDb([]);
    await cancelDeepReviewTree(db, "parent-1");

    expect(mocks.finalizeDeepReview).toHaveBeenCalledWith(db, "parent-1", {
      runFailure: {
        failureClass: "cancelled",
        cause: "The review was cancelled before this file was reviewed.",
      },
    });
  });

  it("sweeps the tree before finalize reads its coverage", async () => {
    const { db, order } = createFakeDb([]);
    mocks.finalizeDeepReview.mockImplementation(async () => {
      order.push("finalize");
      return finalizeResult;
    });
    await cancelDeepReviewTree(db, "parent-1");

    expect(order).toEqual(["sweep:aiJobs", "sweep:aiReviewItems", "finalize"]);
  });

  it("returns the finalize result so the caller can report the outcome", async () => {
    const { db } = createFakeDb([]);
    const result = await cancelDeepReviewTree(db, "parent-1");
    expect(result.terminalState).toBe("failed");
    expect(result.runFailureClass).toBe("cancelled");
  });
});

describe("deepReviewIsCancelled", () => {
  it("reads a child's cancellation off the parent, not off the child", async () => {
    const { db } = createFakeDb([
      {
        id: "child-1",
        parentJobId: "parent-1",
        status: "running",
        cancelledAt: null,
      },
      {
        id: "parent-1",
        parentJobId: null,
        status: "cancelled",
        cancelledAt: now,
      },
    ]);
    await expect(deepReviewIsCancelled(db, "child-1")).resolves.toBe(true);
  });

  it("lets a child keep running while its parent is live", async () => {
    const { db } = createFakeDb([
      {
        id: "child-1",
        parentJobId: "parent-1",
        status: "running",
        cancelledAt: null,
      },
      {
        id: "parent-1",
        parentJobId: null,
        status: "running",
        cancelledAt: null,
      },
    ]);
    await expect(deepReviewIsCancelled(db, "child-1")).resolves.toBe(false);
  });

  it("still honours a cancellation landed on the child itself", async () => {
    const { db } = createFakeDb([
      {
        id: "child-1",
        parentJobId: "parent-1",
        status: "cancelled",
        cancelledAt: now,
      },
      {
        id: "parent-1",
        parentJobId: null,
        status: "running",
        cancelledAt: null,
      },
    ]);
    await expect(deepReviewIsCancelled(db, "child-1")).resolves.toBe(true);
  });

  it("reads a parent id directly, without a second lookup", async () => {
    const { db } = createFakeDb([
      {
        id: "parent-1",
        parentJobId: null,
        status: "cancelled",
        cancelledAt: null,
      },
    ]);
    await expect(deepReviewIsCancelled(db, "parent-1")).resolves.toBe(true);
  });

  it("stops spending when the job or its parent has been pruned away", async () => {
    const missingJob = createFakeDb([]);
    await expect(deepReviewIsCancelled(missingJob.db, "child-1")).resolves.toBe(
      true,
    );

    const missingParent = createFakeDb([
      {
        id: "child-1",
        parentJobId: "parent-1",
        status: "running",
        cancelledAt: null,
      },
    ]);
    await expect(
      deepReviewIsCancelled(missingParent.db, "child-1"),
    ).resolves.toBe(true);
  });
});
