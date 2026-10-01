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

const mocks = vi.hoisted(() => ({
  local: true,
  start: vi.fn(async () => ({ runId: "test" })),
}));
vi.mock("~/server/deployment", () => ({
  isLocalDeployment: () => mocks.local,
}));
vi.mock("workflow/api", () => ({ start: mocks.start }));

import {
  aiJobs,
  aiReviewFindings,
  aiReviewItems,
  evalCases,
  evalResults,
  localAiConfigurations,
  providerConnections,
  pullRequests,
  repositories,
  reviewSnapshots,
  snapshotFiles,
  users,
  workspaceMembers,
} from "@/drizzle/schema";
import type { EvalCase } from "~/lib/evaluations";
import { createCallerFactory } from "~/server/api/trpc";
import { db } from "~/server/db";
import { failEvaluationRun } from "~/server/evaluations/execute";
import { sealEval } from "~/server/evaluations/store";
import { sealVaultSecret } from "~/server/security/vault";
import { persistSourceBlob } from "~/server/storage/source-blobs";
import { evaluationsRouter } from "./evaluations";

const userId = `eval-test-${randomUUID()}`;
const otherUserId = `eval-test-${randomUUID()}`;
const createCaller = createCallerFactory(evaluationsRouter);
/** Creates a real database caller with a chosen identity. */
function caller(id: string | null = userId) {
  return createCaller({
    db,
    auth: { userId: id, has: () => true },
    headers: new Headers(),
  });
}
const example: EvalCase = {
  title: "Null user",
  path: "src/auth.ts",
  source: "return user.name",
  previousSource: "",
  finding: "Null users crash",
  existingCode: "user.name",
  label: "bug",
  rationale: "No guard",
  split: "development",
};
let datasetId: string;
let workspaceId: string;
beforeAll(async () => {
  await db.insert(users).values([{ id: userId }, { id: otherUserId }]);
  const dataset = await caller().create({ name: "Evaluation test" });
  await caller(otherUserId).list();
  await db.update(users).set({ isAdmin: false }).where(eq(users.id, userId));
  datasetId = dataset.id;
  workspaceId = dataset.workspaceId;
  await db.insert(localAiConfigurations).values({
    workspaceId,
    provider: "openai_compatible",
    model: "fixture",
    encryptedConfiguration: "unused fixture",
  });
});
afterEach(() => {
  mocks.local = true;
});
afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(users).where(eq(users.id, otherUserId));
});

