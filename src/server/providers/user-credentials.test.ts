import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import type { providerConnections } from "@/drizzle/schema";
import {
  missingPersonalProviderMessage,
  preferredPublicationIdentity,
  providerForPublicationIdentity,
  providerForReviewerWrite,
} from "./user-credentials";

const { providerForConnection } = vi.hoisted(() => ({
  providerForConnection: vi.fn(),
}));

vi.mock("./credentials", () => ({
  providerForConnection,
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

  it("defaults new writes to the workspace connection", async () => {
    await expect(
      preferredPublicationIdentity(
        {
          query: {
            workspaceMembers: {
              findFirst: vi.fn().mockResolvedValue({ publishAsSelf: false }),
            },
          },
        } as never,
        connection.workspaceId,
        "user-1",
      ),
    ).resolves.toBe("workspace");
  });

  it("selects the reviewer identity when the preference is on", async () => {
    await expect(
      preferredPublicationIdentity(
        {
          query: {
            workspaceMembers: {
              findFirst: vi.fn().mockResolvedValue({ publishAsSelf: true }),
            },
          },
        } as never,
        connection.workspaceId,
        "user-1",
      ),
    ).resolves.toBe("reviewer");
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
});
