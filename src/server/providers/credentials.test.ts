import { afterEach, describe, expect, it, vi } from "vitest";
import type { providerConnections } from "@/drizzle/schema";
import { sealProviderPat } from "./pat-credential";

const { safeRemoteFetchMock } = vi.hoisted(() => ({
  safeRemoteFetchMock: vi.fn(),
}));

vi.mock("~/server/deployment", () => ({
  isLocalDeployment: () => false,
}));
vi.mock("~/server/security/remote-url", () => ({
  safeRemoteFetch: safeRemoteFetchMock,
}));

afterEach(() => vi.clearAllMocks());

describe("hosted provider credential resolution", () => {
  it("opens a saved PAT and authenticates the provider request", async () => {
    const connection = {
      id: "22222222-2222-4222-8222-222222222222",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      provider: "github",
      externalAccountId: "42",
      credentialKind: "pat",
      credentialFingerprint: "fingerprint",
      displayName: "Work GitHub",
      installationId: null,
      localCredentialId: null,
      baseUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies typeof providerConnections.$inferSelect;
    const encryptedToken = await sealProviderPat(
      {
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
        provider: connection.provider,
      },
      "hosted-github-pat",
    );
    const findFirst = vi.fn().mockResolvedValue({ encryptedToken });
    safeRemoteFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 42, login: "octocat", name: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { providerForConnection } = await import("./credentials");

    const provider = await providerForConnection(
      {
        query: { providerPatCredentials: { findFirst } },
      } as never,
      connection,
    );
    await expect(provider.getConnectionIdentity()).resolves.toEqual({
      externalAccountId: "42",
      displayName: "octocat",
    });
    expect(findFirst).toHaveBeenCalledOnce();
    expect(safeRemoteFetchMock).toHaveBeenCalledOnce();
    const [url, init, allowPrivateHosts] =
      safeRemoteFetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.github.com/user");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer hosted-github-pat",
    );
    expect(allowPrivateHosts).toBe(false);
  });
});
