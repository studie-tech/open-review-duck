import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { sourceBlobs } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { observeOperation } from "~/server/observability/sentry";
import { sourceObjectStore } from "./index";

type Database = typeof database;
const UPLOAD_LEASE_MILLISECONDS = 4 * 60_000;
const DELETION_LEASE_MILLISECONDS = 15 * 60_000;
const CONCURRENT_UPLOAD_POLL_MILLISECONDS = 250;
const CONCURRENT_UPLOAD_WAIT_MILLISECONDS = 30_000;
const READY_BLOB_REVALIDATE_MILLISECONDS = 24 * 60 * 60_000;
/**
 * Keeps one `inArray` under PostgreSQL's 65,535 bind-parameter ceiling.
 *
 * A full monorepo snapshot carries more digests than that in a single query,
 * which would fail the whole synchronization, so they are bound in chunks.
 */
const DIGEST_LOOKUP_CHUNK_SIZE = 10_000;

/** Returns the SHA-256 content identity used for source object deduplication. */
export function sourceDigest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Reports whether a ready row's object was verified recently enough to trust. */
function readyBlobIsUsable(
  blob: typeof sourceBlobs.$inferSelect,
  storeKind: string,
) {
  return (
    blob.state === "ready" &&
    blob.storage === storeKind &&
    Boolean(blob.objectKey) &&
    Date.now() - blob.updatedAt.getTime() < READY_BLOB_REVALIDATE_MILLISECONDS
  );
}

/**
 * Loads the workspace rows already holding any of these content digests.
 *
 * A synchronization stores every file of the branch, and nearly all of them
 * are unchanged content the workspace already holds. One batched lookup lets
 * those calls skip the per-object dedup query and its round trip.
 */
export async function loadSourceBlobsByDigest(
  db: Database,
  workspaceId: string,
  digests: readonly string[],
) {
  const unique = [...new Set(digests)];
  const rows: (typeof sourceBlobs.$inferSelect)[] = [];
  for (
    let offset = 0;
    offset < unique.length;
    offset += DIGEST_LOOKUP_CHUNK_SIZE
  ) {
    rows.push(
      ...(await db.query.sourceBlobs.findMany({
        where: and(
          eq(sourceBlobs.workspaceId, workspaceId),
          inArray(
            sourceBlobs.digest,
            unique.slice(offset, offset + DIGEST_LOOKUP_CHUNK_SIZE),
          ),
        ),
      })),
    );
  }
  return new Map(rows.map((row) => [row.digest, row]));
}

/** Persists one immutable workspace-scoped object exactly once. */
export async function persistSourceBlob(
  db: Database,
  input: {
    workspaceId: string;
    bytes: Uint8Array;
    encoding?: string;
    mediaType?: string;
    knownBlobs?: ReadonlyMap<string, typeof sourceBlobs.$inferSelect>;
  },
) {
  const digest = sourceDigest(input.bytes);
  const store = await sourceObjectStore();
  const uploadLeaseToken = randomUUID();
  const putInput = {
    attemptId: uploadLeaseToken,
    bytes: input.bytes,
    digest,
    workspaceId: input.workspaceId,
  };
  /**
   * Describes this call's claim, dated where the claim lands.
   *
   * Reaching a claim costs a probe of the store and, when another writer holds
   * the digest, as much as the whole wait for it. A lease stamped on the way in
   * is already part spent by the time a row carries it, and the writer it
   * belongs to loses it that much sooner.
   */
  const uploadClaim = () => ({
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
  });
  /** Reuses a ready row only when its immutable object still exists. */
  const reuseReadyBlob = async (blob: typeof sourceBlobs.$inferSelect) => {
    if (blob.storage !== store.kind || !blob.objectKey) return undefined;
    // The application is the only writer and deleter for source objects, and
    // pruning never removes a referenced ready row. Trust a recent successful
    // verification so a large repository sync does not make one provider
    // request and one database write for every unchanged file on every run.
    if (readyBlobIsUsable(blob, store.kind)) return blob;
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
      .set(uploadClaim())
      .where(and(eq(sourceBlobs.id, id), eq(sourceBlobs.state, "ready")))
      .returning();
    return claimed;
  };
  /** Claims the digest for this call when no row holds it yet. */
  const insertUploadClaim = async () => {
    const [inserted] = await db
      .insert(sourceBlobs)
      .values({
        ...uploadClaim(),
        workspaceId: input.workspaceId,
        digest,
      })
      .onConflictDoNothing({
        target: [sourceBlobs.workspaceId, sourceBlobs.digest],
      })
      .returning();
    return inserted;
  };
  /** Claims a row whose upload failed or whose lease its writer let expire. */
  const claimAbandonedBlob = async (id: string) => {
    const [reclaimed] = await db
      .update(sourceBlobs)
      .set(uploadClaim())
      .where(
        and(
          eq(sourceBlobs.id, id),
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
    return reclaimed;
  };
  const prefetched = input.knownBlobs?.get(digest);
  // Only the branch that already trusts a recent verification reads a row it
  // did not just fetch. Every claim below still writes against the database's
  // own view, so a prefetched row cannot decide a race.
  if (prefetched && readyBlobIsUsable(prefetched, store.kind))
    return prefetched;
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

  if (!claimed) claimed = await insertUploadClaim();
  if (!claimed) {
    // Repeated content is ordinary rather than exceptional: one pull request
    // carries the same generated or empty file twice, and two pull requests of
    // one workspace share whole directories. Losing the race says only that
    // another call is already writing the very object this one would write, so
    // this waits for that object instead of refusing. Giving up here spends a
    // whole synchronization on a duplicate file.
    const deadline = Date.now() + CONCURRENT_UPLOAD_WAIT_MILLISECONDS;
    for (;;) {
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
      if (!claimed) {
        // A row collected between the conflict and this read leaves the digest
        // unheld again, and the insert that lost is the way back to holding it.
        claimed = raced
          ? await claimAbandonedBlob(raced.id)
          : await insertUploadClaim();
      }
      if (claimed) break;
      if (Date.now() >= deadline) {
        throw new Error("A concurrent source upload is still in progress");
      }
      await delay(CONCURRENT_UPLOAD_POLL_MILLISECONDS);
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
      // The lease is gone, so someone else holds this digest now. A store that
      // can name a key before the write derives it from the content, and that
      // writer therefore stored the very object this call did: removing it
      // would leave a ready row naming nothing. Only an object no row can
      // reach is this call's to remove, and pruning collects whatever is left.
      const holder = await db.query.sourceBlobs.findFirst({
        where: and(
          eq(sourceBlobs.workspaceId, input.workspaceId),
          eq(sourceBlobs.digest, digest),
        ),
      });
      const reachable =
        holder &&
        (holder.objectKey === stored.objectKey ||
          store.customId?.(putInput) === stored.objectKey);
      if (!reachable) await store.delete(stored.objectKey);
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
