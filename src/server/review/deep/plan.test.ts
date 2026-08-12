import { describe, expect, it, vi } from "vitest";
import {
  aiJobs,
  aiReviewItems,
  reviewSnapshots,
  snapshotFiles,
  sourceBlobs,
} from "@/drizzle/schema";
import type { db as database } from "~/server/db";

const { sources } = vi.hoisted(() => ({ sources: new Map<string, string>() }));

vi.mock("~/server/storage/source-blobs", () => ({
  /** Serves the fixture text a blob digest stands for. */
  readSourceText: async (blob: { digest: string }) => {
    const source = sources.get(blob.digest);
    if (source === undefined) throw new Error("blob is unreadable");
    return source;
  },
}));

import { reviewItemFingerprint, sealReviewPlan } from "./plan";

type Database = typeof database;
type Row = Record<string, unknown>;

const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";

interface FixtureFile {
  path: string;
  changeType?: string;
  additions?: number;
  deletions?: number;
  isBinary?: boolean;
  /** The current-revision text, or null for a deleted file. */
  source?: string | null;
  previousSource?: string | null;
  byteLength?: number;
  blobState?: string;
}

/**
 * A stand-in for the drizzle client, one behaviour per call site.
 *
 * `plan.ts` reads each table from exactly one place, so the double can answer
 * by table without interpreting a `where` clause: `aiJobs.findFirst` is the
 * parent lookup — always row zero, children are appended after it —
 * `aiJobs.findMany` is the child lookup, and so on.
 */
function createFakeDatabase(files: FixtureFile[], parent: Row = {}) {
  const tables = new Map<unknown, Row[]>([
    [
      aiJobs,
      [
        {
          id: PARENT_ID,
          workspaceId: WORKSPACE_ID,
          pullRequestId: "pull-request",
          snapshotId: SNAPSHOT_ID,
          userId: "user",
          kind: "review",
          model: "big-model",
          provider: "opencode",
          agentVersion: 14,
          status: "waiting_for_provider",
          startedAt: null,
          progress: 0,
          ruleConfigDigest: null,
          deepReviewTerminalState: null,
          parentJobId: null,
          ...parent,
        },
      ],
    ],
    [aiReviewItems, []],
    [reviewSnapshots, [{ id: SNAPSHOT_ID, headSha: "head-sha", version: 3 }]],
    [snapshotFiles, []],
    [sourceBlobs, []],
  ]);
  const operations: string[] = [];
  files.forEach((file, index) => {
    /** Registers one fixture revision as a readable source blob. */
    const blob = (side: string, source: string | null | undefined) => {
      if (source === null || source === undefined) return null;
      const digest = `${index}-${side}`;
      sources.set(digest, source);
      tables.get(sourceBlobs)?.push({
        id: `blob-${digest}`,
        digest,
        state: file.blobState ?? "ready",
        byteLength: file.byteLength ?? source.length,
        encoding: "utf-8",
      });
      return `blob-${digest}`;
    };
    tables.get(snapshotFiles)?.push({
      id: `file-${index}`,
      snapshotId: SNAPSHOT_ID,
      path: file.path,
      changeType: file.changeType ?? "modified",
      currentBlobId: blob("current", file.source ?? "const value = 1;\n"),
      previousBlobId: blob("previous", file.previousSource),
      additions: file.additions ?? 4,
      deletions: file.deletions ?? 1,
      isBinary: file.isBinary ?? false,
    });
  });

  /** Resolves the rows a table stands for. */
  const rowsOf = (table: unknown) => tables.get(table) ?? [];
  const query = {
    aiJobs: {
      findFirst: async () => rowsOf(aiJobs)[0],
      findMany: async () =>
        rowsOf(aiJobs).filter((row) => row.parentJobId !== null),
    },
    aiReviewItems: { findMany: async () => [...rowsOf(aiReviewItems)] },
    reviewSnapshots: { findFirst: async () => rowsOf(reviewSnapshots)[0] },
    snapshotFiles: { findMany: async () => [...rowsOf(snapshotFiles)] },
    sourceBlobs: { findMany: async () => [...rowsOf(sourceBlobs)] },
  };
  /** Appends rows, honouring the one unique index the plan relies on. */
  const insert = (table: unknown) => ({
    values(values: Row | Row[]) {
      const incoming = Array.isArray(values) ? values : [values];
      const stored = rowsOf(table);
      const accepted = incoming.filter(
        (row) =>
          table !== aiReviewItems ||
          !stored.some(
            (existing) =>
              existing.parentJobId === row.parentJobId &&
              existing.path === row.path,
          ),
      );
      operations.push(`insert:${table === aiJobs ? "job" : "item"}`);
      stored.push(...accepted);
      return {
        /** Ends the item insert, which is always awaited straight away. */
        onConflictDoNothing: async () => accepted,
        /** Returns the rows the job insert accepted. */
        returning: async () => accepted,
      };
    },
  });
  /** Applies one update to the single row its call site targets. */
  const update = (table: unknown) => ({
    set(values: Row) {
      return {
        where: async () => {
          operations.push("update");
          Object.assign(rowsOf(table)[0] ?? {}, values);
        },
      };
    },
  });
  const fake = {
    query,
    insert,
    update,
    /** Records the advisory lock the plan takes before anything else. */
    execute: async () => {
      operations.push("execute");
      return [];
    },
    /** Runs the sealing callback against the same in-memory tables. */
    transaction: async <T>(callback: (tx: unknown) => Promise<T>) =>
      callback(fake),
  };
  return {
    db: fake as unknown as Database,
    operations,
    jobs: () => rowsOf(aiJobs),
    items: () => rowsOf(aiReviewItems),
    parent: () => rowsOf(aiJobs)[0] as Row,
  };
}

