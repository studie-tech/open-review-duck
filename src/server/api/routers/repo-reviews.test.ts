import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAiJob: vi.fn(),
  scheduleAiJob: vi.fn(),
  enforceRateLimit: vi.fn(async () => undefined),
  ensurePersonalWorkspace: vi.fn(async () => ({ id: "workspace-1" })),
}));

vi.mock("~/server/ai/service", () => ({
  createAiJob: mocks.createAiJob,
  scheduleAiJob: mocks.scheduleAiJob,
}));
vi.mock("~/server/security/rate-limit", () => ({
  enforceRateLimit: mocks.enforceRateLimit,
}));
vi.mock("~/server/workspaces/service", () => ({
  ensurePersonalWorkspace: mocks.ensurePersonalWorkspace,
}));

import { createCallerFactory } from "~/server/api/trpc";
import type { db as database } from "~/server/db";
import { repoReviewsRouter } from "./repo-reviews";

const createCaller = createCallerFactory(repoReviewsRouter);
const monitorId = "3f1d1f9c-6b0b-4a2f-8a1c-9d5e2b7c4a10";
const pullRequestId = "8c2b6f41-2a55-4f0e-9f7d-1b3c5a6e7d80";

type Database = typeof database;

/** Builds the monitor + snapshot reads `startRun` needs before creating a job. */
function createFakeDb() {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => [
      {
        monitor: { pullRequestId },
        repository: {},
        connection: {},
      },
    ],
  };
  return {
    select: () => chain,
    query: {
      reviewSnapshots: {
        findFirst: async () => ({ id: "snapshot-1", version: 1 }),
      },
    },
  } as unknown as Database;
}

/** Builds a caller whose Clerk `has` matches one entitlement feature. */
function caller(features: readonly string[]) {
  return createCaller({
    db: createFakeDb(),
    auth: {
      userId: "reviewer-1",
      has: ({ feature }: { feature: string }) => features.includes(feature),
    },
    headers: new Headers(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createAiJob.mockResolvedValue({ id: "job-1" });
  mocks.scheduleAiJob.mockResolvedValue({ workflowRunId: "run-1" });
  mocks.ensurePersonalWorkspace.mockResolvedValue({ id: "workspace-1" });
});

describe("repoReviews.startRun entitlement", () => {
  it("treats Ultra as a paid plan even without paid_ai_models", async () => {
    await caller(["managed_ai_ultra"]).startRun({
      monitorId,
      purpose: "code",
    });
    expect(mocks.createAiJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subscribed: true,
        planTier: "ultra",
        reviewPurpose: "code",
      }),
    );
  });

  it("treats Scale as a paid plan even without paid_ai_models", async () => {
    await caller(["managed_ai_scale"]).startRun({
      monitorId,
      purpose: "code",
    });
    expect(mocks.createAiJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subscribed: true,
        planTier: "scale",
      }),
    );
  });

  it("still treats Pro as a paid plan", async () => {
    await caller(["paid_ai_models"]).startRun({
      monitorId,
      purpose: "code",
    });
    expect(mocks.createAiJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subscribed: true,
        planTier: "pro",
      }),
    );
  });

  it("refuses an unsubscribed hosted account", async () => {
    mocks.createAiJob.mockRejectedValueOnce(
      new Error("Deep review requires a paid plan"),
    );
    await expect(
      caller([]).startRun({ monitorId, purpose: "code" }),
    ).rejects.toThrow("Deep review requires a paid plan");
    expect(mocks.createAiJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subscribed: false,
        planTier: "free",
      }),
    );
  });
});
