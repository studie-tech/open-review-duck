import { type NextRequest, NextResponse } from "next/server";
import { env } from "~/env";
import { synchronizeOpenRouterCatalog } from "~/server/ai/catalog";
import { pruneExpiredAiStreamLeases } from "~/server/ai/stream-leases";
import { db } from "~/server/db";
import { settleMaintenanceTasks } from "~/server/maintenance-results";
import { pruneExpiredProviderSecurityRecords } from "~/server/providers/maintenance";
import {
  REPOSITORY_RECONCILE_INTERVAL_MS,
  reconcileRepositoryBranchMonitors,
} from "~/server/repo-reviews/reconcile";
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
  const deadline = Date.now() + 60_000;
  const outcome = await settleMaintenanceTasks({
    repositoryBranches: () =>
      reconcileRepositoryBranchMonitors(db, {
        staleBefore: new Date(Date.now() - REPOSITORY_RECONCILE_INTERVAL_MS),
        deadline,
      }),
    snapshots: () => pruneExpiredReviewSnapshots(db, undefined, deadline),
    rateLimits: () => pruneExpiredRateLimits(db),
    streamLeases: () => pruneExpiredAiStreamLeases(db),
    sourceObjects: () => pruneAllOrphanSourceBlobs(db),
    modelCatalog: () => synchronizeOpenRouterCatalog(db),
    providerSecurity: () => pruneExpiredProviderSecurityRecords(db),
  });
  return NextResponse.json(outcome.results, {
    status: outcome.failed ? 500 : 200,
  });
}

export const GET = POST;
