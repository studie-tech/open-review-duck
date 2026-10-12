import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  providerConnections,
  userProviderCredentials,
  users,
  workspaces,
} from "@/drizzle/schema";
import { db } from "~/server/db";
import { providerLifecycleForConnection } from "./provider-thread";

const remote = vi.hoisted(() => {
  /** Builds a provider whose merge rights belong to its authenticated actor. */
  const provider = (allowed: boolean) => ({
    getPullRequestLifecycle: vi.fn(async () => ({
      headSha: "reviewed-head",
      pullRequestState: "open",
      mergeable: true,
      canMerge: false,
      hasMergePermission: true,
      mergeBypassPermission: allowed ? "allowed" : "denied",
      canBypassMergeRequirements: allowed,
      checks: [],
      summary: "empty",
      mergeActionLabel: "Merge",
    })),
    getPullRequest: vi.fn(async () => ({
      headSha: "reviewed-head",
      baseSha: "reviewed-base",
    })),
    mergePullRequest: vi.fn(),
  });
  return {
    personal: provider(true),
    other: provider(false),
    app: provider(false),
  };
});
vi.mock("~/server/providers/credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/server/providers/credentials")>()),
  providerForConnection: vi.fn(async () => remote.app),
}));
vi.mock("~/server/providers", () => ({
  createProvider: (_provider: string, token: string) =>
    token === "personal-token" ? remote.personal : remote.other,
}));
vi.mock("~/server/security/vault", () => ({
  openVaultSecret: async (_context: unknown, value: string) => value,
}));

const ownerId = `merge-identity-owner-${randomUUID()}`;
const otherId = `merge-identity-other-${randomUUID()}`;
const unconnectedId = `merge-identity-unconnected-${randomUUID()}`;
let connection: typeof providerConnections.$inferSelect;
let otherConnection: typeof providerConnections.$inferSelect;

beforeAll(async () => {
  await db
    .insert(users)
    .values([ownerId, otherId, unconnectedId].map((id) => ({ id })));
  const [workspace] = await db
    .insert(workspaces)
    .values({
      ownerId,
      name: "Merge identity test",
      slug: `merge-identity-${randomUUID()}`,
    })
    .returning();
  if (!workspace) throw new Error("Test workspace was not created");
  const connections = await db
    .insert(providerConnections)
    .values([
      {
        workspaceId: workspace.id,
        provider: "github" as const,
        externalAccountId: randomUUID(),
        credentialKind: "github_app",
        credentialFingerprint: randomUUID(),
        displayName: "Shared installation",
        installationId: randomUUID(),
      },
      {
        workspaceId: workspace.id,
        provider: "github" as const,
        externalAccountId: randomUUID(),
        credentialKind: "github_app",
        credentialFingerprint: randomUUID(),
        displayName: "Other installation",
        installationId: randomUUID(),
      },
    ])
    .returning();
  const [first, second] = connections;
  if (!first || !second) throw new Error("Test connections were not created");
  connection = first;
  otherConnection = second;
  await db.insert(userProviderCredentials).values(
    [
      { userId: ownerId, encryptedAccessToken: "personal-token" },
      { userId: otherId, encryptedAccessToken: "other-token" },
    ].map((credential) => ({
      ...credential,
      connectionId: connection.id,
      provider: "github" as const,
      credentialKind: "pat",
      displayLogin: credential.userId,
      externalAccountId: randomUUID(),
    })),
  );
});
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  await db
    .delete(users)
    .where(inArray(users.id, [ownerId, otherId, unconnectedId]));
});

describe("GitHub App merge identity", () => {
  it("checks bypass with the connected reviewer and returns that same merge client", async () => {
    const selected = await providerLifecycleForConnection(
      db,
      connection,
      "42",
      12,
      ownerId,
    );
    expect(selected.lifecycle).toMatchObject({
      mergeBypassPermission: "allowed",
      canBypassMergeRequirements: true,
    });
    expect(selected.provider).toBe(remote.personal);
    expect(remote.app.getPullRequestLifecycle).not.toHaveBeenCalled();
    await selected.provider.mergePullRequest({
      repositoryExternalId: "42",
      pullRequestNumber: 12,
      headSha: "reviewed-head",
      bypassRequirements: true,
    });
    expect(remote.personal.mergePullRequest).toHaveBeenCalledOnce();
    expect(remote.app.mergePullRequest).not.toHaveBeenCalled();
  });

  it("does not borrow an admin reviewer's credential for another reviewer", async () => {
    const selected = await providerLifecycleForConnection(
      db,
      connection,
      "42",
      12,
      otherId,
    );
    expect(selected.lifecycle.mergeBypassPermission).toBe("denied");
    expect(selected.provider).toBe(remote.other);
    expect(remote.personal.getPullRequestLifecycle).not.toHaveBeenCalled();
  });

  it("falls back to the app only when the caller has no personal credential", async () => {
    const selected = await providerLifecycleForConnection(
      db,
      connection,
      "42",
      12,
      unconnectedId,
    );
    expect(selected.provider).toBe(remote.app);
    expect(selected.lifecycle.mergeBypassPermission).toBe("denied");
  });

  it("does not reuse a personal credential from a different connection", async () => {
    const selected = await providerLifecycleForConnection(
      db,
      otherConnection,
      "42",
      12,
      ownerId,
    );
    expect(selected.provider).toBe(remote.app);
    expect(remote.personal.getPullRequestLifecycle).not.toHaveBeenCalled();
  });

  it("does not silently fall back to the app when personal authorization fails", async () => {
    remote.personal.getPullRequestLifecycle.mockRejectedValueOnce(
      new Error("Expired personal token"),
    );
    await expect(
      providerLifecycleForConnection(db, connection, "42", 12, ownerId),
    ).rejects.toThrow("Expired personal token");
    expect(remote.app.getPullRequestLifecycle).not.toHaveBeenCalled();
  });
});
