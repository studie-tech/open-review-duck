import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { sourceBlobs } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { observeOperation } from "~/server/observability/sentry";
import { sourceObjectStore } from "./index";

type Database = typeof database;
const UPLOAD_LEASE_MILLISECONDS = 6 * 60 * 60_000;
const DELETION_LEASE_MILLISECONDS = 15 * 60_000;

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
  const putInput = {
    bytes: input.bytes,
    digest,
    workspaceId: input.workspaceId,
  };
  const uploadLeaseToken = randomUUID();
  const existing = await db.query.sourceBlobs.findFirst({
    where: and(
      eq(sourceBlobs.workspaceId, input.workspaceId),
      eq(sourceBlobs.digest, digest),
    ),
  });
  if (existing?.state === "ready") {
    const [reused] = await db
      .update(sourceBlobs)
      .set({ updatedAt: new Date() })
      .where(
        and(eq(sourceBlobs.id, existing.id), eq(sourceBlobs.state, "ready")),
      )
      .returning();
    if (reused) return reused;
  }

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
      customId: store.customId?.(putInput),
      uploadLeaseToken,
      uploadLeaseExpiresAt: new Date(Date.now() + UPLOAD_LEASE_MILLISECONDS),
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
      () => store.put(putInput),
    );
    const [ready] = await db
      .update(sourceBlobs)
      .set({
        state: "ready",
        storage: stored.storage,
        objectKey: stored.objectKey,
        customId: stored.customId,
        error: null,
        uploadLeaseToken: null,
        uploadLeaseExpiresAt: null,
      })
      .where(
        and(
          eq(sourceBlobs.id, claimed.id),
          eq(sourceBlobs.state, "uploading"),
          eq(sourceBlobs.uploadLeaseToken, uploadLeaseToken),
        ),
      )
      .returning();
    if (!ready) {
      await store.delete(stored.objectKey);
      throw new Error("Source upload lease expired before completion");
    }
    return ready;
  } catch (cause) {
    await db
      .update(sourceBlobs)
      .set({
        state: "failed",
        error: cause instanceof Error ? cause.message : "Source upload failed",
        uploadLeaseToken: null,
        uploadLeaseExpiresAt: null,
      })
      .where(
        and(
          eq(sourceBlobs.id, claimed.id),
          eq(sourceBlobs.state, "uploading"),
          eq(sourceBlobs.uploadLeaseToken, uploadLeaseToken),
        ),
      );
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
export async function pruneOrphanSourceBlobs(
  db: Database,
  maximum = 100,
  deadline = Number.POSITIVE_INFINITY,
) {
  if (Date.now() >= deadline) return 0;
  const deletionLeaseToken = randomUUID();
  const claimed = await db.transaction(async (tx) => {
    const candidates = await tx.execute<{
      id: string;
      state: typeof sourceBlobs.$inferSelect.state;
    }>(sql`
      select blob.id, blob.state
      from open_review_duck_source_blob blob
      where (
          blob.state in ('ready', 'failed')
          or (
            blob.state = 'uploading'
            and blob."uploadLeaseExpiresAt" <= now()
          )
          or (
            blob.state = 'deleting'
            and blob."deletionLeaseExpiresAt" <= now()
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
        and blob."updatedAt" < now() - interval '1 hour'
      order by blob."updatedAt"
      limit ${maximum}
      for update skip locked
    `);
    if (candidates.rows.length === 0) return [];
    const ids = candidates.rows.map(({ id }) => id);
    const previousStates = new Map(
      candidates.rows.map(({ id, state }) => [id, state]),
    );
    const rows = await tx
      .update(sourceBlobs)
      .set({
        state: "deleting",
        error: null,
        uploadLeaseToken: null,
        uploadLeaseExpiresAt: null,
        deletionLeaseToken,
        deletionLeaseExpiresAt: new Date(
          Date.now() + DELETION_LEASE_MILLISECONDS,
        ),
      })
      .where(sql`${sourceBlobs.id} = any(${ids}::uuid[])`)
      .returning();
    return rows.map((blob) => ({
      ...blob,
      previousState: previousStates.get(blob.id) ?? "failed",
    }));
  });
  /** Releases one unprocessed deletion claim without reviving an expired upload. */
  const release = async (blob: (typeof claimed)[number]) => {
    await db
      .update(sourceBlobs)
      .set({
        state: blob.previousState === "ready" ? "ready" : ("failed" as const),
        deletionLeaseToken: null,
        deletionLeaseExpiresAt: null,
      })
      .where(
        and(
          eq(sourceBlobs.id, blob.id),
          eq(sourceBlobs.state, "deleting"),
          eq(sourceBlobs.deletionLeaseToken, deletionLeaseToken),
        ),
      );
  };
  let deleted = 0;
  for (const [index, blob] of claimed.entries()) {
    if (Date.now() >= deadline) {
      await Promise.all(claimed.slice(index).map(release));
      break;
    }
    try {
      const owned = await db.query.sourceBlobs.findFirst({
        columns: { id: true },
        where: and(
          eq(sourceBlobs.id, blob.id),
          eq(sourceBlobs.state, "deleting"),
          eq(sourceBlobs.deletionLeaseToken, deletionLeaseToken),
        ),
      });
      if (!owned) continue;
      const store = await sourceObjectStore();
      if (blob.objectKey) {
        await store.delete(blob.objectKey);
      } else if (blob.customId && store.deleteByCustomId) {
        await store.deleteByCustomId(blob.customId);
      }
      const [removed] = await db
        .delete(sourceBlobs)
        .where(
          and(
            eq(sourceBlobs.id, blob.id),
            eq(sourceBlobs.state, "deleting"),
            eq(sourceBlobs.deletionLeaseToken, deletionLeaseToken),
          ),
        )
        .returning({ id: sourceBlobs.id });
      if (removed) deleted += 1;
    } catch (cause) {
      await db
        .update(sourceBlobs)
        .set({
          state: "failed",
          error:
            cause instanceof Error ? cause.message : "Source deletion failed",
          deletionLeaseToken: null,
          deletionLeaseExpiresAt: null,
        })
        .where(
          and(
            eq(sourceBlobs.id, blob.id),
            eq(sourceBlobs.state, "deleting"),
            eq(sourceBlobs.deletionLeaseToken, deletionLeaseToken),
          ),
        );
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
    const batchDeleted = await pruneOrphanSourceBlobs(db, batchSize, deadline);
    deleted += batchDeleted;
    if (batchDeleted < batchSize) break;
  }
  return deleted;
}
