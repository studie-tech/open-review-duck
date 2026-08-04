import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  repositories,
  semanticArtifacts,
  semanticUploadCredentials,
  workspaceMembers,
} from "@/drizzle/schema";
import { applicationAuth } from "~/server/auth";
import { db } from "~/server/db";
import { parseScipIndex } from "~/server/semantic/scip";
import {
  authorizeSemanticUploadCredential,
  semanticUploadCallerKey,
} from "~/server/semantic/upload-credentials";
import { persistSourceBlob, sourceDigest } from "~/server/storage/source-blobs";

/** Stores an exact-revision SCIP artifact directly in the local appliance. */
export async function POST(request: Request) {
  const authentication = await applicationAuth();
  const repositoryId = request.headers.get("x-reviewduck-repository");
  const commitSha = request.headers.get("x-reviewduck-commit");
  const declaredDigest = request.headers
    .get("digest")
    ?.replace(/^sha-256=/, "");
  if (
    !repositoryId ||
    !commitSha?.match(/^[a-f0-9]{40,64}$/i) ||
    !declaredDigest?.match(/^[a-f0-9]{64}$/i)
  ) {
    return NextResponse.json(
      { error: "Invalid artifact identity" },
      { status: 400 },
    );
  }
  const [repository] = await db
    .select({ id: repositories.id, workspaceId: repositories.workspaceId })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  if (!repository)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const member = authentication.userId
    ? await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, repository.workspaceId),
          eq(workspaceMembers.userId, authentication.userId),
        ),
      })
    : undefined;
  const bearer = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");
  let usedCredential: Awaited<
    ReturnType<typeof authorizeSemanticUploadCredential>
  >;
  try {
    usedCredential =
      bearer && !member
        ? await authorizeSemanticUploadCredential(
            db,
            repository.id,
            bearer,
            semanticUploadCallerKey(request.headers),
          )
        : undefined;
  } catch (cause) {
    if (cause instanceof TRPCError && cause.code === "TOO_MANY_REQUESTS") {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }
    throw cause;
  }
  if (!member && !usedCredential) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > 64 * 1024 * 1024
  ) {
    return NextResponse.json(
      { error: "Artifact size is invalid" },
      { status: 413 },
    );
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (
    bytes.byteLength !== contentLength ||
    sourceDigest(bytes) !== declaredDigest
  ) {
    return NextResponse.json(
      { error: "Artifact size or digest mismatch" },
      { status: 400 },
    );
  }
  let semanticIndex: ReturnType<typeof parseScipIndex>;
  try {
    semanticIndex = parseScipIndex(bytes);
  } catch (cause) {
    return NextResponse.json(
      {
        error:
          cause instanceof Error ? cause.message : "Malformed SCIP artifact",
      },
      { status: 400 },
    );
  }
  const blob = await persistSourceBlob(db, {
    workspaceId: repository.workspaceId,
    bytes,
    encoding: "binary",
    mediaType: "application/scip",
  });
  const [artifact] = await db
    .insert(semanticArtifacts)
    .values({
      workspaceId: repository.workspaceId,
      repositoryId: repository.id,
      commitSha,
      digest: declaredDigest,
      sourceBlobId: blob.id,
      status: "ready",
      byteLength: bytes.byteLength,
      validatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [semanticArtifacts.repositoryId, semanticArtifacts.commitSha],
      set: {
        digest: declaredDigest,
        sourceBlobId: blob.id,
        status: "ready",
        byteLength: bytes.byteLength,
        validatedAt: new Date(),
      },
    })
    .returning();
  if (usedCredential) {
    await db
      .update(semanticUploadCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(semanticUploadCredentials.id, usedCredential.id));
  }
  return NextResponse.json({
    artifactId: artifact?.id,
    accepted: true,
    documents: semanticIndex.documentCount,
    occurrences: semanticIndex.occurrenceCount,
  });
}
