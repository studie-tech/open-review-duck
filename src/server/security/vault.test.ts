import { describe, expect, it } from "vitest";
import { openVaultSecret, sealVaultSecret } from "./vault";

describe("credential vault", () => {
  it("round-trips secrets inside their exact authenticated context", async () => {
    const context = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      recordId: "22222222-2222-4222-8222-222222222222",
      provider: "gitlab-oauth-refresh",
    };
    const encrypted = await sealVaultSecret(context, "secret-token");
    await expect(openVaultSecret(context, encrypted)).resolves.toBe(
      "secret-token",
    );
    await expect(
      openVaultSecret(
        {
          ...context,
          workspaceId: "33333333-3333-4333-8333-333333333333",
        },
        encrypted,
      ),
    ).rejects.toThrow();
  });

  it("binds ciphertext to the exact record and provider", async () => {
    const context = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      recordId: "22222222-2222-4222-8222-222222222222",
      provider: "gitlab-oauth-refresh",
    };
    const encrypted = await sealVaultSecret(context, "secret-token");

    await expect(
      openVaultSecret(
        {
          ...context,
          recordId: "44444444-4444-4444-8444-444444444444",
        },
        encrypted,
      ),
    ).rejects.toThrow();
    await expect(
      openVaultSecret({ ...context, provider: "github-oauth" }, encrypted),
    ).rejects.toThrow();
  });

  it("rejects values outside the vault envelope format", async () => {
    await expect(
      openVaultSecret(
        {
          workspaceId: "11111111-1111-4111-8111-111111111111",
          recordId: "22222222-2222-4222-8222-222222222222",
          provider: "gitlab-oauth-refresh",
        },
        "not-a-vault-payload",
      ),
    ).rejects.toThrow("Encrypted vault value has an unsupported format");
  });
});
