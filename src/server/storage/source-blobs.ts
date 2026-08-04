import "server-only";

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { sourceBlobs } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { observeOperation } from "~/server/observability/sentry";
import { sourceObjectStore } from "./index";

type Database = typeof database;

/** Returns the SHA-256 content identity used for source object deduplication. */
export function sourceDigest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Persists one immutable workspace-scoped object exactly once. */
export async function persistSourceBlob(
  db: Database,
  input: {
    workspaceId: string;
    bytes: Uint8Array;
    encoding?: string;
    mediaType?: string;
  },
) {
  const digest = sourceDigest(input.bytes);
  const store = await sourceObjectStore();
  const existing = await db.query.sourceBlobs.findFirst({
    where: and(
      eq(sourceBlobs.workspaceId, input.workspaceId),
      eq(sourceBlobs.digest, digest),
    ),
  });
  if (existing?.state === "ready") return existing;

  const [claimed] = await db
    .insert(sourceBlobs)
    .values({
      workspaceId: input.workspaceId,
      digest,
      storage: store.kind,
      state: "uploading",
      byteLength: input.bytes.byteLength,
      encoding: input.encoding ?? "utf-8",
      mediaType: input.mediaType ?? "application/octet-stream",
    })
    .onConflictDoNothing({
      target: [sourceBlobs.workspaceId, sourceBlobs.digest],
    })
    .returning();
  if (!claimed) {
    const raced = await db.query.sourceBlobs.findFirst({
      where: and(
        eq(sourceBlobs.workspaceId, input.workspaceId),
        eq(sourceBlobs.digest, digest),
      ),
    });
    if (raced?.state === "ready") return raced;
    throw new Error("A concurrent source upload is still in progress");
  }

  try {
    const stored = await observeOperation(
      "storage.ingest-source",
      "storage",
      () =>
        store.put({
          bytes: input.bytes,
          digest,
          workspaceId: input.workspaceId,
        }),
    );
    const [ready] = await db
      .update(sourceBlobs)
      .set({
        state: "ready",
        storage: stored.storage,
        objectKey: stored.objectKey,
        customId: stored.customId,
        error: null,
      })
      .where(eq(sourceBlobs.id, claimed.id))
      .returning();
    if (!ready) throw new Error("Source blob disappeared after upload");
    return ready;
  } catch (cause) {
    await db
      .update(sourceBlobs)
      .set({
        state: "failed",
        error: cause instanceof Error ? cause.message : "Source upload failed",
      })
      .where(eq(sourceBlobs.id, claimed.id));
    throw cause;
  }
}

/** Reads a ready source object and verifies its digest before returning it. */
export async function readSourceBlob(blob: typeof sourceBlobs.$inferSelect) {
  if (blob.state !== "ready" || !blob.objectKey) {
    throw new Error("Source blob is not ready");
  }
  const bytes = await (await sourceObjectStore()).read(blob.objectKey);
  if (sourceDigest(bytes) !== blob.digest) {
    throw new Error("Source object digest verification failed");
  }
  return bytes;
}

/** Decodes one ready source object as UTF-8 text. */
export async function readSourceText(blob: typeof sourceBlobs.$inferSelect) {
  if (blob.encoding !== "utf-8") {
    throw new Error(`Unsupported source encoding: ${blob.encoding}`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await readSourceBlob(blob),
  );
}

/** Deletes only objects proven unreferenced in the same claiming transaction. */
export async function pruneOrphanSourceBlobs(db: Database, maximum = 100) {
  const claimed = await db.transaction(async (tx) => {
    const candidates = await tx.execute<{ id: string }>(sql`
      select blob.id
      from open_review_duck_source_blob blob
      where (
          blob.state in ('ready', 'failed')
          or (
            blob.state in ('uploading', 'deleting')
            and blob."updatedAt" < now() - interval '1 hour'
          )
        )
        and not exists (
          select 1 from open_review_duck_snapshot_file file
          where file."currentBlobId" = blob.id or file."previousBlobId" = blob.id
        )
        and not exists (
          select 1 from open_review_duck_semantic_artifact artifact
          where artifact."sourceBlobId" = blob.id
        )
        and not exists (
          select 1 from open_review_duck_ai_job_evidence evidence
          where evidence."sourceBlobId" = blob.id
        )
      order by blob."createdAt"
      limit ${maximum}
      for update skip locked
    `);
    if (candidates.rows.length === 0) return [];
    const ids = candidates.rows.map(({ id }) => id);
    return tx
      .update(sourceBlobs)
      .set({ state: "deleting", error: null })
      .where(sql`${sourceBlobs.id} = any(${ids}::uuid[])`)
      .returning();
  });
  let deleted = 0;
  for (const blob of claimed) {
    try {
      if (blob.objectKey) {
        await (await sourceObjectStore()).delete(blob.objectKey);
      }
      await db.delete(sourceBlobs).where(eq(sourceBlobs.id, blob.id));
      deleted += 1;
    } catch (cause) {
      await db
        .update(sourceBlobs)
        .set({
          state: "failed",
          error:
            cause instanceof Error ? cause.message : "Source deletion failed",
        })
        .where(eq(sourceBlobs.id, blob.id));
    }
  }
  return deleted;
}

/** Drains orphan batches without letting one maintenance invocation run indefinitely. */
export async function pruneAllOrphanSourceBlobs(
  db: Database,
  batchSize = 100,
  wallClockMilliseconds = 45_000,
) {
  const deadline = Date.now() + wallClockMilliseconds;
  let deleted = 0;
  while (Date.now() < deadline) {
    const batchDeleted = await pruneOrphanSourceBlobs(db, batchSize);
    deleted += batchDeleted;
    if (batchDeleted < batchSize) break;
  }
  return deleted;
}