describe("evaluation authorization and lifecycle", () => {
  it("requires authentication and denies SaaS workspace owners without platform admin", async () => {
    await expect(caller(null).list()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    mocks.local = false;
    expect(await caller().access()).toEqual({ allowed: false });
    await expect(caller().list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller().create({ name: "Blocked" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));
    expect(await caller().access()).toEqual({ allowed: true });
    await expect(caller().list()).resolves.toHaveLength(1);
    await db.update(users).set({ isAdmin: false }).where(eq(users.id, userId));
    mocks.local = true;
  });
  it("allows non-admin local users while denying another workspace's dataset", async () => {
    await db
      .update(workspaceMembers)
      .set({ role: "member" })
      .where(eq(workspaceMembers.userId, userId));
    await db.update(users).set({ isAdmin: false }).where(eq(users.id, userId));
    expect(await caller().access()).toEqual({ allowed: true });
    await expect(
      caller(otherUserId).detail({ datasetId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller(otherUserId).saveCase({ datasetId, example }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller(otherUserId).startRun({
        datasetId,
        name: "Attack",
        mode: "discovery",
        split: "development",
        prompt: "x",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("encrypts cases, excludes unlabeled and holdout data, and preserves run history", async () => {
    const saved = await caller().saveCase({ datasetId, example });
    await caller().saveCase({
      datasetId,
      example: { ...example, label: "unlabeled" },
    });
    await caller().saveCase({
      datasetId,
      example: { ...example, split: "holdout" },
    });
    const stored = await db.query.evalCases.findFirst({
      where: eq(evalCases.id, saved.id),
    });
    expect(stored?.encryptedContent).not.toContain(example.source);
    const run = await caller().startRun({
      datasetId,
      name: "Baseline",
      mode: "discovery",
      split: "development",
      prompt: "Frozen prompt",
    });
    expect(mocks.start).toHaveBeenCalled();
    await expect(
      caller().startRun({
        datasetId,
        name: "Duplicate",
        mode: "discovery",
        split: "development",
        prompt: "x",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await caller().saveCase({
      datasetId,
      id: saved.id,
      example: { ...example, label: "false_positive", source: "edited" },
    });
    const resultId = randomUUID();
    await db.insert(evalResults).values({
      id: resultId,
      runId: run.id,
      caseId: saved.id,
      encryptedOutput: await sealEval(workspaceId, resultId, {
        prediction: "ungraded",
        output: "Possible defect",
        inputTokens: 3,
        outputTokens: 2,
      }),
    });
    let captured = await caller().run({ datasetId, runId: run.id });
    expect(captured.cases).toHaveLength(1);
    expect(captured.cases[0]).not.toHaveProperty("source");
    expect(captured.snapshot).not.toHaveProperty("cases");
    expect(
      await caller().runCase({ datasetId, runId: run.id, id: saved.id }),
    ).toMatchObject(example);
    expect((await caller().detail({ datasetId })).cases[0]).not.toHaveProperty(
      "source",
    );
    await expect(
      caller(otherUserId).case({ datasetId, id: saved.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller(otherUserId).runCase({ datasetId, runId: run.id, id: saved.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      captured.snapshot.prompts["deep_review.scout.system_repository"],
    ).toBe("Frozen prompt");
    expect(captured.metrics.graded).toBe(0);
    await caller().grade({
      datasetId,
      runId: run.id,
      resultId,
      prediction: "report",
    });
    captured = await caller().run({ datasetId, runId: run.id });
    expect(captured.metrics).toMatchObject({ tp: 1, recall: 1 });
    await caller().deleteCase({ datasetId, id: saved.id });
    expect(
      (await caller().runCase({ datasetId, runId: run.id, id: saved.id }))
        .source,
    ).toBe(example.source);
    await failEvaluationRun(run.id);
    expect((await caller().run({ datasetId, runId: run.id })).status).toBe(
      "failed",
    );
    const next = await caller().startRun({
      datasetId,
      name: "After failure",
      mode: "discovery",
      split: "holdout",
      prompt: "Frozen prompt",
    });
    await caller().cancel({ datasetId, runId: next.id });
    await failEvaluationRun(next.id);
    expect((await caller().run({ datasetId, runId: next.id })).status).toBe(
      "cancelled",
    );
    expect((await caller().run({ datasetId, runId: run.id })).status).toBe(
      "failed",
    );
    await expect(
      caller(otherUserId).run({ datasetId, runId: run.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("captures original source and finding text without trusting AI verdicts", async () => {
    const connectionId = randomUUID(),
      repositoryId = randomUUID(),
      pullRequestId = randomUUID(),
      snapshotId = randomUUID(),
      parentJobId = randomUUID(),
      childJobId = randomUUID(),
      itemId = randomUUID(),
      findingId = randomUUID();
    await db.insert(providerConnections).values({
      id: connectionId,
      workspaceId,
      provider: "github",
      externalAccountId: randomUUID(),
      displayName: "Capture fixture",
    });
    await db.insert(repositories).values({
      id: repositoryId,
      workspaceId,
      connectionId,
      externalId: randomUUID(),
      owner: "fixture",
      name: "capture",
      defaultBranch: "main",
      webUrl: "https://github.com/fixture/capture",
    });
    await db.insert(pullRequests).values({
      id: pullRequestId,
      repositoryId,
      externalId: randomUUID(),
      number: 1,
      title: "Capture test",
      authorLogin: "fixture",
      sourceBranch: "fix",
      targetBranch: "main",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      webUrl: "https://github.com/fixture/capture/pull/1",
    });
    await db.insert(reviewSnapshots).values({
      id: snapshotId,
      pullRequestId,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      version: 1,
    });
    const blob = await persistSourceBlob(db, {
      workspaceId,
      bytes: new TextEncoder().encode(example.source),
    });
    await db.insert(snapshotFiles).values({
      snapshotId,
      path: example.path,
      language: "typescript",
      changeType: "modified",
      currentBlobId: blob.id,
    });
    const job = {
      workspaceId,
      pullRequestId,
      snapshotId,
      userId,
      status: "completed" as const,
    };
    await db.insert(aiJobs).values([
      { ...job, id: parentJobId, kind: "review" },
      { ...job, id: childJobId, kind: "review_file", parentJobId },
    ]);
    await db.insert(aiReviewItems).values({
      id: itemId,
      parentJobId,
      childJobId,
      workspaceId,
      path: example.path,
      changeType: "modified",
      fingerprint: "c".repeat(64),
    });
    await db.insert(aiReviewFindings).values({
      id: findingId,
      jobId: childJobId,
      itemId,
      workspaceId,
      path: example.path,
      severity: "high",
      category: "bug",
      state: "refuted",
      encryptedContent: await sealVaultSecret(
        { workspaceId, recordId: findingId, provider: "ai-review-finding" },
        JSON.stringify({
          title: example.title,
          body: example.finding,
          existingCode: example.existingCode,
        }),
      ),
    });
    const captured = await caller().finding({ findingId });
    expect(captured).toMatchObject({
      source: example.source,
      finding: example.finding,
      label: "unlabeled",
      sourceFindingId: findingId,
    });
    await expect(
      caller(otherUserId).finding({ findingId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const saved = await caller().saveCase({ datasetId, example: captured });
    await db
      .update(snapshotFiles)
      .set({ currentBlobId: null, previousBlobId: null })
      .where(eq(snapshotFiles.snapshotId, snapshotId));
    await expect(caller().finding({ findingId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Original source"),
    });
    await db.delete(pullRequests).where(eq(pullRequests.id, pullRequestId));
    expect((await caller().case({ datasetId, id: saved.id })).source).toBe(
      example.source,
    );
  });
  it("rejects empty splits and missing case IDs", async () => {
    const empty = await caller().create({ name: "Empty" });
    await expect(
      caller().startRun({
        datasetId: empty.id,
        name: "Empty",
        mode: "verification",
        split: "holdout",
        prompt: "x",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller().saveCase({ datasetId, id: randomUUID(), example }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
