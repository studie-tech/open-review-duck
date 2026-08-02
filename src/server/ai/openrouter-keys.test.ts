import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("~/env", () => ({
  env: {
    OPENROUTER_MANAGEMENT_KEY: "management-key",
    OPENROUTER_WORKSPACE_MONTHLY_LIMIT_USD: 20,
  },
}));

vi.mock("~/server/security/vault", () => ({
  openVaultSecret: vi.fn(),
  sealVaultSecret: vi.fn(),
}));

import {
  billingPayerForManagedCredentialRevocation,
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
