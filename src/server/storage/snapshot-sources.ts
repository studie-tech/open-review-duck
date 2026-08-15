import "server-only";

import { desc, eq, inArray } from "drizzle-orm";
import { reviewSnapshots, reviewUnits, sourceBlobs } from "@/drizzle/schema";
import { mapWithLimit } from "~/lib/concurrency";
import type { db as database } from "~/server/db";
import { sourceObjectStore } from "./index";

type Database = typeof database;

// A prepared pull request can reference hundreds of blobs. Presence checks are
// one-byte reads, so a wider bound keeps unchanged-revision polls responsive
// without transferring source bodies or opening an unbounded request wave.
const SOURCE_OBJECT_PROBE_CONCURRENCY = 12;

/** Checks that every source object needed to render a snapshot is still present. */
export async function reviewSnapshotSourcesAvailable(
  db: Database,
  snapshotId: string,
) {
  const units = await db.query.reviewUnits.findMany({
    where: eq(reviewUnits.snapshotId, snapshotId),
    columns: { currentBlobId: true, previousBlobId: true },
  });
  const blobIds = [
    ...new Set(
      units.flatMap((unit) =>
        [unit.currentBlobId, unit.previousBlobId].filter((id): id is string =>
          Boolean(id),
        ),
      ),
    ),
  ];
  if (blobIds.length === 0) return units.length === 0;

  const blobs = await db.query.sourceBlobs.findMany({
    where: inArray(sourceBlobs.id, blobIds),
  });
  if (blobs.length !== blobIds.length) return false;
  const store = await sourceObjectStore();
  let available = true;
  // Each worker rereads the verdict before spending a round trip, so the first
  // missing object retires the probes still queued behind it.
  await mapWithLimit(blobs, SOURCE_OBJECT_PROBE_CONCURRENCY, async (blob) => {
    if (!available) return;
    if (
      blob.state !== "ready" ||
      blob.storage !== store.kind ||
      !blob.objectKey
    ) {
      available = false;
      return;
    }
    if (!store.exists) return;
    try {
      if (!(await store.exists(blob.objectKey))) available = false;
    } catch {
      available = false;
    }
  });
  return available;
}

/** Checks the newest snapshot for one pull request before queue assignment. */
export async function pullRequestSnapshotSourcesAvailable(
  db: Database,
  pullRequestId: string,
) {
  const snapshot = await db.query.reviewSnapshots.findFirst({
    where: eq(reviewSnapshots.pullRequestId, pullRequestId),
    orderBy: [desc(reviewSnapshots.version)],
    columns: { id: true },
  });
  return snapshot ? reviewSnapshotSourcesAvailable(db, snapshot.id) : false;
}
