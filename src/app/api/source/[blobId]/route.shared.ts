import { and, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  pullRequests,
  repositories,
  reviewSnapshots,
  snapshotFiles,
  sourceBlobs,
  workspaceMembers,
} from "@/drizzle/schema";
import { applicationAuth } from "~/server/auth";
import { db } from "~/server/db";
import { isLocalDeployment } from "~/server/deployment";
import { sourceObjectStore } from "~/server/storage";
import { readSourceBlob } from "~/server/storage/source-blobs";

export const dynamic = "force-dynamic";

/** Returns an authorized local object or a short-lived private CDN URL. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ blobId: string }> },
) {
  const authentication = await applicationAuth();
  if (!authentication.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { blobId } = await params;
  const url = new URL(request.url);
  const snapshotId = url.searchParams.get("snapshotId");
  const sourcePath = url.searchParams.get("path");
  if (!snapshotId || !sourcePath) {
    return NextResponse.json(
      { error: "Revision and source path are required" },
      { status: 400 },
    );
  }
  const [blob] = await db
    .select({ blob: sourceBlobs })
    .from(sourceBlobs)
    .innerJoin(
      snapshotFiles,
      or(
        eq(snapshotFiles.currentBlobId, sourceBlobs.id),
        eq(snapshotFiles.previousBlobId, sourceBlobs.id),
      ),
    )
    .innerJoin(
      reviewSnapshots,
      eq(snapshotFiles.snapshotId, reviewSnapshots.id),
    )
    .innerJoin(pullRequests, eq(reviewSnapshots.pullRequestId, pullRequests.id))
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .innerJoin(
      workspaceMembers,
      eq(repositories.workspaceId, workspaceMembers.workspaceId),
    )
    .where(
      and(
        eq(sourceBlobs.id, blobId),
        eq(reviewSnapshots.id, snapshotId),
        eq(snapshotFiles.path, sourcePath),
        eq(sourceBlobs.workspaceId, repositories.workspaceId),
        eq(workspaceMembers.userId, authentication.userId),
      ),
    )
    .limit(1);
  if (blob?.blob.state !== "ready" || !blob.blob.objectKey) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (isLocalDeployment()) {
    const bytes = await readSourceBlob(blob.blob);
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": blob.blob.mediaType,
        Digest: `sha-256=${Buffer.from(blob.blob.digest, "hex").toString("base64")}`,
      },
    });
  }
  const access = await (await sourceObjectStore()).createReadAccess(
    blob.blob.objectKey,
    60,
  );
  return NextResponse.json(
    {
      digest: blob.blob.digest,
      expiresAt: access.expiresAt.toISOString(),
      signedUrl: access.url,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
