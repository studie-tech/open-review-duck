import { describe, expect, it } from "vitest";
import {
  hostedPatBaseUrl,
  openProviderPat,
  sealProviderPat,
} from "./pat-credential";

describe("hosted provider PAT credential", () => {
  const context = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    connectionId: "22222222-2222-4222-8222-222222222222",
    provider: "azure_devops" as const,
  };

  it("round-trips without exposing the token in its stored value", async () => {
    const encrypted = await sealProviderPat(context, "secret-azure-pat");

    expect(encrypted).not.toContain("secret-azure-pat");
    await expect(openProviderPat(context, encrypted)).resolves.toBe(
      "secret-azure-pat",
    );
  });

  it("rejects another workspace, connection, or provider boundary", async () => {
    const encrypted = await sealProviderPat(context, "secret-azure-pat");

    await expect(
      openProviderPat(
        {
          ...context,
          workspaceId: "33333333-3333-4333-8333-333333333333",
        },
        encrypted,
      ),
    ).rejects.toThrow();
    await expect(
      openProviderPat(
        {
          ...context,
          connectionId: "44444444-4444-4444-8444-444444444444",
        },
        encrypted,
      ),
    ).rejects.toThrow();
    await expect(
      openProviderPat({ ...context, provider: "github" }, encrypted),
    ).rejects.toThrow();
  });

  it("supports hosted GitHub and GitLab plus one exact Azure organization", () => {
    expect(hostedPatBaseUrl("github", undefined)).toBeUndefined();
    expect(hostedPatBaseUrl("gitlab", undefined)).toBeUndefined();
    expect(
      hostedPatBaseUrl("azure_devops", "https://dev.azure.com/acme/"),
    ).toBe("https://dev.azure.com/acme");
    expect(() =>
      hostedPatBaseUrl("github", "https://github.example.com/api/v3"),
    ).toThrow("support GitHub.com and GitLab.com only");
  });
});
