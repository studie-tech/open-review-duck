import { describe, expect, it } from "vitest";
import { PROVIDER_NAMES, providerLabel } from "./provider-labels";

describe("providerLabel", () => {
  it("names the known providers", () => {
    expect(providerLabel("github")).toBe("GitHub");
    expect(providerLabel("gitlab")).toBe("GitLab");
    expect(providerLabel("azure_devops")).toBe("Azure DevOps");
  });

  it("returns an unknown id instead of guessing GitHub", () => {
    expect(providerLabel("bitbucket")).toBe("bitbucket");
  });

  it("lists every known provider id", () => {
    expect([...PROVIDER_NAMES]).toEqual(["github", "gitlab", "azure_devops"]);
  });
});
