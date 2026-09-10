import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { managedAiCredentials, users, workspaces } from "@/drizzle/schema";
import { db } from "~/server/db";
import { revokeOpenRouterWorkspaceKeysForBillingPayer } from "./openrouter-keys";

const fixture = {
  userId: `openrouter-revoke-${randomUUID()}`,
  workspaceId: randomUUID(),
  credentialId: randomUUID(),
};

beforeAll(async () => {
  await db.insert(users).values({ id: fixture.userId });
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    ownerId: fixture.userId,
    name: "OpenRouter revoke workspace",
    slug: `openrouter-revoke-${randomUUID()}`,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
});

describe("OpenRouter workspace key revocation", () => {
  it("deletes the credential after a successful provider revoke and is idle on retry", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await db.insert(managedAiCredentials).values({
      id: fixture.credentialId,
      workspaceId: fixture.workspaceId,
      provider: "openrouter",
      providerKeyId: "hash-abc",
      encryptedCredential: "dummy",
      monthlyLimitMicroUsd: 0,
    });

    await expect(
      revokeOpenRouterWorkspaceKeysForBillingPayer(db, {
        user_id: fixture.userId,
      }),
    ).resolves.toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://openrouter.ai/api/v1/keys/hash-abc",
    );
    await expect(
      db.query.managedAiCredentials.findFirst({
        where: eq(managedAiCredentials.id, fixture.credentialId),
      }),
    ).resolves.toBeUndefined();

    await expect(
      revokeOpenRouterWorkspaceKeysForBillingPayer(db, {
        user_id: fixture.userId,
      }),
    ).resolves.toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("deletes the row when the provider already reports the key gone", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const credentialId = randomUUID();
    await db.insert(managedAiCredentials).values({
      id: credentialId,
      workspaceId: fixture.workspaceId,
      provider: "openrouter",
      providerKeyId: "hash-missing",
      encryptedCredential: "dummy",
      monthlyLimitMicroUsd: 0,
    });

    await expect(
      revokeOpenRouterWorkspaceKeysForBillingPayer(db, {
        user_id: fixture.userId,
      }),
    ).resolves.toBe(1);
    await expect(
      db.query.managedAiCredentials.findFirst({
        where: eq(managedAiCredentials.id, credentialId),
      }),
    ).resolves.toBeUndefined();
  });
});
