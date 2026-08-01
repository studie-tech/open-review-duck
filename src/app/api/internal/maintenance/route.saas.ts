import { type NextRequest, NextResponse } from "next/server";
import { env } from "~/env";
import { synchronizeOpenRouterCatalog } from "~/server/ai/catalog";
import { db } from "~/server/db";
import { hasBearerToken } from "~/server/security/bearer-token";
import { pruneExpiredRateLimits } from "~/server/security/rate-limit";
import { pruneOrphanSourceBlobs } from "~/server/storage/source-blobs";
import { pruneExpiredReviewSnapshots } from "~/server/sync/retention";

/** Enforces source-retention and limiter cleanup independently of user traffic. */
export async function POST(request: NextRequest) {
  const authorized = hasBearerToken(
    request.headers.get("authorization"),
    env.CRON_SECRET,
  );
  if (!authorized) return new NextResponse(null, { status: 404 });
  const [snapshots, rateLimits, sourceObjects, modelCatalog] =
    await Promise.all([
      pruneExpiredReviewSnapshots(db),
      pruneExpiredRateLimits(db),
      pruneOrphanSourceBlobs(db),
      synchronizeOpenRouterCatalog(db),
    ]);
  return NextResponse.json({
    snapshots,
    rateLimits,
    sourceObjects,
    modelCatalog,
  });
}

export const GET = POST;
