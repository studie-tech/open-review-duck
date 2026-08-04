import { type NextRequest, NextResponse } from "next/server";
import { env } from "~/env";
import { synchronizeOpenRouterCatalog } from "~/server/ai/catalog";
import { db } from "~/server/db";
import { pruneExpiredProviderSecurityRecords } from "~/server/providers/maintenance";
import { hasBearerToken } from "~/server/security/bearer-token";
import { pruneExpiredRateLimits } from "~/server/security/rate-limit";
import { pruneAllOrphanSourceBlobs } from "~/server/storage/source-blobs";
import { pruneExpiredReviewSnapshots } from "~/server/sync/retention";

/** Enforces source-retention and limiter cleanup independently of user traffic. */
export async function POST(request: NextRequest) {
  const authorized = hasBearerToken(
    request.headers.get("authorization"),
    env.CRON_SECRET,
  );
  if (!authorized) return new NextResponse(null, { status: 404 });
  const snapshots = await pruneExpiredReviewSnapshots(db);
  const [rateLimits, sourceObjects, modelCatalog, providerSecurity] =
    await Promise.all([
      pruneExpiredRateLimits(db),
      pruneAllOrphanSourceBlobs(db),
      synchronizeOpenRouterCatalog(db),
      pruneExpiredProviderSecurityRecords(db),
    ]);
  return NextResponse.json({
    snapshots,
    rateLimits,
    sourceObjects,
    modelCatalog,
    providerSecurity,
  });
}

export const GET = POST;
