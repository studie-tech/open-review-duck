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
});
