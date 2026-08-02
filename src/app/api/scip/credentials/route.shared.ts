import { randomBytes } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  repositories,
  semanticUploadCredentials,
  workspaceMembers,
} from "@/drizzle/schema";
import { applicationAuth } from "~/server/auth";
import { db } from "~/server/db";

/** Issues one repository-scoped SCIP upload capability and stores only its hash. */
export async function POST(request: Request) {
  const authentication = await applicationAuth();
  if (!authentication.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json()) as {
    repositoryId?: unknown;
    label?: unknown;
  };
  if (
    typeof body.repositoryId !== "string" ||
    typeof body.label !== "string" ||
    body.label.length < 1 ||
    body.label.length > 160
  ) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const [repository] = await db
    .select({ id: repositories.id, role: workspaceMembers.role })
    .from(repositories)
    .innerJoin(
      workspaceMembers,
      eq(repositories.workspaceId, workspaceMembers.workspaceId),
    )
    .where(
      and(
        eq(repositories.id, body.repositoryId),
        eq(workspaceMembers.userId, authentication.userId),
      ),
    )
    .limit(1);
  if (!repository)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!["owner", "admin"].includes(repository.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const token = randomBytes(48).toString("base64url");
  const [credential] = await db
    .insert(semanticUploadCredentials)
    .values({
      repositoryId: repository.id,
      label: body.label,
      tokenHash: await hash(token, {
        algorithm: 2,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      }),
    })
    .returning({ id: semanticUploadCredentials.id });
  return NextResponse.json(
    { id: credential?.id, token },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}

/** Revokes one repository-scoped SCIP upload capability. */
export async function DELETE(request: Request) {
  const authentication = await applicationAuth();
  if (!authentication.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const credentialId = new URL(request.url).searchParams.get("credentialId");
  if (!credentialId?.match(/^[0-9a-f-]{36}$/i)) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const [credential] = await db
    .select({
      id: semanticUploadCredentials.id,
      role: workspaceMembers.role,
    })
    .from(semanticUploadCredentials)
    .innerJoin(
      repositories,
      eq(semanticUploadCredentials.repositoryId, repositories.id),
    )
    .innerJoin(
      workspaceMembers,
      eq(repositories.workspaceId, workspaceMembers.workspaceId),
    )
    .where(
      and(
        eq(semanticUploadCredentials.id, credentialId),
        eq(workspaceMembers.userId, authentication.userId),
      ),
    )
    .limit(1);
  if (!credential)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!["owner", "admin"].includes(credential.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await db
    .update(semanticUploadCredentials)
    .set({ revokedAt: new Date() })
    .where(eq(semanticUploadCredentials.id, credential.id));
  return NextResponse.json({ revoked: true });
}
