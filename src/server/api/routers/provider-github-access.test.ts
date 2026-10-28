import { TRPCError } from "@trpc/server";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCallerFactory } from "~/server/api/trpc";
import type { db as database } from "~/server/db";
import { providerForConnection } from "~/server/providers/credentials";
import {
  githubAppJwt,
  githubInstallationSettingsUrl,
} from "~/server/providers/github-app-authorization";
import { requirePersonalWorkspaceAdministrator } from "~/server/workspaces/access";
import { providerRouter } from "./provider";

vi.mock("~/server/providers/github-app-authorization", () => ({
  githubAppJwt: vi.fn(),
  githubInstallationSettingsUrl: vi.fn(),
}));
vi.mock("~/server/providers/credentials", () => ({
  providerForConnection: vi.fn(),
}));
vi.mock("~/server/workspaces/access", () => ({
  requirePersonalWorkspaceAdministrator: vi.fn(),
}));

const connection = {
  id: "22222222-2222-4222-8222-222222222222",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  provider: "github",
  credentialKind: "github_app",
  credentialStatus: "active",
  installationId: "42",
};

/** Creates a scoped connection lookup without touching a developer database. */
function fixture(savedConnection: unknown = connection) {
  const findFirst = vi.fn().mockResolvedValue(savedConnection);
  const db = {
    query: { providerConnections: { findFirst } },
  } as unknown as typeof database;
  const caller = createCallerFactory(providerRouter)({
    db,
    auth: { userId: "owner", has: () => false },
    headers: new Headers(),
  });
  return { caller, db, findFirst };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requirePersonalWorkspaceAdministrator).mockResolvedValue({
    id: connection.workspaceId,
  } as never);
  vi.mocked(githubAppJwt).mockResolvedValue("app-jwt");
  vi.mocked(githubInstallationSettingsUrl).mockResolvedValue(
    "https://github.com/organizations/acme/settings/installations/42",
  );
});

describe("provider GitHub installation settings", () => {
  it("returns only the settings URL for the caller's selected connection", async () => {
    const { caller, db, findFirst } = fixture();
    await expect(
      caller.githubInstallationSettings({ connectionId: connection.id }),
    ).resolves.toEqual({
      url: "https://github.com/organizations/acme/settings/installations/42",
    });
    expect(requirePersonalWorkspaceAdministrator).toHaveBeenCalledWith(
      db,
      "owner",
    );
    const predicate = findFirst.mock.calls[0]?.[0]?.where;
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).toContain(
      '"open_review_duck_provider_connection"."workspaceId"',
    );
    expect(query.sql).toContain('"open_review_duck_provider_connection"."id"');
    expect(query.params).toEqual([connection.id, connection.workspaceId]);
    expect(githubInstallationSettingsUrl).toHaveBeenCalledWith("42", "app-jwt");
  });

  it("rejects non-administrators before looking up GitHub settings", async () => {
    vi.mocked(requirePersonalWorkspaceAdministrator).mockRejectedValue(
      new TRPCError({ code: "FORBIDDEN" }),
    );
    const { caller, findFirst } = fixture();
    await expect(
      caller.githubInstallationSettings({ connectionId: connection.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(findFirst).not.toHaveBeenCalled();
    expect(githubAppJwt).not.toHaveBeenCalled();
  });

  it("rejects a connection outside the caller's workspace", async () => {
    const { caller } = fixture(null);
    await expect(
      caller.githubInstallationSettings({ connectionId: connection.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(githubAppJwt).not.toHaveBeenCalled();
  });

  it.each([
    { credentialKind: "pat" },
    { provider: "gitlab" },
    { installationId: null },
  ])(
    "rejects connections without a GitHub installation: %o",
    async (overrides) => {
      const { caller } = fixture({ ...connection, ...overrides });
      await expect(
        caller.githubInstallationSettings({ connectionId: connection.id }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(githubAppJwt).not.toHaveBeenCalled();
    },
  );

  it("returns an actionable error if GitHub settings cannot be loaded", async () => {
    vi.mocked(githubInstallationSettingsUrl).mockRejectedValue(
      new Error("upstream failure"),
    );
    const { caller } = fixture();
    await expect(
      caller.githubInstallationSettings({ connectionId: connection.id }),
    ).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: "Could not load GitHub access settings. Try again.",
    });
  });

  it("refreshes the installation token so newly granted repositories are visible", async () => {
    const repositories = [
      { externalId: "new-repo", owner: "acme", name: "new" },
    ];
    const listRepositories = vi.fn().mockResolvedValue(repositories);
    vi.mocked(providerForConnection).mockResolvedValue({
      listRepositories,
    } as never);
    const { caller, db } = fixture();
    await expect(
      caller.listAvailableRepositories({ connectionId: connection.id }),
    ).resolves.toEqual(repositories);
    expect(providerForConnection).toHaveBeenCalledWith(db, connection, {
      refreshInstallation: true,
    });
  });
});
