import { NextResponse } from "next/server";
import { env } from "~/env";
import { db } from "~/server/db";
import { hasBearerToken } from "~/server/security/bearer-token";
import { pruneExpiredRateLimits } from "~/server/security/rate-limit";
import { pruneOrphanSourceBlobs } from "~/server/storage/source-blobs";
import { pruneExpiredReviewSnapshots } from "~/server/sync/retention";

/** Performs authenticated local retention for the appliance maintenance loop. */
export async function POST(request: Request) {
  if (!hasBearerToken(request.headers.get("authorization"), env.CRON_SECRET)) {
    return new NextResponse(null, { status: 404 });
  }
  const [snapshots, rateLimits, sourceObjects] = await Promise.all([
    pruneExpiredReviewSnapshots(db),
    pruneExpiredRateLimits(db),
    pruneOrphanSourceBlobs(db),
  ]);
  return NextResponse.json({ snapshots, rateLimits, sourceObjects });
}
