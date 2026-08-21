import { NextResponse } from "next/server";
import { env } from "~/env";
import { pruneExpiredAiStreamLeases } from "~/server/ai/stream-leases";
import { db } from "~/server/db";
import { settleMaintenanceTasks } from "~/server/maintenance-results";
import {
  REPOSITORY_RECONCILE_INTERVAL_MS,
  reconcileRepositoryBranchMonitors,
} from "~/server/repo-reviews/reconcile";
import { hasBearerToken } from "~/server/security/bearer-token";
import { pruneExpiredRateLimits } from "~/server/security/rate-limit";
import { pruneAllOrphanSourceBlobs } from "~/server/storage/source-blobs";
import { pruneExpiredReviewSnapshots } from "~/server/sync/retention";

/** Performs authenticated local retention for the appliance maintenance loop. */
export async function POST(request: Request) {
  if (!hasBearerToken(request.headers.get("authorization"), env.CRON_SECRET)) {
    return new NextResponse(null, { status: 404 });
  }
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
  });
  return NextResponse.json(outcome.results, {
    status: outcome.failed ? 500 : 200,
  });
}
