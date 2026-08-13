import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiJobs, aiReviewFindings, aiReviewItems } from "@/drizzle/schema";

const mocks = vi.hoisted(() => ({
  acceptAiJobResult: vi.fn(
    async (_db: unknown, _jobId: string, _result: unknown) => true,
  ),
  settleAiJobQuota: vi.fn(
    async (_db: unknown, _jobId: string, _usage: unknown) => undefined,
  ),
}));

vi.mock("~/server/ai/service", () => ({
  acceptAiJobResult: mocks.acceptAiJobResult,
  settleAiJobQuota: mocks.settleAiJobQuota,
}));

import { cancelDeepReviewTree } from "./cancel";
import {
  deepReviewCompletionReason,
  deepReviewCoverage,
  deepReviewRunFailureClass,
  deepReviewSweepFailure,
  deepReviewTreeUsage,
  finalizeDeepReview,
} from "./finalize";

interface FakeItem {
  id: string;
  path: string;
  state: "selected" | "completed" | "reused" | "failed" | "waived";
  failureClass: string | null;
  reason?: string | null;
}

interface FakeFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  path: string | null;
  startLine: number | null;
}

interface FakeState {
  parent: {
    id: string;
    parentJobId: string | null;
    status: string;
  } | null;
  items: FakeItem[];
  findings: FakeFinding[];
  usageRows: Record<string, unknown>[];
}

interface RecordedUpdate {
  table: "aiJobs" | "aiReviewItems" | "aiReviewFindings";
  values: Record<string, unknown>;
}

/** Builds the smallest database double the finalize path actually exercises. */
function createFakeDb(state: FakeState) {
  const updates: RecordedUpdate[] = [];
  const locks: unknown[] = [];
  const order: string[] = [];
  let held: Promise<unknown> = Promise.resolve();

  /** Resolves either as a promise or through a `.returning()` continuation. */
  const settled = <T>(rows: T[]) => {
    const query = Promise.resolve(rows) as Promise<T[]> & {
      returning: () => Promise<T[]>;
    };
    query.returning = async () => rows;
    return query;
  };

  const db = {
    query: {
      aiJobs: {
        findFirst: async () => state.parent ?? undefined,
      },
      aiReviewItems: {
        findMany: async () => state.items,
      },
    },
    /** Records the tree lock a closing transaction takes before it writes. */
    execute: async (statement: unknown) => {
      locks.push(statement);
      order.push("lock");
      return [];
    },
    /**
     * Runs one transaction at a time against the same rows.
     *
     * The queue stands in for the advisory lock the closers contend for: a
     * transaction that has started runs to its commit before the next begins,
     * so a closer that takes no lock is the only one that can interleave.
     */
    transaction: async <T>(run: (tx: unknown) => Promise<T>) => {
      const previous = held;
      /** Hands the queue to the next transaction at this one's commit. */
      let commit = () => {};
      held = new Promise<void>((resolve) => {
        commit = resolve;
      });
      await previous;
      try {
        return await run(db);
      } finally {
        commit();
      }
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          if (table === aiReviewItems) {
            updates.push({ table: "aiReviewItems", values });
            order.push("sweep");
            const swept = state.items.filter(
              (item) => item.state === "selected",
            );
            for (const item of swept) {
              item.state = "failed";
              item.failureClass = values.failureClass as string;
              item.reason = values.reason as string;
            }
            return { where: () => settled(swept) };
          }
          const name = table === aiJobs ? "aiJobs" : "aiReviewFindings";
          updates.push({ table: name, values });
          return { where: () => settled([]) };
        },
      };
    },
    select() {
      return {
        from(table: unknown) {
          return {
            where: () =>
              settled<unknown>(
                table === aiReviewFindings ? state.findings : state.usageRows,
              ),
          };
        },
      };
    },
  };
  return { db: db as never, updates, locks, order };
}

/** Builds one coverage item, defaulting everything the case does not state. */
function item(overrides: Partial<FakeItem> & { id: string }): FakeItem {
  return {
    path: `src/${overrides.id}.ts`,
    state: "completed",
    failureClass: null,
    ...overrides,
  };
}

const parent = { id: "parent-1", parentJobId: null, status: "running" };

beforeEach(() => {
  mocks.acceptAiJobResult.mockClear();
  mocks.acceptAiJobResult.mockResolvedValue(true);
  mocks.settleAiJobQuota.mockClear();
});

