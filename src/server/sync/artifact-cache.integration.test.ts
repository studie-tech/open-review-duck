import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  providerConnections,
  repositories,
  sourceBlobs,
  syncArtifacts,
  users,
  workspaces,
} from "@/drizzle/schema";
import { analyzeFiles } from "~/server/analysis/engine";
import { withPreparedTreeSitterLanguages } from "~/server/analysis/tree-sitter";
import type { SourceFile } from "~/server/analysis/types";
import { db } from "~/server/db";
import { sourceObjectStore } from "~/server/storage";
import { createSyncArtifactCache, syncArtifactKey } from "./artifact-cache";
import { analyzeFilesIncrementally } from "./incremental-analysis";

const userId = `sync-cache-${randomUUID()}`;
const workspaceId = randomUUID();
const repositoryId = randomUUID();
const connectionId = randomUUID();

beforeAll(async () => {
  await db.insert(users).values({ id: userId });
  await db.insert(workspaces).values({
    id: workspaceId,
    ownerId: userId,
    name: "Sync cache integration",
    slug: randomUUID(),
  });
  await db.insert(providerConnections).values({
    id: connectionId,
    workspaceId,
    provider: "github",
    externalAccountId: "cache-test",
    displayName: "Cache integration",
  });
  await db.insert(repositories).values({
    id: repositoryId,
    workspaceId,
    connectionId,
    externalId: "123",
    owner: "integration",
    name: "cache",
    defaultBranch: "main",
    webUrl: "https://github.com/integration/cache",
  });
});
afterAll(async () => {
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(users).where(eq(users.id, userId));
});

/** Opens a new process-equivalent cache using only durable database and private objects. */
const openCache = () =>
  createSyncArtifactCache(db, repositoryId, workspaceId, 7);

describe("durable synchronization checkpoints", () => {
  it("downloads only the changed immutable content across a 117-file PR update", async () => {
    const initial = await openCache();
    const download = vi.fn(async () => "export const value = '🦆';\n");
    for (let index = 0; index < 117; index++)
      await initial.loadSource(`blob:${index}`, download);
    expect(download).toHaveBeenCalledTimes(117);
    const next = await openCache();
    download.mockClear();
    for (let index = 0; index < 117; index++)
      await next.loadSource(
        index === 0 ? "blob:changed" : `blob:${index}`,
        download,
      );
    expect(download).toHaveBeenCalledOnce();
    expect(next.metrics).toMatchObject({
      sourceReused: 116,
      sourceDownloaded: 1,
    });
  });

  it("deduplicates concurrent loads and resumes work completed before a later failure", async () => {
    const initial = await openCache();
    const load = vi.fn(async () => "completed source");
    await Promise.all([
      initial.loadSource("concurrent", load),
      initial.loadSource("concurrent", load),
    ]);
    expect(load).toHaveBeenCalledOnce();
    await expect(
      initial.loadSource("failed", async () => {
        throw new Error("provider unavailable");
      }),
    ).rejects.toThrow("provider unavailable");
    const retry = await openCache();
    await expect(retry.loadSource("concurrent", load)).resolves.toBe(
      "completed source",
    );
    expect(load).toHaveBeenCalledOnce();
  });

  it("repairs a missing recent private object instead of trusting its ready row", async () => {
    const identity = "repairable";
    const text = "private repair fixture";
    const initial = await openCache();
    await initial.loadSource(identity, async () => text);
    const entry = await db.query.syncArtifacts.findFirst({
      where: eq(
        syncArtifacts.cacheKey,
        syncArtifactKey("provider-source-v1", identity),
      ),
    });
    const blob = await db.query.sourceBlobs.findFirst({
      where: eq(sourceBlobs.id, entry?.sourceBlobId ?? randomUUID()),
    });
    if (!blob?.objectKey) throw new Error("Fixture object missing");
    await (await sourceObjectStore()).delete(blob.objectKey);
    const fallback = vi.fn(async () => text);
    await expect(
      (await openCache()).loadSource(identity, fallback),
    ).resolves.toBe(text);
    expect(fallback).toHaveBeenCalledOnce();
    fallback.mockClear();
    await expect(
      (await openCache()).loadSource(identity, fallback),
    ).resolves.toBe(text);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("respects expiration and a shortened repository retention policy", async () => {
    const initial = await openCache();
    await initial.loadSource("expired", async () => "old");
    await db
      .update(syncArtifacts)
      .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(
        eq(
          syncArtifacts.cacheKey,
          syncArtifactKey("provider-source-v1", "expired"),
        ),
      );
    const shortened = await createSyncArtifactCache(
      db,
      repositoryId,
      workspaceId,
      1,
    );
    const load = vi.fn(async () => "new");
    await expect(shortened.loadSource("expired", load)).resolves.toBe("new");
    expect(load).toHaveBeenCalledOnce();
    const fresh = await createSyncArtifactCache(
      db,
      repositoryId,
      workspaceId,
      1,
    );
    await expect(fresh.loadSource("expired", load)).resolves.toBe("new");
    expect(load).toHaveBeenCalledOnce();
  });
});

describe("durable incremental analysis", () => {
  it("reuses 116 file extractions and produces the same graph as full analysis after one update", async () => {
    const files: SourceFile[] = Array.from({ length: 117 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      changeType: "added",
      content: `export function value${index}() { return 1; }\n`,
    }));
    const first = await openCache();
    await analyzeFilesIncrementally(files, first);
    expect(first.metrics.analysisExtracted).toBe(117);
    files[0] = {
      path: "src/file-0.ts",
      changeType: "added",
      content: "export function value0() { return 2; }\n",
    };
    const next = await openCache();
    const result = await analyzeFilesIncrementally(files, next);
    expect(next.metrics).toMatchObject({
      analysisExtracted: 1,
      analysisReused: 116,
    });
    const full = await withPreparedTreeSitterLanguages(["typescript"], () =>
      analyzeFiles(files),
    );
    expect(result).toEqual(full);
  });

  it("invalidates extraction when the comparison side or path changes", async () => {
    const original: SourceFile = {
      path: "src/renamed.ts",
      previousPath: "src/old.ts",
      changeType: "renamed",
      previousContent: "export const oldValue = 1;\n",
      content: "export const newValue = 2;\n",
    };
    await analyzeFilesIncrementally([original], await openCache());
    for (const file of [
      { ...original, previousContent: "export const oldValue = 3;\n" },
      { ...original, previousPath: "src/another.ts" },
      { ...original, path: "src/moved.ts" },
    ]) {
      const next = await openCache();
      await analyzeFilesIncrementally([file], next);
      expect(next.metrics.analysisExtracted).toBe(1);
      expect(next.metrics.analysisReused).toBe(0);
    }
  });
});
