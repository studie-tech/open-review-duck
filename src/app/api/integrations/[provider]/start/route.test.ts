import { TRPCError } from "@trpc/server";
import { decodeJwt } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route.saas";

const mocks = vi.hoisted(() => ({
  findConnection: vi.fn(),
  membership: vi.fn(),
  administrator: vi.fn(),
  insert: vi.fn(),
  seal: vi.fn(),
}));
vi.mock("~/env", () => ({
  env: {
    APP_URL: "https://review.example.com",
    OAUTH_STATE_SECRET: "test-state-secret-long-enough-for-signing",
    GITHUB_APP_CLIENT_ID: "github-client",
    GITLAB_CLIENT_ID: "gitlab-client",
  },
}));
vi.mock("~/server/auth", () => ({
  applicationAuth: async () => ({ userId: "reviewer" }),
}));
vi.mock("~/server/db", () => ({
  db: {
    query: { providerConnections: { findFirst: mocks.findConnection } },
    insert: () => ({ values: mocks.insert }),
  },
}));
vi.mock("~/server/workspaces/service", () => ({
  ensurePersonalWorkspace: async () => ({ id: "personal-workspace" }),
}));
vi.mock("~/server/workspaces/access", () => ({
  requireWorkspaceMembership: mocks.membership,
  requirePersonalWorkspaceAdministrator: mocks.administrator,
}));
vi.mock("~/server/security/rate-limit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("~/server/security/vault", () => ({ sealVaultSecret: mocks.seal }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findConnection.mockResolvedValue({
    id: "12345678-1234-4123-8123-123456789012",
    workspaceId: "team-workspace",
  });
  mocks.membership.mockResolvedValue({ role: "member" });
  mocks.seal.mockResolvedValue("encrypted-verifier");
});

describe("personal provider authorization workspace", () => {
  it("refuses identity authorization when the caller is not a team member", async () => {
    mocks.membership.mockRejectedValueOnce(
      new TRPCError({ code: "FORBIDDEN" }),
    );
    const response = await POST(
      new Request("https://review.example.com/api/integrations/start", {
        method: "POST",
        body: JSON.stringify({
          purpose: "user_identity",
          connectionId: "12345678-1234-4123-8123-123456789012",
        }),
      }),
      { params: Promise.resolve({ provider: "github" }) },
    );
    expect(response.status).toBe(403);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it.each(["github", "gitlab"])(
    "binds %s identity authorization to the selected team's connection",
    async (provider) => {
      const response = await POST(
        new Request("https://review.example.com/api/integrations/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            purpose: "user_identity",
            connectionId: "12345678-1234-4123-8123-123456789012",
            redirectPath: "/review/123",
          }),
        }),
        { params: Promise.resolve({ provider }) },
      );
      expect(response.status).toBe(200);
      expect(mocks.membership).toHaveBeenCalledWith(
        expect.anything(),
        "team-workspace",
        "reviewer",
      );
      expect(mocks.administrator).not.toHaveBeenCalled();
      const { authorizationUrl } = await response.json();
      const claims = decodeJwt(
        new URL(authorizationUrl).searchParams.get("state") ?? "",
      );
      expect(claims).toMatchObject({
        workspaceId: "team-workspace",
        connectionId: "12345678-1234-4123-8123-123456789012",
        sub: "reviewer",
        purpose: "user_identity",
      });
      expect(mocks.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "team-workspace",
          redirectPath: "/review/123",
        }),
      );
      expect(mocks.seal).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "team-workspace" }),
        expect.stringContaining(
          '"connectionId":"12345678-1234-4123-8123-123456789012"',
        ),
      );
    },
  );
});
