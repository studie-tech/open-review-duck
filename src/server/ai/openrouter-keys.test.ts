import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("~/env", () => ({
  env: {
    OPENROUTER_MANAGEMENT_KEY: "management-key",
  },
}));

vi.mock("~/server/security/vault", () => ({
  openVaultSecret: vi.fn(),
  sealVaultSecret: vi.fn(),
}));

import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";
import {
  billingPayerForManagedCredentialRevocation,
  openRouterWorkspaceKey,
  revokeOpenRouterWorkspaceKeysForBillingPayer,
} from "./openrouter-keys";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("managed OpenRouter key lifecycle", () => {
  it("revokes only after a Clerk subscription reaches a terminal state", () => {
    const payer = { user_id: "user_1" };
    expect(
      billingPayerForManagedCredentialRevocation({
        type: "subscription.updated",
        data: { payer, status: "ended" },
      }),
    ).toEqual(payer);
    expect(
      billingPayerForManagedCredentialRevocation({
        type: "subscriptionItem.ended",
        data: { payer, status: "ended" },
      }),
    ).toEqual(payer);
    expect(
      billingPayerForManagedCredentialRevocation({
        type: "subscriptionItem.canceled",
        data: { payer, status: "canceled" },
      }),
    ).toBeUndefined();
    expect(
      billingPayerForManagedCredentialRevocation({
        type: "subscription.updated",
        data: { payer, status: "active" },
      }),
    ).toBeUndefined();
  });

  it("revokes every distinct workspace associated with the billing payer", async () => {
    const workspaceResults = [
      [{ id: "workspace-user" }],
      [{ id: "workspace-user" }, { id: "workspace-organization" }],
    ];
    const whereWorkspace = vi.fn(() =>
      Promise.resolve(workspaceResults.shift() ?? []),
    );
    const deleteCredential = vi.fn(() => ({ where: vi.fn() }));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: whereWorkspace })),
      })),
      query: {
        managedAiCredentials: {
          findFirst: vi.fn(() =>
            Promise.resolve({
              id: crypto.randomUUID(),
              providerKeyId: crypto.randomUUID(),
            }),
          ),
        },
      },
      delete: deleteCredential,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      revokeOpenRouterWorkspaceKeysForBillingPayer(db as never, {
        organization_id: "organization_1",
        user_id: "user_1",
      }),
    ).resolves.toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(deleteCredential).toHaveBeenCalledTimes(2);
  });
});

describe("managed OpenRouter key spend caps", () => {
  it("creates a workspace key without a provider spend limit", async () => {
    const created = {
      id: "credential-1",
      workspaceId: "workspace-1",
      provider: "openrouter",
      providerKeyId: "key-hash",
      encryptedCredential: "sealed",
      monthlyLimitMicroUsd: 0,
    };
    const insertValues = vi.fn();
    const db = {
      query: {
        managedAiCredentials: {
          findFirst: vi.fn().mockResolvedValueOnce(undefined),
        },
      },
      insert: vi.fn(() => ({
        values: (value: unknown) => {
          insertValues(value);
          return {
            onConflictDoNothing: () => ({
              returning: async () => [created],
            }),
          };
        },
      })),
    };
    vi.mocked(sealVaultSecret).mockResolvedValue("sealed");
    vi.mocked(openVaultSecret).mockResolvedValue("sk-or-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ data: { hash: "key-hash" }, key: "sk-or-key" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      openRouterWorkspaceKey(db as never, "workspace-1"),
    ).resolves.toBe("sk-or-key");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      name: "reviewduck-workspace-1",
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ monthlyLimitMicroUsd: 0 }),
    );
  });

  it("lifts a leftover provider spend cap from an existing key", async () => {
    const credential = {
      id: "credential-1",
      workspaceId: "workspace-1",
      provider: "openrouter",
      providerKeyId: "key-hash",
      encryptedCredential: "sealed",
      monthlyLimitMicroUsd: 20_000_000,
    };
    const updateSet = vi.fn(() => ({ where: vi.fn() }));
    const db = {
      query: {
        managedAiCredentials: {
          findFirst: vi.fn().mockResolvedValue(credential),
        },
      },
      update: vi.fn(() => ({ set: updateSet })),
    };
    vi.mocked(openVaultSecret).mockResolvedValue("sk-or-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      openRouterWorkspaceKey(db as never, "workspace-1"),
    ).resolves.toBe("sk-or-key");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/keys/key-hash");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      limit: null,
      limit_reset: null,
    });
    expect(updateSet).toHaveBeenCalledWith({ monthlyLimitMicroUsd: 0 });
  });
});
