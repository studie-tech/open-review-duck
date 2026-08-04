import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { verify } from "@node-rs/argon2";
import { and, desc, eq, isNull } from "drizzle-orm";
import { repositories, semanticUploadCredentials } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { enforceRateLimit } from "~/server/security/rate-limit";

type Database = typeof database;
const CREDENTIAL_TOKEN =
  /^(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[A-Za-z0-9_-]{32,}$/i;
const LEGACY_CREDENTIAL_TOKEN = /^[A-Za-z0-9_-]{64}$/;

/** Hashes the proxy-provided client address before using it as limiter state. */
export function semanticUploadCallerKey(headers: Headers) {
  const address =
    headers.get("x-forwarded-for")?.split(",").at(0)?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    "unknown";
  return createHash("sha256").update(address).digest("hex").slice(0, 32);
}

/** Creates a lookup-addressable bearer token while keeping its secret random. */
export function newSemanticUploadCredential() {
  const id = randomUUID();
  return { id, token: `${id}.${randomBytes(48).toString("base64url")}` };
}

/** Resolves and verifies one repository credential, with a legacy-token fallback. */
export async function authorizeSemanticUploadCredential(
  db: Database,
  repositoryId: string,
  token: string,
  callerKey: string,
) {
  const repository = await db.query.repositories.findFirst({
    columns: { id: true },
    where: eq(repositories.id, repositoryId),
  });
  if (!repository) return undefined;
  const credentialId = CREDENTIAL_TOKEN.exec(token)?.groups?.id;
  if (!credentialId && !LEGACY_CREDENTIAL_TOKEN.test(token)) {
    await enforceRateLimit(db, `scip-upload-invalid:${callerKey}`, 10, 60_000);
    return undefined;
  }
  if (!credentialId) {
    await enforceRateLimit(db, `scip-upload-legacy:${callerKey}`, 10, 60_000);
  }
  await enforceRateLimit(db, `scip-upload:${repositoryId}`, 30, 60_000);
  const credentials = await db
    .select({
      id: semanticUploadCredentials.id,
      tokenHash: semanticUploadCredentials.tokenHash,
      workspaceId: repositories.workspaceId,
      revokedAt: semanticUploadCredentials.revokedAt,
    })
    .from(semanticUploadCredentials)
    .innerJoin(
      repositories,
      eq(semanticUploadCredentials.repositoryId, repositories.id),
    )
    .where(
      and(
        eq(semanticUploadCredentials.repositoryId, repositoryId),
        isNull(semanticUploadCredentials.revokedAt),
        credentialId
          ? eq(semanticUploadCredentials.id, credentialId)
          : undefined,
      ),
    )
    .orderBy(desc(semanticUploadCredentials.createdAt))
    .limit(credentialId ? 1 : 20);
  for (const credential of credentials) {
    if (await verify(credential.tokenHash, token)) return credential;
  }
  return undefined;
}
