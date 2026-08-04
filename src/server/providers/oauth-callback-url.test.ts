import { describe, expect, it } from "vitest";

import {
  hostedProvider,
  oauthCallbackUrl,
  stateOAuthCallbackUrl,
} from "./oauth-callback-url";

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

  it("uses a validated state-bound callback across a deployment", () => {
    expect(
      stateOAuthCallbackUrl(
        "https://reviewduck.example",
        "gitlab",
        "https://reviewduck.example/gitlab/complete",
      ),
    ).toBe("https://reviewduck.example/gitlab/complete");
    expect(
      stateOAuthCallbackUrl(
        "https://reviewduck.example",
        "gitlab",
        "https://reviewduck.example/api/integrations/gitlab/callback",
      ),
    ).toBe("https://reviewduck.example/api/integrations/gitlab/callback");
  });

  it("falls back safely for legacy states without a bound callback", () => {
    expect(
      stateOAuthCallbackUrl(
        "https://reviewduck.example",
        "azure_devops",
        "https://attacker.example/callback",
      ),
    ).toBe("https://reviewduck.example/api/integrations/azure_devops/callback");
  });
});
