import "server-only";

import { inArray } from "drizzle-orm";
import { sourceBlobs } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { readSourceBlob } from "./source-blobs";

type Database = typeof database;

interface StoredUnit {
  currentBlobId: string | null;
  previousBlobId: string | null;
  startByte: number;
  endByte: number;
  previousStartByte: number | null;
  previousEndByte: number | null;
}

/** Decodes one validated source-object byte range. */
function decodeSlice(bytes: Uint8Array, start: number, end: number) {
  if (start < 0 || end < start || end > bytes.byteLength) {
    throw new Error("Review unit source range is invalid");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(start, end),
  );
}

/** Hydrates private source ranges on the server without exposing object keys. */
export async function hydrateReviewUnits<Unit extends StoredUnit>(
  db: Database,
  units: Unit[],
): Promise<
  Array<
    Unit & {
      blobDigest: string | null;
      source: string;
      previousSource: string | null;
    }
  >
> {
  const blobIds = [
    ...new Set(
      units.flatMap((unit) =>
        [unit.currentBlobId, unit.previousBlobId].filter((id): id is string =>
          Boolean(id),
        ),
      ),
    ),
  ];
  const blobs = blobIds.length
    ? await db.query.sourceBlobs.findMany({
        where: inArray(sourceBlobs.id, blobIds),
      })
    : [];
  const rows = new Map(blobs.map((blob) => [blob.id, blob]));
  const bytes = new Map<string, Uint8Array>();
  await Promise.all(
    blobs.map(async (blob) => {
      bytes.set(blob.id, await readSourceBlob(blob));
    }),
  );
  return units.map((unit) => {
    const currentBytes = unit.currentBlobId
      ? bytes.get(unit.currentBlobId)
      : undefined;
    const previousBytes = unit.previousBlobId
      ? bytes.get(unit.previousBlobId)
      : undefined;
    if (
      unit.currentBlobId &&
      (!rows.has(unit.currentBlobId) || !currentBytes)
    ) {
      throw new Error("Review unit source object is missing");
    }
    if (
      unit.previousBlobId &&
      (!rows.has(unit.previousBlobId) || !previousBytes)
    ) {
      throw new Error("Review unit previous source object is missing");
    }
    return {
      ...unit,
      blobDigest: unit.currentBlobId
        ? (rows.get(unit.currentBlobId)?.digest ?? null)
        : null,
      source: currentBytes
        ? decodeSlice(currentBytes, unit.startByte, unit.endByte)
        : "",
      previousSource:
        previousBytes &&
        unit.previousStartByte !== null &&
        unit.previousEndByte !== null
          ? decodeSlice(
              previousBytes,
              unit.previousStartByte,
              unit.previousEndByte,
            )
          : null,
    };
  });
}
