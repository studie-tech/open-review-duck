import { describe, expect, it } from "vitest";
import {
  supportsManagedReauthorization,
  supportsTokenReplacement,
} from "./provider-credential-recovery";

describe("provider credential recovery", () => {
  it("lets local deployments replace any saved authorization with a PAT", () => {
    expect(supportsTokenReplacement(true, "github_app")).toBe(true);
    expect(supportsTokenReplacement(true, "oauth")).toBe(true);
  });

  it("only replaces PAT credentials in hosted deployments", () => {
    expect(supportsTokenReplacement(false, "pat")).toBe(true);
    expect(supportsTokenReplacement(false, "local_pat")).toBe(true);
    expect(supportsTokenReplacement(false, "github_app")).toBe(false);
    expect(supportsTokenReplacement(false, "oauth")).toBe(false);
  });

  it("reauthorizes managed credentials only in hosted deployments", () => {
    expect(supportsManagedReauthorization(false, "github_app", "github")).toBe(
      true,
    );
    expect(supportsManagedReauthorization(false, "oauth", "gitlab")).toBe(true);
    expect(supportsManagedReauthorization(false, "pat", "github")).toBe(false);
    expect(supportsManagedReauthorization(true, "github_app", "github")).toBe(
      false,
    );
  });

  it("offers no hosted reconnect for a provider that has no such flow", () => {
    expect(supportsManagedReauthorization(false, "oauth", "azure_devops")).toBe(
      false,
    );
    expect(supportsTokenReplacement(false, "pat")).toBe(true);
  });
});
