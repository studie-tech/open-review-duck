import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { and, eq, lt, or, sql } from "drizzle-orm";
import { sourceBlobs } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { observeOperation } from "~/server/observability/sentry";
import { sourceObjectStore } from "./index";

type Database = typeof database;
const UPLOAD_LEASE_MILLISECONDS = 4 * 60_000;
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
  const uploadClaim = {
    state: "uploading" as const,
    storage: store.kind,
    objectKey: null,
    byteLength: input.bytes.byteLength,
    encoding: input.encoding ?? "utf-8",
    mediaType: input.mediaType ?? "application/octet-stream",
    customId: store.customId?.(putInput),
    error: null,
    uploadLeaseToken,
    uploadLeaseExpiresAt: new Date(Date.now() + UPLOAD_LEASE_MILLISECONDS),
  };
  /** Reuses a ready row only when its immutable object still exists. */
  const reuseReadyBlob = async (blob: typeof sourceBlobs.$inferSelect) => {
    if (blob.storage !== store.kind || !blob.objectKey) return undefined;
    // Presence is the only thing in doubt here, and this runs for every
    // deduplicated file of every sync. readSourceBlob would transfer and
    // rehash the whole object; it still verifies the digest on real reads.
    //
    // A probe answers false only for a proven absence and throws otherwise, so
    // it is let through: an outage must not cost the row naming the object.
    // A store with no probe has to read the whole thing, and a transfer that
    // failed cannot be told apart from one with nothing to transfer, so the
    // two stay conflated there and nowhere else.
    const present = store.exists
      ? await store.exists(blob.objectKey)
      : await readSourceBlob(blob).then(
          () => true,
          () => false,
        );
    if (!present) return undefined;
    const [reused] = await db
      .update(sourceBlobs)
      .set({ updatedAt: new Date() })
      .where(and(eq(sourceBlobs.id, blob.id), eq(sourceBlobs.state, "ready")))
      .returning();
    return reused;
  };
  /** Claims a stale ready row so its immutable object can be restored. */
  const claimReadyBlob = async (id: string) => {
    const [claimed] = await db
      .update(sourceBlobs)
      .set(uploadClaim)
      .where(and(eq(sourceBlobs.id, id), eq(sourceBlobs.state, "ready")))
      .returning();
    return claimed;
  };
  const existing = await db.query.sourceBlobs.findFirst({
    where: and(
      eq(sourceBlobs.workspaceId, input.workspaceId),
      eq(sourceBlobs.digest, digest),
    ),
  });
  let claimed: typeof sourceBlobs.$inferSelect | undefined;
  if (existing?.state === "ready") {
    const reused = await reuseReadyBlob(existing);
    if (reused) return reused;
    claimed = await claimReadyBlob(existing.id);
  }

  if (!claimed) {
    [claimed] = await db
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
  }
  if (!claimed) {
    const raced = await db.query.sourceBlobs.findFirst({
      where: and(
        eq(sourceBlobs.workspaceId, input.workspaceId),
        eq(sourceBlobs.digest, digest),
      ),
    });
    if (raced?.state === "ready") {
      const reused = await reuseReadyBlob(raced);
      if (reused) return reused;
      claimed = await claimReadyBlob(raced.id);
    }
    if (raced) {
      if (!claimed) {
        [claimed] = await db
          .update(sourceBlobs)
          .set(uploadClaim)
          .where(
            and(
              eq(sourceBlobs.id, raced.id),
              or(
                eq(sourceBlobs.state, "failed"),
                and(
                  eq(sourceBlobs.state, "uploading"),
                  lt(sourceBlobs.uploadLeaseExpiresAt, new Date()),
                ),
              ),
            ),
          )
          .returning();
      }
    }
    if (!claimed) {
      throw new Error("A concurrent source upload is still in progress");
    }
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