describe("deepReviewSweepFailure", () => {
  it("prefers a stated run failure over a pending budget stop", () => {
    expect(
      deepReviewSweepFailure({
        runFailure: { failureClass: "provider", cause: "upstream exploded" },
        budgetStop: { cause: "token budget spent" },
      }),
    ).toEqual({ failureClass: "provider", reason: "upstream exploded" });
  });

  it("classifies an unlabelled run failure from the thrown value", () => {
    const sweep = deepReviewSweepFailure({
      runFailure: { cause: new Error("request timed out after 30s") },
    });
    expect(sweep.failureClass).toBe("timeout");
    expect(sweep.reason).toBe("request timed out after 30s");
  });

  it("attributes leftovers to budget when only a budget stop is pending", () => {
    expect(deepReviewSweepFailure({ budgetStop: {} }).failureClass).toBe(
      "budget",
    );
    expect(deepReviewSweepFailure({ budgetStop: {} }).reason).toContain(
      "token budget",
    );
  });

  it("falls back to unknown when nothing explains the leftovers", () => {
    expect(deepReviewSweepFailure({})).toEqual({
      failureClass: "unknown",
      reason: "The review ended before this file was reviewed.",
    });
  });

  it("never persists a credential carried by a provider error", () => {
    const sweep = deepReviewSweepFailure({
      runFailure: {
        cause: new Error("401 from api: authorization: Bearer sk-abcd1234efgh"),
      },
    });
    expect(sweep.reason).not.toContain("sk-abcd1234efgh");
    expect(sweep.reason).toContain("[REDACTED]");
  });
});

describe("deepReviewRunFailureClass", () => {
  it("reports no run failure when a budget stop merely truncated coverage", () => {
    expect(
      deepReviewRunFailureClass({
        terminalState: "partial",
        items: [
          item({ id: "a" }),
          item({ id: "b", state: "failed", failureClass: "budget" }),
        ],
      }),
    ).toBeNull();
  });

  it("adopts the shared cause when every selected file failed alike", () => {
    expect(
      deepReviewRunFailureClass({
        terminalState: "failed",
        items: [
          item({ id: "a", state: "failed", failureClass: "provider" }),
          item({ id: "b", state: "failed", failureClass: "provider" }),
        ],
      }),
    ).toBe("provider");
  });

  it("refuses to attribute a mixture of item failures to one class", () => {
    expect(
      deepReviewRunFailureClass({
        terminalState: "failed",
        items: [
          item({ id: "a", state: "failed", failureClass: "provider" }),
          item({ id: "b", state: "failed", failureClass: "timeout" }),
        ],
      }),
    ).toBe("unknown");
  });
});

describe("deepReviewTreeUsage", () => {
  it("sums the aggregate columns Postgres returns as numeric strings", () => {
    expect(
      deepReviewTreeUsage([
        {
          inputTokens: "1200000",
          outputTokens: "300000",
          cacheReadTokens: "40",
          cacheWriteTokens: "8",
          totalTokens: "1500040",
          actualMicroUsd: "2500000",
        },
      ]),
    ).toEqual({
      input: 1200000,
      output: 300000,
      cacheRead: 40,
      cacheWrite: 8,
      totalTokens: 1500040,
      microUsd: 2500000,
    });
  });

  it("adds every row so a per-child rowset totals the same as an aggregate", () => {
    const rows = [
      { inputTokens: 10, outputTokens: 5, totalTokens: 15, actualMicroUsd: 7 },
      { inputTokens: 20, outputTokens: 1, totalTokens: 21, actualMicroUsd: 3 },
    ];
    expect(deepReviewTreeUsage(rows)).toMatchObject({
      input: 30,
      output: 6,
      totalTokens: 36,
      microUsd: 10,
    });
  });

  it("floors the total at input plus output when a provider omits it", () => {
    expect(
      deepReviewTreeUsage([
        { inputTokens: 900, outputTokens: 100, totalTokens: 0 },
      ]).totalTokens,
    ).toBe(1000);
  });

  it("reads an empty tree and a null aggregate as zero rather than NaN", () => {
    expect(deepReviewTreeUsage([])).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      microUsd: 0,
    });
    expect(
      deepReviewTreeUsage([{ inputTokens: null, totalTokens: "not a number" }])
        .input,
    ).toBe(0);
  });
});

describe("deepReviewCoverage", () => {
  it("counts every state the sealed plan can end in", () => {
    expect(
      deepReviewCoverage([
        item({ id: "a" }),
        item({ id: "b", state: "reused" }),
        item({ id: "c", state: "waived" }),
        item({ id: "d", state: "failed" }),
      ]),
    ).toEqual({ total: 4, completed: 1, reused: 1, waived: 1, failed: 1 });
  });
});

describe("deepReviewCompletionReason", () => {
  it("maps coverage onto the reason the job row records", () => {
    expect(deepReviewCompletionReason("complete")).toBe("answered");
    expect(deepReviewCompletionReason("partial")).toBe("deep_review_partial");
    expect(deepReviewCompletionReason("failed")).toBe("deep_review_partial");
    expect(deepReviewCompletionReason("skipped")).toBe("deep_review_skipped");
  });
});

