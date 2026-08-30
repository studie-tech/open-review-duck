import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  providerConnections,
  pullRequests,
  repositories,
  users,
  workspaceMembers,
  workspaces,
} from "@/drizzle/schema";
import { db } from "~/server/db";
import { createAiJob } from "./service";

const fixture = {
  memberId: `job-scope-${randomUUID()}`,
  outsiderId: `job-scope-${randomUUID()}`,
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  repositoryId: randomUUID(),
  pullRequestId: randomUUID(),
};

beforeAll(async () => {
  await db
    .insert(users)
    .values([{ id: fixture.memberId }, { id: fixture.outsiderId }]);
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    ownerId: fixture.memberId,
    name: "Job scope integration workspace",
    slug: `integration-${randomUUID()}`,
  });
  await db.insert(workspaceMembers).values({
    workspaceId: fixture.workspaceId,
    userId: fixture.memberId,
    role: "owner",
  });
  await db.insert(providerConnections).values({
    id: fixture.connectionId,
    workspaceId: fixture.workspaceId,
    provider: "github",
    externalAccountId: `integration-${randomUUID()}`,
    displayName: "Integration connection",
  });
  await db.insert(repositories).values({
    id: fixture.repositoryId,
    workspaceId: fixture.workspaceId,
    connectionId: fixture.connectionId,
    externalId: `repository-${randomUUID()}`,
    owner: "reviewduck",
    name: "job-scope",
    defaultBranch: "main",
    webUrl: "https://github.com/reviewduck/job-scope",
  });
  await db.insert(pullRequests).values({
    id: fixture.pullRequestId,
    repositoryId: fixture.repositoryId,
    externalId: `pull-request-${randomUUID()}`,
    number: 1,
    title: "Job scope",
    authorLogin: "reviewduck",
    sourceBranch: "feature",
    targetBranch: "main",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    webUrl: "https://github.com/reviewduck/job-scope/pull/1",
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.memberId));
  await db.delete(users).where(eq(users.id, fixture.outsiderId));
});

describe("job scope resolution", () => {
  it("tells a non-member the pull request is missing, never that it lacks a snapshot", async () => {
    await expect(
      createAiJob(db, {
        pullRequestId: fixture.pullRequestId,
        kind: "explain",
        userId: fixture.outsiderId,
        subscribed: false,
      }),
    ).rejects.toThrow("Pull request not found");
  });

  it("reports the missing snapshot to a member", async () => {
    await expect(
      createAiJob(db, {
        pullRequestId: fixture.pullRequestId,
        kind: "explain",
        userId: fixture.memberId,
        subscribed: false,
      }),
    ).rejects.toThrow("No review snapshot found");
  });
});
