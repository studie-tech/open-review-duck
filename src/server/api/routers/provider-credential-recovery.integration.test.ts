import { createHash, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { localCredentials, providerConnections, users } from "@/drizzle/schema";
import { createCaller } from "~/server/api/root";
import { db } from "~/server/db";
import { openVaultSecret } from "~/server/security/vault";
import { ensurePersonalWorkspace } from "~/server/workspaces/service";

vi.mock("~/server/providers", () => ({
  createProvider: () => ({
    getConnectionIdentity: async () => ({
      externalAccountId: "credential-recovery-account",
      displayName: "Credential recovery account",
    }),
  }),
}));

const reviewerIds: string[] = [];

/** Creates an isolated local reviewer so each test owns one workspace. */
async function localReviewer() {
  const userId = `credential-recovery-${randomUUID()}`;
  reviewerIds.push(userId);
  const workspace = await ensurePersonalWorkspace(db, userId);
  return {
    workspaceId: workspace.id,
    caller: createCaller({
      auth: { userId, has: () => false },
      db,
      headers: new Headers(),
    }),
  };
}

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, reviewerIds));
});

describe("local provider credential recovery", () => {
  it("recovers a connection with a token an earlier disconnect abandoned", async () => {
    const { caller, workspaceId } = await localReviewer();
    const abandoned = await caller.provider.connect({
      provider: "github",
      accessToken: "recovery-abandoned-token",
      displayName: "Abandoned",
    });
    await caller.provider.disconnect({ connectionId: abandoned.id });
    const replacement = await caller.provider.connect({
      provider: "github",
      accessToken: "recovery-replacement-token",
      displayName: "Replacement",
    });

    await expect(
      caller.provider.connect({
        connectionId: replacement.id,
        provider: "github",
        accessToken: "recovery-abandoned-token",
        displayName: "Recovered",
      }),
    ).resolves.toMatchObject({
      id: replacement.id,
      displayName: "Recovered",
    });

    const stored = await db.query.localCredentials.findMany({
      where: eq(localCredentials.workspaceId, workspaceId),
    });
    expect(stored).toHaveLength(1);
    const credential = stored[0];
    if (!credential) throw new Error("Recovered credential was not stored");
    await expect(
      db.query.providerConnections.findFirst({
        where: eq(providerConnections.id, replacement.id),
      }),
    ).resolves.toMatchObject({
      localCredentialId: credential.id,
      credentialFingerprint: credential.fingerprint,
    });
    await expect(
      openVaultSecret(
        { workspaceId, recordId: credential.id, provider: "github" },
        credential.encryptedPayload,
      ),
    ).resolves.toBe(JSON.stringify({ token: "recovery-abandoned-token" }));
  });

  it("keeps a credential another connection still holds", async () => {
    const { caller, workspaceId } = await localReviewer();
    const recovering = await caller.provider.connect({
      provider: "github",
      accessToken: "recovery-own-token",
      displayName: "Own",
    });
    // Stands in for a sibling connection that claims the fingerprint after the
    // pre-transaction guard has already read the connections: the credential is
    // no orphan, so recovery must refuse it rather than delete it.
    const siblingCredentialId = randomUUID();
    await db.insert(localCredentials).values({
      id: siblingCredentialId,
      workspaceId,
      kind: "github_pat",
      label: "Sibling",
      encryptedPayload: "sealed-elsewhere",
      fingerprint: createHash("sha256")
        .update(`${workspaceId}\0github\0\0recovery-sibling-token`)
        .digest("hex"),
    });
    await db.insert(providerConnections).values({
      workspaceId,
      provider: "github",
      externalAccountId: "sibling-account",
      credentialKind: "local_pat",
      displayName: "Sibling",
      localCredentialId: siblingCredentialId,
    });

    await expect(
      caller.provider.connect({
        connectionId: recovering.id,
        provider: "github",
        accessToken: "recovery-sibling-token",
        displayName: "Contending",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      db.query.localCredentials.findFirst({
        where: eq(localCredentials.id, siblingCredentialId),
      }),
    ).resolves.toMatchObject({ label: "Sibling" });
  });
});