describe("finalizeDeepReview", () => {
  it("sweeps lingering selected items before deriving terminal state", async () => {
    const state: FakeState = {
      parent,
      items: [item({ id: "a" }), item({ id: "b", state: "selected" })],
      findings: [],
      usageRows: [],
    };
    const { db, updates } = createFakeDb(state);
    const result = await finalizeDeepReview(db, "parent-1", {
      budgetStop: { cause: "reservation exhausted" },
    });

    expect(result.sweptCount).toBe(1);
    expect(state.items[1]).toMatchObject({
      state: "failed",
      failureClass: "budget",
      reason: "reservation exhausted",
    });
    // A budget stop truncates coverage without failing the run itself.
    expect(result.terminalState).toBe("partial");
    expect(result.runFailureClass).toBeNull();
    expect(result.completionReason).toBe("deep_review_partial");
    expect(
      updates.some(
        (update) =>
          update.table === "aiJobs" &&
          update.values.deepReviewTerminalState === "partial",
      ),
    ).toBe(true);
  });

  it("reports complete coverage as an answered job", async () => {
    const state: FakeState = {
      parent,
      items: [item({ id: "a" }), item({ id: "b", state: "waived" })],
      findings: [],
      usageRows: [],
    };
    const { db, updates } = createFakeDb(state);
    const result = await finalizeDeepReview(db, "parent-1");

    expect(result.terminalState).toBe("complete");
    expect(result.completionReason).toBe("answered");
    // `acceptAiJobResult` already wrote `answered`; nothing patches over it.
    expect(
      updates.some((update) => update.values.completionReason !== undefined),
    ).toBe(false);
  });

  it("reports an empty sealed plan as skipped, not as complete", async () => {
    const { db } = createFakeDb({
      parent,
      items: [],
      findings: [],
      usageRows: [],
    });
    const result = await finalizeDeepReview(db, "parent-1");

    expect(result.terminalState).toBe("skipped");
    expect(result.completionReason).toBe("deep_review_skipped");
    expect(result.summary).toContain("selected no file");
  });

  it("derives terminal state from coverage alone, never from findings", async () => {
    const state: FakeState = {
      parent,
      items: [item({ id: "a" })],
      findings: [
        { id: "f1", severity: "critical", path: "src/a.ts", startLine: 9 },
      ],
      usageRows: [],
    };
    const { db } = createFakeDb(state);
    const covered = await finalizeDeepReview(db, "parent-1");
    expect(covered.terminalState).toBe("complete");

    const failedState: FakeState = {
      parent,
      items: [item({ id: "a", state: "failed", failureClass: "provider" })],
      findings: [
        { id: "f1", severity: "critical", path: "src/a.ts", startLine: 9 },
      ],
      usageRows: [],
    };
    const failed = await finalizeDeepReview(
      createFakeDb(failedState).db,
      "parent-1",
    );
    // Findings exist either way; only coverage moves the terminal state.
    expect(failed.terminalState).toBe("failed");
    expect(failed.runFailureClass).toBe("provider");
  });

  it("freezes orderIndex worst-first before building the projection", async () => {
    const state: FakeState = {
      parent,
      items: [item({ id: "a" })],
      findings: [
        { id: "f-low", severity: "low", path: "src/a.ts", startLine: 1 },
        { id: "f-crit", severity: "critical", path: "src/a.ts", startLine: 80 },
        { id: "f-high", severity: "high", path: "src/a.ts", startLine: 4 },
      ],
      usageRows: [],
    };
    const { db, updates } = createFakeDb(state);
    const result = await finalizeDeepReview(db, "parent-1");

    expect(
      updates
        .filter((update) => update.table === "aiReviewFindings")
        .map((update) => update.values.orderIndex),
    ).toEqual([0, 1, 2]);
    expect(result.surfacedFindingCount).toBe(3);
    const [, , projection] = mocks.acceptAiJobResult.mock.calls[0] ?? [];
    expect(projection).toMatchObject({ annotations: [], findings: [] });
  });

  it("rolls child usage onto the parent before settling its quota", async () => {
    const state: FakeState = {
      parent,
      items: [item({ id: "a" })],
      findings: [],
      usageRows: [
        {
          inputTokens: "2000000",
          outputTokens: "500000",
          cacheReadTokens: "0",
          cacheWriteTokens: "0",
          totalTokens: "2500000",
          actualMicroUsd: "9100000",
        },
      ],
    };
    const { db, updates } = createFakeDb(state);
    const result = await finalizeDeepReview(db, "parent-1");

    expect(result.usage).toMatchObject({
      input: 2000000,
      output: 500000,
      totalTokens: 2500000,
      microUsd: 9100000,
    });
    // The parent row has to carry the tree total before the settlement reads
    // it, or a 2.5M-token review settles as zero monthly tokens.
    const rollup = updates.find(
      (update) => update.table === "aiJobs" && update.values.totalTokens,
    );
    expect(rollup?.values).toMatchObject({
      inputTokens: 2000000,
      outputTokens: 500000,
      totalTokens: 2500000,
      actualMicroUsd: 9100000,
    });
    expect(mocks.settleAiJobQuota).toHaveBeenCalledWith(
      db,
      "parent-1",
      result.usage,
    );
  });

  it("takes the tree lock before it rewrites any coverage", async () => {
    const state: FakeState = {
      parent,
      items: [item({ id: "a", state: "selected" })],
      findings: [],
      usageRows: [],
    };
    const { db, locks, order } = createFakeDb(state);
    await finalizeDeepReview(db, "parent-1");

    expect(order[0]).toBe("lock");
    expect(JSON.stringify(locks)).toContain("deep-review:cancel:parent-1");
  });

  it("keeps a concurrent cancellation's sweep out of its own", async () => {
    const state: FakeState = {
      parent,
      items: [item({ id: "a", state: "selected" })],
      findings: [],
      usageRows: [],
    };
    const { db } = createFakeDb(state);

    // Both closers address the same tree at once, which is what a cancellation
    // landing on a run whose finalize step is already executing looks like.
    await Promise.all([
      cancelDeepReviewTree(db, "parent-1"),
      finalizeDeepReview(db, "parent-1"),
    ]);

    // The cancellation reached the item first, so the reviewer is told the run
    // was cancelled rather than that it merely ended.
    expect(state.items[0]).toMatchObject({
      state: "failed",
      failureClass: "cancelled",
      reason: "The review was cancelled before this file was reviewed.",
    });
  });

  it("patches the deep-review completion reason once acceptance lands", async () => {
    const state: FakeState = {
      parent,
      items: [
        item({ id: "a" }),
        item({ id: "b", state: "failed", failureClass: "provider" }),
      ],
      findings: [],
      usageRows: [],
    };
    const { db, updates } = createFakeDb(state);
    await finalizeDeepReview(db, "parent-1");
    expect(
      updates.some(
        (update) => update.values.completionReason === "deep_review_partial",
      ),
    ).toBe(true);
  });

  it("leaves the completion reason alone when acceptance was refused", async () => {
    mocks.acceptAiJobResult.mockResolvedValue(false);
    const state: FakeState = {
      parent: { ...parent, status: "cancelled" },
      items: [item({ id: "a", state: "failed", failureClass: "cancelled" })],
      findings: [],
      usageRows: [],
    };
    const { db, updates } = createFakeDb(state);
    const result = await finalizeDeepReview(db, "parent-1");

    expect(result.accepted).toBe(false);
    // A cancelled parent keeps `cancelled` as its reason.
    expect(
      updates.some((update) => update.values.completionReason !== undefined),
    ).toBe(false);
  });

  it("refuses to finalize a child job", async () => {
    const { db } = createFakeDb({
      parent: { id: "child-1", parentJobId: "parent-1", status: "running" },
      items: [],
      findings: [],
      usageRows: [],
    });
    await expect(finalizeDeepReview(db, "child-1")).rejects.toThrow(
      "requires a deep review parent job",
    );
  });

  it("refuses a coverage set that does not match the sealed denominator", async () => {
    const { db } = createFakeDb({
      parent,
      items: [item({ id: "a" })],
      findings: [],
      usageRows: [],
    });
    await expect(
      finalizeDeepReview(db, "parent-1", { expectedItemCount: 3 }),
    ).rejects.toThrow("does not partition the sealed plan");
  });

  it("builds a byte-identical projection on a replayed finalize", async () => {
    /** Rebuilds identical starting state so the second call is a true replay. */
    const build = () =>
      createFakeDb({
        parent,
        items: [item({ id: "a" }), item({ id: "b", state: "reused" })],
        findings: [
          { id: "f1", severity: "high", path: "src/a.ts", startLine: 3 },
        ],
        usageRows: [],
      });
    const first = await finalizeDeepReview(build().db, "parent-1");
    const second = await finalizeDeepReview(build().db, "parent-1");
    expect(first.summary).toBe(second.summary);
    expect(mocks.acceptAiJobResult.mock.calls[0]?.[2]).toEqual(
      mocks.acceptAiJobResult.mock.calls[1]?.[2],
    );
  });
});