describe("reviewItemFingerprint", () => {
  const input = {
    workspaceId: WORKSPACE_ID,
    headSha: "head",
    path: "src/a.ts",
    currentBlobDigest: "current",
    previousBlobDigest: "previous",
    ruleConfigDigest: "rules",
  };

  it("derives a stable sha256 for identical inputs", () => {
    expect(reviewItemFingerprint(input)).toBe(reviewItemFingerprint(input));
    expect(reviewItemFingerprint(input)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("separates workspaces sharing a path and a revision", () => {
    expect(reviewItemFingerprint({ ...input, workspaceId: "other" })).not.toBe(
      reviewItemFingerprint(input),
    );
  });

  it("keeps adjacent fields from bleeding into each other", () => {
    expect(
      reviewItemFingerprint({ ...input, path: "src/a.tshead", headSha: "" }),
    ).not.toBe(reviewItemFingerprint({ ...input, path: "src/a.ts" }));
  });

  it("distinguishes a missing digest from an empty one", () => {
    expect(
      reviewItemFingerprint({ ...input, previousBlobDigest: null }),
    ).not.toBe(reviewItemFingerprint({ ...input, previousBlobDigest: "x" }));
  });
});

describe("sealReviewPlan", () => {
  it("seals one item per changed file and one child per selection", async () => {
    const fake = createFakeDatabase([
      { path: "src/small.ts", additions: 2, deletions: 0 },
      { path: "src/large.ts", additions: 40, deletions: 10 },
      { path: "docs/logo.png", isBinary: true },
    ]);

    const plan = await sealReviewPlan(fake.db, PARENT_ID);

    expect(plan.terminalState).toBeNull();
    expect(plan.itemCount).toBe(3);
    expect(plan.selectedCount).toBe(2);
    expect(plan.waivedCount).toBe(1);
    expect(plan.items.map((item) => item.path)).toEqual([
      "src/large.ts",
      "src/small.ts",
      "docs/logo.png",
    ]);
    expect(plan.items.at(-1)).toMatchObject({
      state: "waived",
      childJobId: null,
      reason: "binary",
    });
    expect(fake.items()).toHaveLength(3);
    const children = fake.jobs().filter((job) => job.id !== PARENT_ID);
    expect(children.filter((job) => job.kind === "review_file")).toHaveLength(
      2,
    );
    expect(children.filter((job) => job.kind === "review_survey")).toHaveLength(
      1,
    );
    expect(plan.surveyJobId).toBe(
      children.find((job) => job.kind === "review_survey")?.id,
    );
  });

  it("takes the advisory lock before it writes anything", async () => {
    const fake = createFakeDatabase([{ path: "src/a.ts" }]);

    await sealReviewPlan(fake.db, PARENT_ID);

    expect(fake.operations[0]).toBe("execute");
    expect(fake.operations.at(-1)).toBe("update");
  });

  it("starts the parent so the UI polls and the clock has an anchor", async () => {
    const now = new Date("2026-08-12T10:00:00Z");
    const fake = createFakeDatabase([{ path: "src/a.ts" }]);

    await sealReviewPlan(fake.db, PARENT_ID, { now });

    expect(fake.parent()).toMatchObject({
      status: "running",
      startedAt: now,
      progress: 1,
      deepReviewTerminalState: null,
    });
    expect(fake.parent().ruleConfigDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("copies the parent's scope onto children and reserves nothing", async () => {
    const fake = createFakeDatabase([{ path: "src/a.ts" }]);

    const plan = await sealReviewPlan(fake.db, PARENT_ID);

    const child = fake
      .jobs()
      .find((job) => job.id === plan.items[0]?.childJobId);
    expect(child).toMatchObject({
      workspaceId: WORKSPACE_ID,
      pullRequestId: "pull-request",
      snapshotId: SNAPSHOT_ID,
      userId: "user",
      model: "big-model",
      provider: "opencode",
      agentVersion: 14,
      kind: "review_file",
      parentJobId: PARENT_ID,
      status: "queued",
      unitId: null,
      reservedInputTokens: 0,
      reservedOutputTokens: 0,
      reservedMicroUsd: 0,
    });
    expect(child?.ruleConfigDigest).toBe(plan.ruleConfigDigest);
  });

  it("returns the sealed plan unchanged when the step replays", async () => {
    const fake = createFakeDatabase([
      { path: "src/a.ts" },
      { path: "docs/logo.png", isBinary: true },
    ]);

    const first = await sealReviewPlan(fake.db, PARENT_ID);
    const jobCount = fake.jobs().length;
    const second = await sealReviewPlan(fake.db, PARENT_ID);

    expect(second.items).toEqual(first.items);
    expect(second.surveyJobId).toBe(first.surveyJobId);
    expect(second.selectedCount).toBe(1);
    expect(fake.jobs()).toHaveLength(jobCount);
    expect(fake.items()).toHaveLength(2);
  });

  it("counts the denominator by dispatch, not by item state", async () => {
    const fake = createFakeDatabase([{ path: "src/a.ts" }]);

    await sealReviewPlan(fake.db, PARENT_ID);
    const item = fake.items()[0] as Row;
    item.state = "completed";
    const replayed = await sealReviewPlan(fake.db, PARENT_ID);

    expect(replayed.selectedCount).toBe(1);
    expect(replayed.items[0]?.state).toBe("completed");
  });

  it("skips a run that selected nothing without throwing", async () => {
    const fake = createFakeDatabase([
      { path: "docs/logo.png", isBinary: true },
      { path: "README.txt" },
    ]);

    const plan = await sealReviewPlan(fake.db, PARENT_ID);

    expect(plan.terminalState).toBe("skipped");
    expect(plan.selectedCount).toBe(0);
    expect(
      Object.fromEntries(plan.items.map((item) => [item.path, item.reason])),
    ).toEqual({
      "docs/logo.png": "binary",
      "README.txt": "unsupported_extension",
    });
    expect(fake.jobs()).toHaveLength(1);
    expect(fake.parent()).toMatchObject({
      deepReviewTerminalState: "skipped",
      status: "running",
    });
  });

  it("recognises a replayed skip that left no item rows", async () => {
    const fake = createFakeDatabase([], {
      deepReviewTerminalState: "skipped",
      ruleConfigDigest: "a".repeat(64),
    });

    const plan = await sealReviewPlan(fake.db, PARENT_ID);

    expect(plan.terminalState).toBe("skipped");
    expect(plan.itemCount).toBe(0);
    expect(fake.operations).toEqual([]);
  });

  it("waives a protected path and a file carrying a secret", async () => {
    const fake = createFakeDatabase([
      { path: "deploy/credentials.ts" },
      {
        path: "src/leak.ts",
        source: 'const key = "sk-abcdefghijklmnopqrstuv";',
      },
      { path: "src/clean.ts" },
    ]);

    const plan = await sealReviewPlan(fake.db, PARENT_ID);

    expect(
      Object.fromEntries(
        plan.items.map((item) => [item.path, item.reason ?? "selected"]),
      ),
    ).toEqual({
      "src/clean.ts": "selected",
      "deploy/credentials.ts": "protected_path",
      "src/leak.ts": "secret_detected",
    });
  });

  it("reviews a deleted file from its previous revision", async () => {
    const fake = createFakeDatabase([
      {
        path: "src/gone.ts",
        changeType: "deleted",
        source: null,
        previousSource: "export const removed = true;\n",
      },
    ]);

    const plan = await sealReviewPlan(fake.db, PARENT_ID);

    expect(plan.selectedCount).toBe(1);
    expect(plan.items[0]).toMatchObject({
      path: "src/gone.ts",
      changeType: "deleted",
      state: "selected",
    });
    expect(plan.items[0]?.childJobId).not.toBeNull();
  });

  it("waives a file whose blob never finished uploading", async () => {
    const fake = createFakeDatabase([
      { path: "src/pending.ts", blobState: "uploading" },
    ]);

    const plan = await sealReviewPlan(fake.db, PARENT_ID);

    expect(plan.items[0]).toMatchObject({
      state: "waived",
      reason: "no_source",
    });
  });

  it("waives a file whose source cannot be read back", async () => {
    const fake = createFakeDatabase([{ path: "src/torn.ts" }]);
    sources.delete("0-current");

    const plan = await sealReviewPlan(fake.db, PARENT_ID);

    expect(plan.items[0]).toMatchObject({
      state: "waived",
      reason: "no_source",
    });
  });

  it("refuses to seal a plan for a job that is not a review", async () => {
    const fake = createFakeDatabase([{ path: "src/a.ts" }], {
      kind: "explain",
    });

    await expect(sealReviewPlan(fake.db, PARENT_ID)).rejects.toThrow(
      "Deep review plan requires a review job",
    );
  });
});
