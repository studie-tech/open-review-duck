import { randomUUID } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  providerConnections,
  rateLimits,
  repositories,
  semanticUploadCredentials,
  users,
  workspaces,
} from "@/drizzle/schema";
import { db } from "~/server/db";
import {
  authorizeSemanticUploadCredential,
  newSemanticUploadCredential,
} from "./upload-credentials";

const fixture = {
  userId: `scip-upload-${randomUUID()}`,
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  repositoryId: randomUUID(),
};

beforeAll(async () => {
  await db.insert(users).values({ id: fixture.userId });
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    ownerId: fixture.userId,
    name: "Semantic upload workspace",
    slug: `scip-upload-${randomUUID()}`,
  });
  await db.insert(providerConnections).values({
    id: fixture.connectionId,
    workspaceId: fixture.workspaceId,
    provider: "github",
    externalAccountId: `scip-upload-${randomUUID()}`,
    displayName: "Semantic upload connection",
  });
  await db.insert(repositories).values({
    id: fixture.repositoryId,
    workspaceId: fixture.workspaceId,
    connectionId: fixture.connectionId,
    externalId: `repository-${randomUUID()}`,
    owner: "reviewduck",
    name: "scip-upload",
    defaultBranch: "main",
    webUrl: "https://github.com/reviewduck/scip-upload",
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
  await db
    .delete(rateLimits)
    .where(eq(rateLimits.key, `scip-upload:${fixture.repositoryId}`));
});

describe("semantic upload authorization", () => {
  it("rejects a real window overflow through authorizeSemanticUploadCredential", async () => {
    const { id, token } = newSemanticUploadCredential();
    await db.insert(semanticUploadCredentials).values({
      id,
      repositoryId: fixture.repositoryId,
      label: "integration",
      tokenHash: await hash(token, {
        algorithm: 2,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      }),
    });
    await db.insert(rateLimits).values({
      key: `scip-upload:${fixture.repositoryId}`,
      count: 30,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      authorizeSemanticUploadCredential(db, fixture.repositoryId, token),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});
