import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  providerConnections,
  repositories,
  syncRuns,
  users,
  workflowRuns,
  workspaces,
} from "@/drizzle/schema";
import { db } from "~/server/db";
import { ensureWorkflowRunLink } from "./run-link";

const fixture = {
  userId: `workflow-integration-${randomUUID()}`,
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  repositoryId: randomUUID(),
  syncId: randomUUID(),
  providerRunId: `wrun_${randomUUID()}`,
};

beforeAll(async () => {
  await db.insert(users).values({ id: fixture.userId });
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    ownerId: fixture.userId,
    name: "Workflow integration workspace",
    slug: `workflow-integration-${randomUUID()}`,
  });
  await db.insert(providerConnections).values({
    id: fixture.connectionId,
    workspaceId: fixture.workspaceId,
    provider: "github",
    externalAccountId: "workflow-integration-account",
    displayName: "Workflow integration connection",
  });
  await db.insert(repositories).values({
    id: fixture.repositoryId,
    workspaceId: fixture.workspaceId,
    connectionId: fixture.connectionId,
    externalId: `workflow-repository-${randomUUID()}`,
    owner: "reviewduck",
    name: "workflow-integration",
    defaultBranch: "main",
    webUrl: "https://github.com/reviewduck/workflow-integration",
  });
  await db.insert(syncRuns).values({
    id: fixture.syncId,
    workspaceId: fixture.workspaceId,
    repositoryId: fixture.repositoryId,
    pullRequestNumber: 1,
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
});

describe("durable workflow links", () => {
  it("self-links a committed target exactly once under concurrent repair", async () => {
    const links = await Promise.all(
      Array.from({ length: 6 }, () =>
        ensureWorkflowRunLink(db, {
          kind: "sync_pull_request",
          targetId: fixture.syncId,
          providerRunId: fixture.providerRunId,
        }),
      ),
    );

    expect(new Set(links.map(({ id }) => id)).size).toBe(1);
    const persisted = await db.query.workflowRuns.findMany({
      where: and(
        eq(workflowRuns.kind, "sync_pull_request"),
        eq(workflowRuns.targetId, fixture.syncId),
      ),
    });
    expect(persisted).toHaveLength(1);
    await expect(
      db.query.syncRuns.findFirst({ where: eq(syncRuns.id, fixture.syncId) }),
    ).resolves.toMatchObject({ workflowRunId: persisted[0]?.id });
  });

  it("refuses to replace a target's established durable run", async () => {
    await expect(
      ensureWorkflowRunLink(db, {
        kind: "sync_pull_request",
        targetId: fixture.syncId,
        providerRunId: `wrun_${randomUUID()}`,
      }),
    ).rejects.toThrow("already linked to another run");
  });
});
