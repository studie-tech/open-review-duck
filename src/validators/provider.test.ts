import { describe, expect, it } from "vitest";
import { connectProviderSchema } from "./provider";

describe("provider connection validation", () => {
  it.each(["github", "gitlab"] as const)(
    "accepts a %s PAT without a custom API URL",
    (provider) => {
      expect(
        connectProviderSchema.safeParse({ provider, accessToken: "token" })
          .success,
      ).toBe(true);
    },
  );

  it("requires an organization URL for an Azure DevOps PAT", () => {
    const result = connectProviderSchema.safeParse({
      provider: "azure_devops",
      accessToken: "token",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        path: ["baseUrl"],
        message: "Azure DevOps requires an organization URL",
      });
    }
  });

  it("accepts a connection ID when replacing an existing token", () => {
    expect(
      connectProviderSchema.safeParse({
        connectionId: "0bf4a1f7-0f30-4f08-9439-577356ddbc13",
        provider: "azure_devops",
        accessToken: "replacement-token",
        baseUrl: "https://dev.azure.com/acme",
      }).success,
    ).toBe(true);
  });

  it("rejects a malformed replacement connection ID", () => {
    expect(
      connectProviderSchema.safeParse({
        connectionId: "not-a-connection",
        provider: "github",
        accessToken: "replacement-token",
      }).success,
    ).toBe(false);
  });
});
