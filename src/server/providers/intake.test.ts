import { describe, expect, it } from "vitest";
import { supportsAssignedIntake } from "./intake-policy";

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
});
