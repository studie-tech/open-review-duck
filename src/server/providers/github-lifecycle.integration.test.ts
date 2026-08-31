import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  providerConnections,
  repositories,
  users,
  workspaces,
} from "@/drizzle/schema";
import { db } from "~/server/db";
import {
  applyGitHubLifecycleEvent,
  GITHUB_INSTALLATION_UNAVAILABLE,
  GITHUB_REPOSITORY_UNAVAILABLE,
} from "./github-lifecycle";

const fixture = {
  userId: `github-lifecycle-${randomUUID()}`,
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  repositoryId: randomUUID(),
  otherRepositoryId: randomUUID(),
  installationId: String(Date.now()),
  externalRepositoryId: String(Date.now() + 1),
};

beforeAll(async () => {
  await db.insert(users).values({ id: fixture.userId });
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    ownerId: fixture.userId,
    name: "GitHub lifecycle workspace",
    slug: `github-lifecycle-${randomUUID()}`,
  });
  await db.insert(providerConnections).values({
    id: fixture.connectionId,
    workspaceId: fixture.workspaceId,
    provider: "github",
    externalAccountId: fixture.installationId,
    credentialKind: "github_app",
    credentialFingerprint: randomUUID(),
    displayName: "GitHub lifecycle installation",
    installationId: fixture.installationId,
  });
  await db.insert(repositories).values([
    {
      id: fixture.repositoryId,
      workspaceId: fixture.workspaceId,
      connectionId: fixture.connectionId,
      externalId: fixture.externalRepositoryId,
      owner: "reviewduck",
      name: "lifecycle",
      defaultBranch: "main",
      webUrl: "https://github.com/reviewduck/lifecycle",
      reviewIntakeMode: "all",
    },
    {
      id: fixture.otherRepositoryId,
      workspaceId: fixture.workspaceId,
      connectionId: fixture.connectionId,
      externalId: String(Date.now() + 2),
      owner: "reviewduck",
      name: "other",
      defaultBranch: "main",
      webUrl: "https://github.com/reviewduck/other",
      reviewIntakeMode: "all",
    },
  ]);
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
});

describe("GitHub App lifecycle handling", () => {
  it("ignores non-authorization installation actions", async () => {
    await expect(
      applyGitHubLifecycleEvent(db, "installation", {
        action: "created",
        installation: { id: fixture.installationId },
      }),
    ).resolves.toBe(false);
  });

  it("accepts new installation permissions so the next token can include them", async () => {
    await expect(
      applyGitHubLifecycleEvent(db, "installation", {
        action: "new_permissions_accepted",
        installation: { id: fixture.installationId },
      }),
    ).resolves.toBe(true);
  });

  it("disables a suspended installation and fails automatic intake closed", async () => {
    await expect(
      applyGitHubLifecycleEvent(db, "installation", {
        action: "suspend",
        installation: { id: fixture.installationId },
      }),
    ).resolves.toBe(true);

    await expect(
      db.query.providerConnections.findFirst({
        where: eq(providerConnections.id, fixture.connectionId),
      }),
    ).resolves.toMatchObject({ credentialStatus: "suspended" });
    await expect(
      db.query.repositories.findFirst({
        where: eq(repositories.id, fixture.repositoryId),
      }),
    ).resolves.toMatchObject({
      reviewIntakeMode: "manual",
      intakeLastError: GITHUB_INSTALLATION_UNAVAILABLE,
    });
  });

  it("reactivates authorization without silently restoring automatic intake", async () => {
    await expect(
      applyGitHubLifecycleEvent(db, "installation", {
        action: "unsuspend",
        installation: { id: fixture.installationId },
      }),
    ).resolves.toBe(true);
    await expect(
      db.query.providerConnections.findFirst({
        where: eq(providerConnections.id, fixture.connectionId),
      }),
    ).resolves.toMatchObject({ credentialStatus: "active" });
    await expect(
      db.query.repositories.findFirst({
        where: eq(repositories.id, fixture.repositoryId),
      }),
    ).resolves.toMatchObject({
      reviewIntakeMode: "manual",
      intakeLastError: null,
    });
  });

  it("disables only repositories removed from the installation", async () => {
    await db
      .update(repositories)
      .set({ reviewIntakeMode: "all", intakeLastError: null })
      .where(eq(repositories.connectionId, fixture.connectionId));
    await expect(
      applyGitHubLifecycleEvent(db, "installation_repositories", {
        action: "removed",
        installation: { id: fixture.installationId },
        repositories_removed: [{ id: fixture.externalRepositoryId }],
      }),
    ).resolves.toBe(true);
    await expect(
      db.query.repositories.findFirst({
        where: eq(repositories.id, fixture.repositoryId),
      }),
    ).resolves.toMatchObject({
      reviewIntakeMode: "manual",
      intakeLastError: GITHUB_REPOSITORY_UNAVAILABLE,
    });
    await expect(
      db.query.repositories.findFirst({
        where: eq(repositories.id, fixture.otherRepositoryId),
      }),
    ).resolves.toMatchObject({
      reviewIntakeMode: "all",
      intakeLastError: null,
    });
  });
});
