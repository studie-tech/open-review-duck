import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ isLocalDeployment: vi.fn(() => false) }));

vi.mock("~/server/ai/plan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/server/ai/plan")>()),
  managedSaasModel: () => "test-model",
}));

vi.mock("~/server/deployment", () => ({
  isLocalDeployment: mocks.isLocalDeployment,
}));

import {
  createAiJob,
  DEEP_REVIEW_UNENTITLED_MESSAGE,
  deepReviewAvailable,
} from "./service";

const REACHED_DATABASE = "the entitlement gate let the call through";

/**
 * Builds a database that fails loudly the instant anything touches it.
 *
 * A refusal must cost nothing, and the gate is only in front of `jobScope` if
 * a rejected call never reads a row; distinguishing this error from the
 * refusal is also how the passing cases prove the gate stayed open.
 */
function unreachableDatabase() {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(REACHED_DATABASE);
      },
    },
  ) as unknown as Parameters<typeof createAiJob>[0];
}

/** Names one caller of `createAiJob` without repeating its required scope. */
function jobInput(
  kind: "explain" | "review",
  subscribed: boolean,
): Parameters<typeof createAiJob>[1] {
  return {
    pullRequestId: "3f1d1f9c-6b0b-4a2f-8a1c-9d5e2b7c4a10",
    kind,
    userId: "reviewer-1",
    subscribed,
    ...(kind === "explain"
      ? { unitId: "8c2b6f41-2a55-4f0e-9f7d-1b3c5a6e7d80" }
      : {}),
  };
}

beforeEach(() => {
  mocks.isLocalDeployment.mockReturnValue(false);
});

describe("deep review entitlement", () => {
  it("admits a subscribed hosted account", () => {
    expect(deepReviewAvailable(true)).toBe(true);
  });

  it("refuses an unsubscribed hosted account", () => {
    expect(deepReviewAvailable(false)).toBe(false);
  });

  it("admits the local appliance, which can never report a subscription", () => {
    mocks.isLocalDeployment.mockReturnValue(true);
    // Local deployments always report `subscribed` as false and therefore
    // require an explicit deployment-mode entitlement.
    expect(deepReviewAvailable(false)).toBe(true);
  });
});

describe("createAiJob deep review gate", () => {
  it("refuses an unentitled review without reading the database", async () => {
    await expect(
      createAiJob(unreachableDatabase(), jobInput("review", false)),
    ).rejects.toThrow(DEEP_REVIEW_UNENTITLED_MESSAGE);
  });

  it("states the refusal in the exact wording the router forwards", () => {
    expect(DEEP_REVIEW_UNENTITLED_MESSAGE).toBe(
      "Deep review requires a paid plan",
    );
  });

  it("admits a subscribed review", async () => {
    await expect(
      createAiJob(unreachableDatabase(), jobInput("review", true)),
    ).rejects.toThrow(REACHED_DATABASE);
  });

  it("admits a review on the local appliance", async () => {
    mocks.isLocalDeployment.mockReturnValue(true);
    await expect(
      createAiJob(unreachableDatabase(), jobInput("review", false)),
    ).rejects.toThrow(REACHED_DATABASE);
  });

  it("leaves explanations ungated, which stay on the free tier", async () => {
    await expect(
      createAiJob(unreachableDatabase(), jobInput("explain", false)),
    ).rejects.toThrow(REACHED_DATABASE);
  });
});

/** Supplies current context while returning a still-active older review. */
function databaseWithActiveReview(status: string) {
  const active = {
    id: "existing-run",
    snapshotId: "old-snapshot",
    agentVersion: "old-agent",
    status,
  };
  const lookup = vi.fn(
    async (_config: { where: import("drizzle-orm").SQL | undefined }) => active,
  );
  const execute = vi.fn(async () => undefined);
  const insert = vi.fn(() => {
    throw new Error("Duplicate review reserved quota or inserted a job");
  });
  const tx = { query: { aiJobs: { findFirst: lookup } }, execute, insert };
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => [{ workspace: { id: "workspace-1" } }],
  };
  const db = {
    select: () => chain,
    query: {
      reviewSnapshots: { findFirst: async () => ({ id: "new-snapshot" }) },
      aiPreferences: { findFirst: async () => undefined },
      reviewUnits: { findMany: async () => [{ id: "unit-1" }] },
      managedAiModels: { findFirst: async () => ({ supportsTools: true }) },
    },
    transaction: async (run: (transaction: typeof tx) => Promise<unknown>) =>
      run(tx),
  };
  return {
    db: db as unknown as Parameters<typeof createAiJob>[0],
    active,
    lookup,
    execute,
    insert,
  };
}

describe("active PR review reuse", () => {
  it.each(["queued", "running", "waiting_for_provider", "streaming"])(
    "reuses a %s run from before snapshot refresh without reserving more quota",
    async (status) => {
      const fixture = databaseWithActiveReview(status);
      expect(await createAiJob(fixture.db, jobInput("review", true))).toBe(
        fixture.active,
      );
      expect(fixture.insert).not.toHaveBeenCalled();
      const where = fixture.lookup.mock.calls[0]?.[0].where;
      if (!where) throw new Error("Missing active review lookup");
      const predicate = new PgDialect().sqlToQuery(where);
      expect(predicate.sql).not.toContain('"snapshotId"');
      expect(predicate.sql).not.toContain('"agentVersion"');
      expect(predicate.params).toContain(
        jobInput("review", true).pullRequestId,
      );
      expect(predicate.params).toContain("reviewer-1");
      expect(fixture.execute.mock.invocationCallOrder[0]).toBeLessThan(
        fixture.lookup.mock.invocationCallOrder[0] ?? 0,
      );
    },
  );
});
