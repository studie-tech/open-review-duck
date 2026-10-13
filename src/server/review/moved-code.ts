import "server-only";

import { and, eq } from "drizzle-orm";
import { reviewUnits, snapshotFiles } from "@/drizzle/schema";
import { movedCodeRanges } from "~/lib/moved-code";
import type { db as database } from "~/server/db";
import { hydrateReviewUnits } from "~/server/storage/review-units";

/** Reads immutable file contexts with bounded source concurrency and returns only ranges. */
export async function snapshotMovedCode(
  db: typeof database,
  snapshotId: string,
) {
  const [contexts, files] = await Promise.all([
    db.query.reviewUnits.findMany({
      where: and(
        eq(reviewUnits.snapshotId, snapshotId),
        eq(reviewUnits.kind, "file"),
      ),
    }),
    db.query.snapshotFiles.findMany({
      where: eq(snapshotFiles.snapshotId, snapshotId),
      columns: {
        path: true,
        previousPath: true,
        isBinary: true,
        skipReason: true,
        changeType: true,
      },
    }),
  ]);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const available = contexts.filter((context) => {
    const file = byPath.get(context.path);
    return (
      file &&
      !file.isBinary &&
      !file.skipReason &&
      (context.currentBlobId || context.previousBlobId)
    );
  });
  const sources = [];
  // Each batch loads at most sixteen objects, without an unbounded read wave.
  for (let offset = 0; offset < available.length; offset += 8) {
    const hydrated = await hydrateReviewUnits(
      db,
      available.slice(offset, offset + 8),
    );
    sources.push(
      ...hydrated.map((context) => ({
        path: context.path,
        previousPath: byPath.get(context.path)?.previousPath,
        previousSource:
          context.previousSource ??
          (context.changeType === "deleted" ? context.source : ""),
        currentSource:
          byPath.get(context.path)?.changeType === "deleted"
            ? ""
            : context.source,
      })),
    );
  }
  return movedCodeRanges(sources);
}
