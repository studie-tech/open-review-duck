import "server-only";

import { and, desc, eq, gt, lt } from "drizzle-orm";
import { sourceBlobs, syncArtifacts } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import {
  persistSourceBlob,
  readSourceText,
  sourceDigest,
} from "~/server/storage/source-blobs";

const CACHE_LIFETIME_MS = 7 * 86_400_000;
const MAX_CACHE_ENTRIES = 6_000;
const CHECKPOINT_BYTE_BUDGET = {
  source: 20_000_000,
  analysis: 40_000_000,
} as const;

/** Hashes a versioned, repository-local identity without storing private paths in keys. */
export function syncArtifactKey(kind: string, identity: unknown) {
  return sourceDigest(Buffer.from(JSON.stringify([kind, identity])));
}

/** Loads private checkpoints once per run; missing objects always fall back to fresh work. */
export async function createSyncArtifactCache(
  db: typeof database,
  repositoryId: string,
  workspaceId: string,
  retentionDays: number,
) {
  const lifetime = Math.min(
    CACHE_LIFETIME_MS,
    Math.max(0, retentionDays) * 86_400_000,
  );
  const entries = await db
    .select({ key: syncArtifacts.cacheKey, blob: sourceBlobs })
    .from(syncArtifacts)
    .innerJoin(sourceBlobs, eq(syncArtifacts.sourceBlobId, sourceBlobs.id))
    .where(
      and(
        eq(syncArtifacts.repositoryId, repositoryId),
        eq(sourceBlobs.workspaceId, workspaceId),
        gt(syncArtifacts.expiresAt, new Date()),
        gt(syncArtifacts.createdAt, new Date(Date.now() - lifetime)),
      ),
    )
    .orderBy(desc(syncArtifacts.expiresAt))
    .limit(MAX_CACHE_ENTRIES);
  const known = new Map(entries.map(({ key, blob }) => [key, blob]));
  const pending = new Map<string, Promise<string | undefined>>();
  const checkpointBytes = { source: 0, analysis: 0 };
  const metrics = {
    sourceReused: 0,
    sourceDownloaded: 0,
    analysisReused: 0,
    analysisExtracted: 0,
  };

  /** Reads and verifies the private checkpoint, treating absent or corrupt data as a miss. */
  async function read(key: string) {
    const blob = known.get(key);
    if (!blob) return undefined;
    try {
      return await readSourceText(blob);
    } catch {
      known.delete(key);
      // A failed read must not let the recent-verification shortcut reuse a
      // missing object when fresh work is checkpointed. The normal writer
      // will probe it and distinguish absence from a storage outage.
      await db
        .update(sourceBlobs)
        .set({ updatedAt: new Date(0) })
        .where(
          and(
            eq(sourceBlobs.id, blob.id),
            eq(sourceBlobs.state, "ready"),
            lt(sourceBlobs.updatedAt, new Date()),
          ),
        );
      return undefined;
    }
  }

  /** Commits one checkpoint before proceeding, so workflow retries can reuse finished work. */
  async function write(
    key: string,
    text: string,
    kind: "source" | "analysis" = "analysis",
  ) {
    const bytes = Buffer.from(text);
    // The provider collector drops oversized candidates after downloading.
    // Its cache must not upload an unbounded set of those discarded files.
    if (checkpointBytes[kind] + bytes.byteLength > CHECKPOINT_BYTE_BUDGET[kind])
      return;
    checkpointBytes[kind] += bytes.byteLength;
    const blob = await persistSourceBlob(db, { workspaceId, bytes });
    await db
      .insert(syncArtifacts)
      .values({
        repositoryId,
        cacheKey: key,
        sourceBlobId: blob.id,
        expiresAt: new Date(Date.now() + lifetime),
      })
      .onConflictDoUpdate({
        target: [syncArtifacts.repositoryId, syncArtifacts.cacheKey],
        set: {
          sourceBlobId: blob.id,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + lifetime),
        },
      });
    known.set(key, blob);
  }

  /** Shares concurrent reads of the same immutable provider object within this run. */
  function loadSource(
    identity: string,
    load: () => Promise<string | undefined>,
    validate?: (content: string) => boolean,
  ) {
    const key = syncArtifactKey("provider-source-v1", identity);
    const existing = pending.get(key);
    if (existing)
      return existing.then(async (text) => {
        // An unverified result belongs only to the path/ref that downloaded it.
        // Another file reporting the same raced manifest ID needs its own read.
        if (text !== undefined && validate && !validate(text)) {
          metrics.sourceDownloaded++;
          return load();
        }
        return text;
      });
    const result = (async () => {
      const cached = await read(key);
      if (cached !== undefined && (!validate || validate(cached))) {
        metrics.sourceReused++;
        return cached;
      }
      metrics.sourceDownloaded++;
      const text = await load();
      // Normalized text (for example a stripped UTF-8 BOM) can still be
      // reviewed, but cannot prove the raw provider blob identity. Likewise,
      // a manifest/metadata race must not poison the next attempt's cache.
      if (text !== undefined && (!validate || validate(text)))
        await write(key, text, "source");
      return text;
    })().finally(() => pending.delete(key));
    // Keep only in-flight promises: retaining every downloaded candidate
    // would defeat the provider collector's source-byte budget.
    pending.set(key, result);
    return result;
  }
  return { read, write, loadSource, metrics };
}
