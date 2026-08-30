import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshRepositoryPullRequestStates: vi.fn(),
}));

vi.mock("./pull-request-state", () => ({
  refreshRepositoryPullRequestStates: mocks.refreshRepositoryPullRequestStates,
}));

import type { db as database } from "~/server/db";
import { reconcileWorkspaceIntake } from "./intake";
import {
  automaticSyncSlots,
  shouldRetryFailedAutomaticSync,
  supportsAssignedIntake,
} from "./intake-policy";

type Database = typeof database;

describe("repository pull-request intake", () => {
  it("rejects assigned mode for GitHub App installations", () => {
    expect(
      supportsAssignedIntake({
        provider: "github",
        credentialKind: "github_app",
      }),
    ).toBe(false);
  });

  it("allows assigned mode for user-bound provider credentials", () => {
    expect(
      supportsAssignedIntake({
        provider: "github",
        credentialKind: "local_pat",
      }),
    ).toBe(true);
    expect(
      supportsAssignedIntake({
        provider: "gitlab",
        credentialKind: "oauth",
      }),
    ).toBe(true);
    expect(
      supportsAssignedIntake({
        provider: "azure_devops",
        credentialKind: "oauth",
      }),
    ).toBe(true);
  });

  it("starts at most one automatic synchronization per repository", () => {
    expect(automaticSyncSlots(0)).toBe(1);
    expect(automaticSyncSlots(1)).toBe(0);
    expect(automaticSyncSlots(4)).toBe(0);
  });

  it("defers failed heads during background handoff but retries on Check now", () => {
    expect(shouldRetryFailedAutomaticSync({})).toBe(false);
    expect(shouldRetryFailedAutomaticSync({ force: true })).toBe(true);
    expect(
      shouldRetryFailedAutomaticSync({ force: true, retryFailed: false }),
    ).toBe(false);
  });
});

describe("workspace intake reconciliation", () => {
  it("refreshes several repositories at once and sums their work", async () => {
    const db = {
      query: {
        repositories: {
          findMany: async () =>
            Array.from({ length: 6 }, (_value, index) => ({
              id: `repository-${index}`,
              reviewIntakeMode: "manual" as const,
            })),
        },
      },
    } as unknown as Database;
    let active = 0;
    let peak = 0;
    mocks.refreshRepositoryPullRequestStates.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return { checked: true, changed: 1, queued: 2 };
    });

    const result = await reconcileWorkspaceIntake(db, "workspace-1");

    expect(peak).toBeGreaterThan(1);
    expect(result).toEqual({ checked: 0, queued: 12, stateChanges: 6 });
  });
});
