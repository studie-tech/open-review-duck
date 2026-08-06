import { describe, expect, it } from "vitest";
import {
  automaticSyncSlots,
  shouldRetryFailedAutomaticSync,
  supportsAssignedIntake,
} from "./intake-policy";

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
