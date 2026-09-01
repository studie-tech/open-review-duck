import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  isLocalDeployment: vi.fn(() => false),
  enforceRateLimit: vi.fn(async () => undefined),
  cancelWorkflowRun: vi.fn(async () => undefined),
  cancelDeepReviewTree: vi.fn(async () => {
    mocks.order.push("cancelDeepReviewTree");
  }),
  settleAiJobQuota: vi.fn(async () => {
    mocks.order.push("settleAiJobQuota");
  }),
  personalWorkspace: vi.fn(async () => ({
    id: "workspace-1",
    aiMode: "on_demand" as const,
    aiReviewEnabled: true,
  })),
}));

vi.mock("~/server/deployment", () => ({
  isLocalDeployment: mocks.isLocalDeployment,
}));
vi.mock("~/server/security/rate-limit", () => ({
  enforceRateLimit: mocks.enforceRateLimit,
}));
vi.mock("~/server/workflows/service", () => ({
  cancelWorkflowRun: mocks.cancelWorkflowRun,
  startAiJob: vi.fn(),
}));
vi.mock("~/server/review/deep/cancel", () => ({
  cancelDeepReviewTree: mocks.cancelDeepReviewTree,
}));
vi.mock("~/server/workspaces/service", () => ({
  ensurePersonalWorkspace: mocks.personalWorkspace,
}));
vi.mock("~/server/workspaces/access", () => ({
  requirePersonalWorkspaceAdministrator: mocks.personalWorkspace,
}));
vi.mock("~/server/ai/plan", () => ({
  PAID_AI_FEATURE: "paid_ai_models",
  SCALE_AI_FEATURE: "managed_ai_scale",
  ULTRA_AI_FEATURE: "managed_ai_ultra",
  managedAiPlanTier: (hasFeature: (feature: string) => boolean) =>
    hasFeature("managed_ai_ultra")
      ? "ultra"
      : hasFeature("managed_ai_scale")
        ? "scale"
        : hasFeature("paid_ai_models")
          ? "pro"
          : "free",
  managedSaasModel: () => "managed-model",
  managedAiPlanUsage: vi.fn(),
  managedAiMonthlyTokenLimit: () => 100_000,
  managedAiMonthWindow: () => ({ startsAt: new Date(), resetsAt: new Date() }),
}));
// Partial: `createAiJob` stays real so the refusal it throws is the one the
// router has to recognise, while the quota settle is a database write.
vi.mock("~/server/ai/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/server/ai/service")>()),
  settleAiJobQuota: mocks.settleAiJobQuota,
}));

import { DEEP_REVIEW_UNENTITLED_MESSAGE } from "~/server/ai/service";
import { createCallerFactory } from "~/server/api/trpc";
import type { db as database } from "~/server/db";
import { aiRouter } from "./ai";

const createCaller = createCallerFactory(aiRouter);
const dialect = new PgDialect();

type Database = typeof database;

interface FakeState {
  aiJob?: Record<string, unknown>;
  usageRow?: Record<string, unknown>;
}

/** Renders a drizzle predicate so a test can assert on the SQL it emits. */
function renderSql(value: unknown) {
  return dialect.sqlToQuery(value as SQL).sql;
}

/** Builds the smallest database double these read paths actually exercise. */
function createFakeDb(state: FakeState = {}) {
  const captured: {
    jobWhere?: unknown;
    usageSelection?: Record<string, unknown>;
    updates: Record<string, unknown>[];
  } = { updates: [] };

  const db = {
    query: {
      aiJobs: {
        findFirst: async (config: { where?: unknown }) => {
          captured.jobWhere = config.where;
          return state.aiJob;
        },
      },
      aiPreferences: { findFirst: async () => undefined },
      localAiConfigurations: { findFirst: async () => undefined },
      users: { findFirst: async () => undefined },
      workflowRuns: { findFirst: async () => undefined },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          mocks.order.push("markCancelled");
          captured.updates.push(values);
          return [];
        },
      }),
    }),
    select: (selection: Record<string, unknown>) => {
      captured.usageSelection = selection;
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: async () => (state.usageRow ? [state.usageRow] : []),
      };
      return chain;
    },
  };
  return { db: db as unknown as Database, captured };
}

/** Builds a caller for one reviewer at one entitlement level. */
function caller(db: Database, subscribed = false) {
  return createCaller({
    db,
    auth: { userId: "reviewer-1", has: () => subscribed },
    headers: new Headers(),
  });
}

beforeEach(() => {
  mocks.order.length = 0;
  vi.clearAllMocks();
  mocks.isLocalDeployment.mockReturnValue(false);
  mocks.personalWorkspace.mockResolvedValue({
    id: "workspace-1",
    aiMode: "on_demand",
    aiReviewEnabled: true,
  });
});

