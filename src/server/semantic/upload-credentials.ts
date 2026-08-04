import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { verify } from "@node-rs/argon2";
import { and, desc, eq, isNull } from "drizzle-orm";
import { repositories, semanticUploadCredentials } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { enforceRateLimit } from "~/server/security/rate-limit";

type Database = typeof database;
const CREDENTIAL_TOKEN =
  /^(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[A-Za-z0-9_-]{32,}$/i;

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
) {
  await enforceRateLimit(db, `scip-upload:${repositoryId}`, 30, 60_000);
  const credentialId = CREDENTIAL_TOKEN.exec(token)?.groups?.id;
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
