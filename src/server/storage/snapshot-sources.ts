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

/** Finds which pull requests can no longer render their newest snapshot. */
export async function pullRequestsMissingSnapshotSources(
  db: Database,
  pullRequestIds: string[],
) {
  const missing = new Set(pullRequestIds);
  if (missing.size === 0) return missing;

  const snapshots = await db
    .selectDistinctOn([reviewSnapshots.pullRequestId], {
      id: reviewSnapshots.id,
      pullRequestId: reviewSnapshots.pullRequestId,
    })
    .from(reviewSnapshots)
    .where(inArray(reviewSnapshots.pullRequestId, [...missing]))
    .orderBy(reviewSnapshots.pullRequestId, desc(reviewSnapshots.version));
  if (snapshots.length === 0) return missing;

  const units = await db.query.reviewUnits.findMany({
    where: inArray(
      reviewUnits.snapshotId,
      snapshots.map((snapshot) => snapshot.id),
    ),
    columns: { snapshotId: true, currentBlobId: true, previousBlobId: true },
  });
  const snapshotEntries = new Map(
    snapshots.map((snapshot) => [
      snapshot.id,
      {
        pullRequestId: snapshot.pullRequestId,
        unitCount: 0,
        blobIds: new Set<string>(),
      },
    ]),
  );
  for (const unit of units) {
    const entry = snapshotEntries.get(unit.snapshotId);
    if (!entry) continue;
    entry.unitCount += 1;
    if (unit.currentBlobId) entry.blobIds.add(unit.currentBlobId);
    if (unit.previousBlobId) entry.blobIds.add(unit.previousBlobId);
  }

  const referencedBlobIds = new Set(
    [...snapshotEntries.values()].flatMap((entry) => [...entry.blobIds]),
  );
  const blobs =
    referencedBlobIds.size === 0
      ? []
      : await db.query.sourceBlobs.findMany({
          where: inArray(sourceBlobs.id, [...referencedBlobIds]),
        });
  const store = await sourceObjectStore();
  const objectKeyByBlobId = new Map(
    blobs.flatMap((blob) =>
      blob.state === "ready" && blob.storage === store.kind && blob.objectKey
        ? [[blob.id, blob.objectKey] as const]
        : [],
    ),
  );

  const pending: { pullRequestId: string; objectKeys: string[] }[] = [];
  for (const entry of snapshotEntries.values()) {
    if (entry.unitCount === 0) {
      missing.delete(entry.pullRequestId);
      continue;
    }
    const objectKeys = [...entry.blobIds].flatMap((blobId) => {
      const objectKey = objectKeyByBlobId.get(blobId);
      return objectKey ? [objectKey] : [];
    });
    if (objectKeys.length !== entry.blobIds.size || objectKeys.length === 0) {
      continue;
    }
    pending.push({ pullRequestId: entry.pullRequestId, objectKeys });
  }

  // Blobs are content-addressed and shared between snapshots, so one probe per
  // distinct object settles every pull request that references it.
  const probeKeys = [...new Set(pending.flatMap((entry) => entry.objectKeys))];
  const presentObjectKeys = new Set(probeKeys);
  const probe = store.exists?.bind(store);
  if (probe) {
    await mapWithLimit(
      probeKeys,
      SOURCE_OBJECT_PROBE_CONCURRENCY,
      async (objectKey) => {
        // A probe answers false only for a proven absence and throws
        // otherwise, so an outage leaves the object's verdict alone rather
        // than scheduling a repair sync for every snapshot that names it.
        if (!(await probe(objectKey).catch(() => true))) {
          presentObjectKeys.delete(objectKey);
        }
      },
    );
  }
  for (const entry of pending) {
    if (entry.objectKeys.every((key) => presentObjectKeys.has(key))) {
      missing.delete(entry.pullRequestId);
    }
  }
  return missing;
}
