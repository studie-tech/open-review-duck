import { describe, expect, it } from "vitest";
import type { localAiConfigurations } from "@/drizzle/schema";
import { sealVaultSecret } from "~/server/security/vault";
import {
  readLocalAiSecret,
  resolveLocalAiCredentials,
  sameProviderEndpoint,
} from "./local-configuration";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";

/** Creates one stored local AI row for secret-read tests. */
function configuration(encryptedConfiguration: string) {
  return {
    id,
    workspaceId,
    provider: "openrouter",
    model: "example/model",
    encryptedConfiguration,
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies typeof localAiConfigurations.$inferSelect;
}

describe("local AI credential handling", () => {
  it("reads a valid encrypted configuration and recovers from damage", async () => {
    const encrypted = await sealVaultSecret(
      { workspaceId, recordId: id, provider: "openrouter" },
      JSON.stringify({
        apiKey: "stored-key",
        baseUrl: "https://openrouter.ai/api/v1",
        headers: { "x-title": "ReviewDuck" },
      }),
    );
    await expect(
      readLocalAiSecret(workspaceId, configuration(encrypted)),
    ).resolves.toMatchObject({ apiKey: "stored-key" });
    await expect(
      readLocalAiSecret(workspaceId, configuration("damaged")),
    ).resolves.toBeUndefined();
  });

  it("preserves credentials only for the same endpoint", () => {
    const previous = {
      apiKey: "stored-key",
      baseUrl: "https://provider.example/v1/",
      headers: { authorization: "stored-header" },
    };
    expect(
      resolveLocalAiCredentials(
        {
          baseUrl: "https://provider.example/v1",
          clearApiKey: false,
          clearHeaders: false,
          headers: {},
        },
        previous,
      ),
    ).toEqual({ apiKey: "stored-key", headers: previous.headers });
    expect(
      resolveLocalAiCredentials(
        {
          baseUrl: "https://attacker.example/v1",
          clearApiKey: false,
          clearHeaders: false,
          headers: {},
        },
        previous,
      ),
    ).toEqual({ apiKey: undefined, headers: {} });
    expect(sameProviderEndpoint("not a URL", "still not a URL")).toBe(false);
  });

  it("supports explicit replacement and removal", () => {
    expect(
      resolveLocalAiCredentials(
        {
          apiKey: "replacement",
          baseUrl: "https://provider.example/v1",
          clearApiKey: false,
          clearHeaders: true,
          headers: {},
        },
        {
          apiKey: "stored-key",
          baseUrl: "https://provider.example/v1",
          headers: { "x-stored": "value" },
        },
      ),
    ).toEqual({ apiKey: "replacement", headers: {} });
  });
});
