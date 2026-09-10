import { describe, expect, it } from "vitest";
import {
  isPublicationIdentity,
  personalCredentialUsesOAuth,
} from "./personal-provider-identity";

describe("personal provider identity", () => {
  it("accepts only the two publication identities ReviewDuck stores", () => {
    expect(isPublicationIdentity("workspace")).toBe(true);
    expect(isPublicationIdentity("reviewer")).toBe(true);
    expect(isPublicationIdentity("bot")).toBe(false);
  });

  it("uses hosted OAuth only for SaaS GitHub Apps and GitLab OAuth", () => {
    expect(
      personalCredentialUsesOAuth(
        { provider: "github", credentialKind: "github_app" },
        false,
      ),
    ).toBe(true);
    expect(
      personalCredentialUsesOAuth(
        { provider: "gitlab", credentialKind: "oauth" },
        false,
      ),
    ).toBe(true);
    expect(
      personalCredentialUsesOAuth(
        { provider: "github", credentialKind: "github_app" },
        true,
      ),
    ).toBe(false);
    expect(
      personalCredentialUsesOAuth(
        { provider: "azure_devops", credentialKind: "pat" },
        false,
      ),
    ).toBe(false);
  });
});
