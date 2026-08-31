import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  providerConnections,
  pullRequests,
  repositories,
  reviewSnapshots,
  reviewUnits,
  workspaceMembers,
} from "@/drizzle/schema";
import {
  isPreviewableReviewImage,
  REVIEW_IMAGE_PREVIEW_MAXIMUM_BYTES,
  reviewImageMediaType,
} from "~/lib/review-images";
import { applicationAuth } from "~/server/auth";
import { db } from "~/server/db";
import { providerForConnection } from "~/server/providers/credentials";

export const dynamic = "force-dynamic";

/** Returns the image bytes for one authorized binary review unit. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ unitId: string }> },
) {
  const authentication = await applicationAuth();
  if (!authentication.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { unitId } = await params;
  const [scope] = await db
    .select({
      path: reviewUnits.path,
      changeType: reviewUnits.changeType,
      headSha: reviewSnapshots.headSha,
      baseSha: reviewSnapshots.baseSha,
      repositoryExternalId: repositories.externalId,
      connection: providerConnections,
    })
    .from(reviewUnits)
    .innerJoin(reviewSnapshots, eq(reviewUnits.snapshotId, reviewSnapshots.id))
    .innerJoin(pullRequests, eq(reviewSnapshots.pullRequestId, pullRequests.id))
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .innerJoin(
      providerConnections,
      eq(repositories.connectionId, providerConnections.id),
    )
    .innerJoin(
      workspaceMembers,
      eq(repositories.workspaceId, workspaceMembers.workspaceId),
    )
    .where(
      and(
        eq(reviewUnits.id, unitId),
        eq(workspaceMembers.userId, authentication.userId),
      ),
    )
    .limit(1);
  if (!scope || !isPreviewableReviewImage(scope.path)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const provider = await providerForConnection(db, scope.connection);
  const ref = scope.changeType === "deleted" ? scope.baseSha : scope.headSha;
  const bytes = await provider.getFileBytes(
    scope.repositoryExternalId,
    scope.path,
    ref,
    REVIEW_IMAGE_PREVIEW_MAXIMUM_BYTES,
  );
  const mediaType = bytes ? reviewImageMediaType(scope.path, bytes) : undefined;
  if (!bytes || !mediaType) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Cache-Control": "private, max-age=300",
      "Content-Type": mediaType,
    },
  });
}
