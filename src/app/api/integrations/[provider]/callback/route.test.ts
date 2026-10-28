import { PgDialect } from "drizzle-orm/pg-core";
import { SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route.saas";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  select: vi.fn(),
  join: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
  invalidate: vi.fn(),
  exchange: vi.fn(),
  saveCredential: vi.fn(),
}));

const stateSecret = "test-state-secret-long-enough-for-signing";
vi.mock("~/env", () => ({
  env: {
    APP_URL: "https://review.example.com",
    OAUTH_STATE_SECRET: "test-state-secret-long-enough-for-signing",
  },
}));
vi.mock("~/server/auth", () => ({ applicationAuth: mocks.auth }));
vi.mock("~/server/db", () => ({
  db: {
    select: mocks.select,
    insert: mocks.insert,
    update: mocks.update,
    transaction: mocks.transaction,
  },
}));
vi.mock("~/server/providers", () => ({ createProvider: vi.fn() }));
vi.mock("~/server/providers/credentials", () => ({
  invalidateGitHubInstallationToken: mocks.invalidate,
}));
vi.mock("~/server/providers/github-app-authorization", () => ({
  exchangeGitHubUserAuthorization: mocks.exchange,
  exchangeGitHubUserCode: mocks.exchange,
  githubAppJwt: vi.fn(),
  revokeGitHubUserToken: vi.fn(),
  verifyGitHubInstallationOwnership: vi.fn(),
}));
vi.mock("~/server/providers/user-credentials", () => ({
  saveUserProviderCredential: mocks.saveCredential,
}));
vi.mock("~/server/workspaces/access", () => ({
  requireWorkspaceAdministrator: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
}));
vi.mock("~/server/security/vault", () => ({
  openVaultSecret: vi.fn(),
  sealVaultSecret: vi.fn(),
}));

const connectionId = "12345678-1234-4123-8123-123456789012";

/** Calls the public callback handler using GitHub's actual setup-return path. */
function callback(query: string, provider = "github") {
  return GET(
    new Request(`https://review.example.com/${provider}/complete?${query}`),
    {
      params: Promise.resolve({ provider }),
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ userId: "reviewer" });
  mocks.select.mockReturnValue({
    from: () => ({ innerJoin: mocks.join }),
  });
  mocks.join.mockReturnValue({ where: mocks.where });
  mocks.where.mockReturnValue({ limit: mocks.limit });
  mocks.limit.mockResolvedValue([{ id: connectionId }]);
});

describe("GitHub installation-update return", () => {
  it("returns to the existing connection when GitHub sends no OAuth state", async () => {
    const response = await callback(
      "installation_id=151377122&setup_action=update",
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `https://review.example.com/settings/providers?connection=${connectionId}`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.saveCredential).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("scopes installation lookup to the caller's administrative memberships", async () => {
    await callback("installation_id=151377122&setup_action=update");
    const dialect = new PgDialect();
    const join = dialect.sqlToQuery(mocks.join.mock.calls[0]?.[1]);
    const predicate = dialect.sqlToQuery(mocks.where.mock.calls[0]?.[0]);
    expect(join.sql).toContain('"workspaceId"');
    expect(join.sql).toContain('"open_review_duck_provider_connection"');
    expect(join.sql).toContain('"open_review_duck_workspace_member"');
    expect(predicate.sql).toContain('"userId"');
    expect(predicate.sql).toContain('"role"');
    expect(predicate.sql).toContain('"installationId"');
    expect(predicate.params).toEqual(
      expect.arrayContaining([
        "reviewer",
        "owner",
        "admin",
        "github",
        "github_app",
        "151377122",
      ]),
    );
    expect(mocks.limit).toHaveBeenCalledWith(1);
  });

  it("returns to settings without exposing unknown or inaccessible installations", async () => {
    mocks.limit.mockResolvedValue([]);
    const response = await callback("installation_id=42&setup_action=update");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://review.example.com/settings/providers",
    );
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("ignores untrusted redirect destinations", async () => {
    const response = await callback(
      "installation_id=151377122&setup_action=update&redirectPath=https://attacker.example&returnTo=//attacker.example",
    );
    expect(response.headers.get("location")).toBe(
      `https://review.example.com/settings/providers?connection=${connectionId}`,
    );
  });

  it.each(["", "0", "-1", "not-an-id", "1.5", "123456789012345678901"])(
    "rejects malformed installation identifiers: %s",
    async (installationId) => {
      const response = await callback(
        `installation_id=${installationId}&setup_action=update`,
      );
      expect(response.status).toBe(400);
      expect(mocks.select).not.toHaveBeenCalled();
    },
  );

  it("requires an authenticated session before inspecting any connection", async () => {
    mocks.auth.mockResolvedValue({ userId: null });
    const response = await callback(
      "installation_id=151377122&setup_action=update",
    );
    expect(response.status).toBe(401);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it.each([
    "installation_id=42&setup_action=install",
    "installation_id=42",
    "installation_id=42&setup_action=update&code=oauth-code",
    "installation_id=42&setup_action=update&code=",
    "installation_id=42&setup_action=update&error=access_denied",
    "installation_id=42&setup_action=update&state=",
  ])(
    "keeps missing-state authorization requests invalid: %s",
    async (query) => {
      const response = await callback(query);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "OAuth state is missing",
      });
      expect(mocks.select).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it("does not bypass GitLab OAuth state validation", async () => {
    const response = await callback(
      "installation_id=42&setup_action=update",
      "gitlab",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "OAuth state is missing" });
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("does not turn invalid signed state into an installation-update return", async () => {
    const response = await callback(
      "installation_id=42&setup_action=update&state=invalid-token",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "OAuth state is invalid" });
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("keeps signed OAuth callbacks subject to one-time state consumption", async () => {
    const state = await new SignJWT({ provider: "github" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("reviewer")
      .setJti("state-id")
      .setIssuer("reviewduck")
      .setAudience("provider-oauth")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(stateSecret));
    mocks.update.mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    });
    const response = await callback(
      `installation_id=42&setup_action=update&state=${state}`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "OAuth state is expired or already used",
    });
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
});
