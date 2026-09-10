import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { providerConnections } from "@/drizzle/schema";
import { sealVaultSecret } from "~/server/security/vault";
import {
  deleteUserProviderCredential,
  missingPersonalProviderMessage,
  providerForPublicationIdentity,
  providerForReviewerRead,
  providerForReviewerWrite,
  revokeUserProviderCredentials,
  saveUserProviderCredential,
} from "./user-credentials";

const { providerForConnection, isLocalDeployment } = vi.hoisted(() => ({
  providerForConnection: vi.fn(),
  isLocalDeployment: vi.fn(() => false),
}));

vi.mock("./credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./credentials")>()),
  providerForConnection,
}));

vi.mock("~/server/deployment", () => ({
  isLocalDeployment,
}));

vi.mock("~/server/security/vault", () => ({
  openVaultSecret: vi.fn(),
  sealVaultSecret: vi.fn(
    async (context: { recordId: string }, secret: string) =>
      `sealed:${context.recordId}:${secret}`,
  ),
}));

vi.mock("~/env", () => ({
  env: {
    GITHUB_APP_CLIENT_ID: "github-client",
    GITHUB_APP_CLIENT_SECRET: "github-secret",
  },
}));

const connection = {
  id: "22222222-2222-4222-8222-222222222222",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  provider: "github",
  externalAccountId: "42",
  credentialKind: "github_app",
  credentialStatus: "active",
  credentialFingerprint: "fingerprint",
  displayName: "Acme GitHub",
  installationId: "99",
  localCredentialId: null,
  baseUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies typeof providerConnections.$inferSelect;

describe("personal publication identity", () => {
  it("names the missing-credential error after the provider", () => {
    expect(missingPersonalProviderMessage("github")).toContain("GitHub");
    expect(missingPersonalProviderMessage("github")).toContain(
      "Settings → Code providers",
    );
  });

  it("keeps workspace writes on the shared connection", async () => {
    const workspaceProvider = { name: "github" };
    providerForConnection.mockResolvedValue(workspaceProvider);
    await expect(
      providerForPublicationIdentity(
        {} as never,
        connection,
        "user-1",
        "workspace",
      ),
    ).resolves.toBe(workspaceProvider);
    expect(providerForConnection).toHaveBeenCalledWith(
      expect.anything(),
      connection,
    );
  });

  it("fails closed when posting as the reviewer without a stored credential", async () => {
    await expect(
      providerForPublicationIdentity(
        {
          query: {
            userProviderCredentials: {
              findFirst: vi.fn().mockResolvedValue(undefined),
            },
          },
        } as never,
        connection,
        "user-1",
        "reviewer",
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: missingPersonalProviderMessage("github"),
    });
  });

  it("reuses a stored publication identity instead of the current preference", async () => {
    const workspaceProvider = { name: "workspace" };
    providerForConnection.mockResolvedValue(workspaceProvider);
    await expect(
      providerForReviewerWrite(
        {
          query: {
            workspaceMembers: {
              findFirst: vi.fn().mockResolvedValue({ publishAsSelf: true }),
            },
          },
        } as never,
        connection,
        "user-1",
        "workspace",
      ),
    ).resolves.toEqual({
      provider: workspaceProvider,
      publishedAs: "workspace",
    });
  });

  it("rejects a missing personal credential as a precondition failure", async () => {
    await expect(
      providerForReviewerWrite(
        {
          query: {
            userProviderCredentials: {
              findFirst: vi.fn().mockResolvedValue(undefined),
            },
          },
        } as never,
        connection,
        "user-1",
        "reviewer",
      ),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it("reads review state through the workspace when post-as-self has no credential", async () => {
    const workspaceProvider = { name: "workspace" };
    providerForConnection.mockResolvedValue(workspaceProvider);
    await expect(
      providerForReviewerRead(
        {
          query: {
            workspaceMembers: {
              findFirst: vi.fn().mockResolvedValue({ publishAsSelf: true }),
            },
            userProviderCredentials: {
              findFirst: vi.fn().mockResolvedValue(undefined),
            },
          },
        } as never,
        connection,
        "user-1",
      ),
    ).resolves.toBe(workspaceProvider);
  });
});

describe("saveUserProviderCredential", () => {
  beforeEach(() => {
    vi.mocked(sealVaultSecret).mockImplementation(
      async (context: { recordId: string }, secret: string) =>
        `sealed:${context.recordId}:${secret}`,
    );
  });

  it("reseals tokens when the upsert keeps a different record id", async () => {
    const survivingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const updateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    let insertCalls = 0;
    const db = {
      transaction: async (callback: (tx: typeof db) => Promise<unknown>) =>
        callback(db),
      query: {
        userProviderCredentials: {
          findFirst: vi.fn().mockResolvedValue(undefined),
        },
      },
      insert: vi.fn(() => {
        insertCalls += 1;
        if (insertCalls === 1) {
          return {
            values: vi.fn().mockReturnValue({
              onConflictDoUpdate: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([
                  {
                    id: survivingId,
                    connectionId: connection.id,
                    credentialKind: "github_user",
                    displayLogin: "ada",
                    externalAccountId: "1",
                  },
                ]),
              }),
            }),
          };
        }
        return { values: vi.fn().mockResolvedValue(undefined) };
      }),
      update: vi.fn(() => ({ set: updateSet })),
    };

    await saveUserProviderCredential(db as never, {
      userId: "user-1",
      connection,
      credentialKind: "github_user",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      displayLogin: "ada",
      externalAccountId: "1",
    });

    expect(updateSet).toHaveBeenCalledWith({
      encryptedAccessToken: `sealed:${survivingId}:access-token`,
      encryptedRefreshToken: `sealed:${survivingId}:refresh-token`,
    });
  });
});

describe("revokeUserProviderCredentials", () => {
  it("counts a stored grant whose provider revoke fails", async () => {
    const { openVaultSecret } = await import("~/server/security/vault");
    vi.mocked(openVaultSecret).mockRejectedValue(
      new Error("sealed under a different id"),
    );
    const db = {
      query: {
        userProviderCredentials: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "cred-1",
              credentialKind: "github_user",
              encryptedAccessToken: "ciphertext",
            },
          ]),
        },
      },
    };

    await expect(
      revokeUserProviderCredentials(db as never, connection),
    ).resolves.toBe(1);
  });
});

describe("deleteUserProviderCredential", () => {
  it("reports when the provider could not confirm revocation", async () => {
    const { openVaultSecret } = await import("~/server/security/vault");
    vi.mocked(openVaultSecret).mockRejectedValue(
      new Error("sealed under a different id"),
    );
    const db = {
      query: {
        userProviderCredentials: {
          findFirst: vi.fn().mockResolvedValue({
            id: "cred-1",
            credentialKind: "github_user",
            encryptedAccessToken: "ciphertext",
          }),
        },
      },
      delete: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
      insert: vi.fn(() => ({
        values: vi.fn().mockResolvedValue(undefined),
      })),
    };

    await expect(
      deleteUserProviderCredential(db as never, "user-1", connection),
    ).resolves.toEqual({ revoked: false });
    expect(db.delete).toHaveBeenCalled();
  });
});