describe("ai.configuration deep review availability", () => {
  it("advertises deep review to a subscribed hosted account", async () => {
    const { db } = createFakeDb();
    await expect(caller(db, true).configuration()).resolves.toMatchObject({
      deepReviewAvailable: true,
    });
  });

  it("withholds deep review from an unsubscribed hosted account", async () => {
    const { db } = createFakeDb();
    await expect(caller(db, false).configuration()).resolves.toMatchObject({
      deepReviewAvailable: false,
    });
  });

  it("advertises deep review on the local appliance", async () => {
    mocks.isLocalDeployment.mockReturnValue(true);
    const { db } = createFakeDb();
    await expect(caller(db, false).configuration()).resolves.toMatchObject({
      deepReviewAvailable: true,
    });
  });

  it("issues the preference, provider and account reads together", async () => {
    mocks.isLocalDeployment.mockReturnValue(true);
    let inFlight = 0;
    let peak = 0;
    /** Counts overlapping lookups by suspending before it resolves. */
    const lookup = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return undefined;
    };
    const db = {
      query: {
        aiPreferences: { findFirst: lookup },
        localAiConfigurations: { findFirst: lookup },
        users: { findFirst: lookup },
      },
    } as unknown as Database;
    await caller(db).configuration();
    expect(peak).toBe(3);
  });
});

describe("ai.start deep review refusal", () => {
  it("tells an unentitled caller it needs a plan, not to try again", async () => {
    const { db } = createFakeDb();
    await expect(
      caller(db, false).start({
        pullRequestId: "3f1d1f9c-6b0b-4a2f-8a1c-9d5e2b7c4a10",
        kind: "review",
      }),
    ).rejects.toThrow(DEEP_REVIEW_UNENTITLED_MESSAGE);
  });

  it("does not fall through to any other reviewer", async () => {
    const { db } = createFakeDb();
    await caller(db, false)
      .start({
        pullRequestId: "3f1d1f9c-6b0b-4a2f-8a1c-9d5e2b7c4a10",
        kind: "review",
      })
      .catch(() => undefined);
    expect(mocks.order).toEqual([]);
  });

  it("does not leak unexpected start failures", async () => {
    const service = await import("~/server/ai/service");
    const job = vi
      .spyOn(service, "createAiJob")
      .mockRejectedValueOnce(new Error("relation ai_jobs does not exist"));
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { db } = createFakeDb();
    await expect(
      caller(db, true).start({
        pullRequestId: "3f1d1f9c-6b0b-4a2f-8a1c-9d5e2b7c4a10",
        kind: "review",
      }),
    ).rejects.toThrow("Could not start the AI assistant. Try again.");
    job.mockRestore();
    error.mockRestore();
  });
});

describe("ai.cancel", () => {
  it("refuses to resolve a deep-review child by id", async () => {
    const { db, captured } = createFakeDb({ aiJob: undefined });
    await expect(
      caller(db).cancel({ jobId: "b0a1c2d3-e4f5-4061-8273-8495a6b7c8d9" }),
    ).rejects.toThrow();
    expect(renderSql(captured.jobWhere)).toContain('"parentJobId" is null');
  });

  it("closes the review tree after cancelling and before settling", async () => {
    const { db } = createFakeDb({
      aiJob: {
        id: "5d4c3b2a-1908-4f7e-9d6c-5b4a39281706",
        kind: "review",
        workflowRunId: null,
      },
    });
    await expect(
      caller(db).cancel({ jobId: "5d4c3b2a-1908-4f7e-9d6c-5b4a39281706" }),
    ).resolves.toEqual({ status: "cancelled" });
    // The tree sweep must see a parent already marked cancelled, or its
    // finalize would accept the run as completed, and it must run before the
    // one-shot settle, which would otherwise book the children's tokens as
    // zero.
    expect(mocks.order).toEqual([
      "markCancelled",
      "cancelDeepReviewTree",
      "settleAiJobQuota",
    ]);
  });

  it("leaves an explanation cancel on the single-job path", async () => {
    const { db } = createFakeDb({
      aiJob: {
        id: "5d4c3b2a-1908-4f7e-9d6c-5b4a39281706",
        kind: "explain",
        workflowRunId: null,
      },
    });
    await caller(db).cancel({ jobId: "5d4c3b2a-1908-4f7e-9d6c-5b4a39281706" });
    expect(mocks.cancelDeepReviewTree).not.toHaveBeenCalled();
    expect(mocks.order).toEqual(["markCancelled", "settleAiJobQuota"]);
  });
});

describe("ai.usage over a review tree", () => {
  it("counts only the parents as runs", async () => {
    const { db, captured } = createFakeDb();
    await caller(db).usage({
      pullRequestId: "3f1d1f9c-6b0b-4a2f-8a1c-9d5e2b7c4a10",
    });
    expect(renderSql(captured.usageSelection?.runs)).toBe(
      'count(*) filter (where "open_review_duck_ai_job"."parentJobId" is null)',
    );
  });

  it("sums tokens across the whole tree, where the children spend them", async () => {
    const { db, captured } = createFakeDb();
    await caller(db).usage({
      pullRequestId: "3f1d1f9c-6b0b-4a2f-8a1c-9d5e2b7c4a10",
    });
    for (const column of ["inputTokens", "outputTokens", "totalTokens"]) {
      expect(renderSql(captured.usageSelection?.[column])).not.toContain(
        "filter",
      );
    }
  });

  it("reports one run carrying the tokens its children consumed", async () => {
    const { db } = createFakeDb({
      usageRow: {
        runs: "1",
        inputTokens: "700",
        outputTokens: "200",
        cacheReadTokens: "50",
        cacheWriteTokens: "10",
        totalTokens: "900",
      },
    });
    await expect(
      caller(db).usage({
        pullRequestId: "3f1d1f9c-6b0b-4a2f-8a1c-9d5e2b7c4a10",
      }),
    ).resolves.toEqual({
      runs: 1,
      inputTokens: 700,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      totalTokens: 900,
    });
  });
});
