import { describe, expect, it } from "vitest";

import { hostedProvider, oauthCallbackUrl } from "./oauth-callback-url";

describe("provider OAuth callback URLs", () => {
  it.each([
    ["github", "https://reviewduck.example/github/complete"],
    ["gitlab", "https://reviewduck.example/gitlab/complete"],
    ["azure_devops", "https://reviewduck.example/azure-devops/complete"],
  ] as const)("uses the browser-safe path for %s", (provider, expected) => {
    expect(oauthCallbackUrl("https://reviewduck.example", provider)).toBe(
      expected,
    );
  });

  it("accepts only hosted providers", () => {
    expect(hostedProvider("gitlab")).toBe(true);
    expect(hostedProvider("bitbucket")).toBe(false);
  });
});
