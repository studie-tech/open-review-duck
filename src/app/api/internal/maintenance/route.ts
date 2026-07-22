import { type NextRequest, NextResponse } from "next/server";
import { db } from "~/server/db";
import { authorizedInternalRequest } from "~/server/internal-auth";
import { pruneExpiredRateLimits } from "~/server/security/rate-limit";
import { pruneExpiredReviewSnapshots } from "~/server/sync/retention";

/** Enforces source-retention and limiter cleanup independently of user traffic. */
export async function POST(request: NextRequest) {
  if (!authorizedInternalRequest(request))
    return new NextResponse(null, { status: 404 });
  const [snapshots, rateLimits] = await Promise.all([
    pruneExpiredReviewSnapshots(db),
    pruneExpiredRateLimits(db),
  ]);
  return NextResponse.json({ snapshots, rateLimits });
}

export const GET = POST;
