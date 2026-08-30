import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aiJobs,
  providerConnections,
  pullRequests,
  repositories,
  reviewSnapshots,
  reviewUnits,
  users,
  workspaceMembers,
  workspaces,
} from "@/drizzle/schema";
import { createCallerFactory } from "~/server/api/trpc";
import { CURRENT_AI_AGENT_VERSION } from "~/server/ai/service";
import { db } from "~/server/db";
import { reviewRouter } from "./review";

const fixture = {
  userId: `integration-${randomUUID()}`,
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  repositoryId: randomUUID(),
  pullRequestId: randomUUID(),
  snapshotId: randomUUID(),
  functionUnitId: randomUUID(),
  fileUnitId: randomUUID(),
  jobId: randomUUID(),
};

const path = "src/discussed.ts";

/** Builds one review unit of the snapshot covering the given line span. */
function unit(
  id: string,
  kind: "function" | "file",
  startLine: number,
  endLine: number,
  order: number,
) {
  return {
    id,
    snapshotId: fixture.snapshotId,
    stableKey: `unit-${order}`,
    path,
    language: "typescript",
    kind,
    name: `unit${order}`,
    startLine,
    endLine,
    contentHash: "c".repeat(64),
    semanticHash: "d".repeat(64),
    reviewOrder: order,
  };
}

/** Builds one finding of the run's result payload. */
function finding(title: string, line: number, findingPath = path) {
  return {
    severity: "warning" as const,
    title,
    body: `${title} body`,
    path: findingPath,
    line,
  };
}

const createCaller = createCallerFactory(reviewRouter);

beforeAll(async () => {
  await db.insert(users).values({ id: fixture.userId });
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    ownerId: fixture.userId,
    name: "Unit discussion integration workspace",
    slug: `integration-${randomUUID()}`,
  });
  await db.insert(workspaceMembers).values({
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
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
    name: "unit-discussion",
    defaultBranch: "main",
    webUrl: "https://github.com/reviewduck/unit-discussion",
  });
  await db.insert(pullRequests).values({
    id: fixture.pullRequestId,
    repositoryId: fixture.repositoryId,
    externalId: `pull-request-${randomUUID()}`,
    number: 1,
    title: "Unit discussion",
    authorLogin: "reviewduck",
    sourceBranch: "feature",
    targetBranch: "main",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    webUrl: "https://github.com/reviewduck/unit-discussion/pull/1",
  });
  await db.insert(reviewSnapshots).values({
    id: fixture.snapshotId,
    pullRequestId: fixture.pullRequestId,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    version: 1,
  });
  await db
    .insert(reviewUnits)
    .values([
      unit(fixture.functionUnitId, "function", 10, 20, 1),
      unit(fixture.fileUnitId, "file", 1, 100, 2),
    ]);
  await db.insert(aiJobs).values({
    id: fixture.jobId,
    workspaceId: fixture.workspaceId,
    pullRequestId: fixture.pullRequestId,
    snapshotId: fixture.snapshotId,
    userId: fixture.userId,
    kind: "review",
    status: "completed",
    agentVersion: CURRENT_AI_AGENT_VERSION,
    result: {
      summary: "Run summary",
      annotations: [
        { title: "Annotation", body: "Annotation body", path, line: 15 },
      ],
      commentProposals: [{ body: "Proposal", path, line: 15 }],
      concepts: [
        {
          title: "Concept",
          rationale: "Concept rationale",
          memberUnitIds: [fixture.functionUnitId],
        },
      ],
      findings: [
        finding("Outside the file", 15, "src/other.ts"),
        finding("Inside the function", 15),
        finding("Outside the function", 60),
      ],
    },
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
});

describe("unit discussion findings", () => {
  it("keeps each finding on the tightest unit that contains its line", async () => {
    const caller = createCaller({
      db,
      auth: { userId: fixture.userId, has: () => true },
      headers: new Headers(),
    });

    const inFunction = await caller.unitDiscussion({
      unitId: fixture.functionUnitId,
    });
    const inFile = await caller.unitDiscussion({ unitId: fixture.fileUnitId });

    expect(inFunction.findings).toEqual([
      expect.objectContaining({
        title: "Inside the function",
        index: 1,
        aiJobId: fixture.jobId,
      }),
    ]);
    expect(inFile.findings).toEqual([
      expect.objectContaining({
        title: "Outside the function",
        index: 2,
        aiJobId: fixture.jobId,
      }),
    ]);
  });
});
