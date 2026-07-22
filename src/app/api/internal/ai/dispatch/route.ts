import { type NextRequest, NextResponse } from "next/server";
import { drainAiDispatches } from "~/server/ai/service";
import { db } from "~/server/db";
import { authorizedInternalRequest } from "~/server/internal-auth";

/** Resumes durable AI outbox work after deployments or process restarts. */
export async function POST(request: NextRequest) {
  if (!authorizedInternalRequest(request))
    return new NextResponse(null, { status: 404 });
  return NextResponse.json({ dispatched: await drainAiDispatches(db) });
}

export const GET = POST;
