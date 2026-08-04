import { NextResponse } from "next/server";
import { env } from "~/env";
import { pruneExpiredAiStreamLeases } from "~/server/ai/stream-leases";
import { db } from "~/server/db";
import { hasBearerToken } from "~/server/security/bearer-token";
import { pruneExpiredRateLimits } from "~/server/security/rate-limit";
import { pruneAllOrphanSourceBlobs } from "~/server/storage/source-blobs";
import { pruneExpiredReviewSnapshots } from "~/server/sync/retention";

/** Performs authenticated local retention for the appliance maintenance loop. */
export async function POST(request: Request) {
  if (!hasBearerToken(request.headers.get("authorization"), env.CRON_SECRET)) {
    return new NextResponse(null, { status: 404 });
  }
  const snapshots = await pruneExpiredReviewSnapshots(db);
  const [rateLimits, streamLeases, sourceObjects] = await Promise.all([
    pruneExpiredRateLimits(db),
    pruneExpiredAiStreamLeases(db),
    pruneAllOrphanSourceBlobs(db),
  ]);
  return NextResponse.json({
    snapshots,
    rateLimits,
    streamLeases,
    sourceObjects,
  });
}
