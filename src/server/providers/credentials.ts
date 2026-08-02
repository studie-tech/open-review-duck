import "server-only";

import { and, eq, lte, sql } from "drizzle-orm";
import { importPKCS8, SignJWT } from "jose";
import {
  localCredentials,
  oauthCredentials,
  providerConnections,
} from "@/drizzle/schema";
import { env } from "~/env";
import type { db as database } from "~/server/db";
import { isLocalDeployment } from "~/server/deployment";
import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";
import { createProvider } from ".";
import type { PullRequestProvider } from "./types";

type Database = typeof database;

/** Mints a short-lived GitHub App installation token on demand. */
async function githubInstallationToken(installationId: string) {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GitHub App credentials are not configured");
  }
  const key = await importPKCS8(
    env.GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n"),
    "RS256",
  );
  const now = Math.floor(Date.now() / 1_000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(env.GITHUB_APP_ID)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .sign(key);
  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub installation token failed (${response.status})`);
  }
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string") {
    throw new Error("GitHub installation token response is invalid");
  }
  return body.token;
}

/** Opens one local-only provider token from the volume vault. */
async function localToken(
  db: Database,
  connection: typeof providerConnections.$inferSelect,
) {
  if (!connection.localCredentialId) {
    throw new Error("Local provider credential is missing");
  }
  const credential = await db.query.localCredentials.findFirst({
    where: and(
      eq(localCredentials.id, connection.localCredentialId),
      eq(localCredentials.workspaceId, connection.workspaceId),
    ),
  });
  if (!credential) throw new Error("Local provider credential not found");
  const payload = JSON.parse(
    await openVaultSecret(
      {
        workspaceId: connection.workspaceId,
        recordId: credential.id,
        provider: connection.provider,
      },
      credential.encryptedPayload,
    ),
  ) as { token?: unknown };
  if (typeof payload.token !== "string") {
    throw new Error("Local provider credential is invalid");
  }
  return payload.token;
}

/** Returns a valid hosted OAuth token, refreshing it when required. */
async function oauthToken(
  db: Database,
  connection: typeof providerConnections.$inferSelect,
) {
  let credential = await db.query.oauthCredentials.findFirst({
    where: eq(oauthCredentials.connectionId, connection.id),
  });
  if (!credential) throw new Error("OAuth credential not found");
  if (
    credential.expiresAt &&
    credential.expiresAt.getTime() <= Date.now() + 60_000
  ) {
    credential = await refreshOauthToken(db, connection.id);
  }
  return openVaultSecret(
    {
      workspaceId: connection.workspaceId,
      recordId: credential.id,
      provider: `${connection.provider}-oauth-access`,
    },
    credential.encryptedAccessToken,
  );
}

/** Returns a concurrently refreshed credential when another caller won the CAS. */
async function concurrentRefreshWinner(
  db: Database,
  connectionId: string,
  previousVersion: number,
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const credential = await db.query.oauthCredentials.findFirst({
      where: eq(oauthCredentials.connectionId, connectionId),
    });
    if (
      credential &&
      credential.refreshVersion > previousVersion &&
      (!credential.expiresAt ||
        credential.expiresAt.getTime() > Date.now() + 60_000)
    ) {
      return credential;
    }
    if (attempt < 19) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  return undefined;
}

/** Rotates an expiring OAuth credential without holding a DB transaction over I/O. */
async function refreshOauthToken(db: Database, connectionId: string) {
  const [row] = await db
    .select({ connection: providerConnections, credential: oauthCredentials })
    .from(providerConnections)
    .innerJoin(
      oauthCredentials,
      eq(oauthCredentials.connectionId, providerConnections.id),
    )
    .where(eq(providerConnections.id, connectionId))
    .limit(1);
  if (!row) throw new Error("OAuth credential not found");
  if (
    !row.credential.expiresAt ||
    row.credential.expiresAt.getTime() > Date.now() + 60_000
  ) {
    return row.credential;
  }
  if (!row.credential.encryptedRefreshToken) {
    throw new Error("OAuth credential expired without a refresh token");
  }
  const refreshToken = await openVaultSecret(
    {
      workspaceId: row.connection.workspaceId,
      recordId: row.credential.id,
      provider: `${row.connection.provider}-oauth-refresh`,
    },
    row.credential.encryptedRefreshToken,
  );
  const tokenUrl =
    row.connection.provider === "gitlab"
      ? "https://gitlab.com/oauth/token"
      : `https://login.microsoftonline.com/${env.AZURE_ENTRA_TENANT_ID}/oauth2/v2.0/token`;
  const clientId =
    row.connection.provider === "gitlab"
      ? env.GITLAB_CLIENT_ID
      : env.AZURE_ENTRA_CLIENT_ID;
  const clientSecret =
    row.connection.provider === "gitlab"
      ? env.GITLAB_CLIENT_SECRET
      : env.AZURE_ENTRA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("OAuth client credentials are not configured");
  }
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (row.connection.provider === "azure_devops") {
    form.set(
      "scope",
      "499b84ac-1321-427f-aa17-267ca6975798/.default offline_access",
    );
  }
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const winner = await concurrentRefreshWinner(
      db,
      connectionId,
      row.credential.refreshVersion,
    );
    if (winner) return winner;
    throw new Error(`OAuth token refresh failed (${response.status})`);
  }
  const tokens = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (
    typeof tokens.access_token !== "string" ||
    typeof tokens.expires_in !== "number"
  ) {
    throw new Error("OAuth refresh response is invalid");
  }
  const encryptedAccessToken = await sealVaultSecret(
    {
      workspaceId: row.connection.workspaceId,
      recordId: row.credential.id,
      provider: `${row.connection.provider}-oauth-access`,
    },
    tokens.access_token,
  );
  const encryptedRefreshToken =
    typeof tokens.refresh_token === "string"
      ? await sealVaultSecret(
          {
            workspaceId: row.connection.workspaceId,
            recordId: row.credential.id,
            provider: `${row.connection.provider}-oauth-refresh`,
          },
          tokens.refresh_token,
        )
      : row.credential.encryptedRefreshToken;
  const [updated] = await db
    .update(oauthCredentials)
    .set({
      encryptedAccessToken,
      encryptedRefreshToken,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1_000),
      refreshVersion: sql`${oauthCredentials.refreshVersion} + 1`,
    })
    .where(
      and(
        eq(oauthCredentials.id, row.credential.id),
        eq(oauthCredentials.refreshVersion, row.credential.refreshVersion),
        lte(oauthCredentials.expiresAt, new Date(Date.now() + 60_000)),
      ),
    )
    .returning();
  if (updated) return updated;
  const winner = await concurrentRefreshWinner(
    db,
    connectionId,
    row.credential.refreshVersion,
  );
  if (!winner) throw new Error("OAuth refresh race did not settle");
  return winner;
}

/** Resolves a provider client through the target-specific credential adapter. */
export async function providerForConnection(
  db: Database,
  connection: typeof providerConnections.$inferSelect,
): Promise<PullRequestProvider> {
  let token: string;
  if (
    !isLocalDeployment() &&
    connection.provider === "github" &&
    connection.credentialKind === "github_app"
  ) {
    if (!connection.installationId) {
      throw new Error("GitHub App installation identity is missing");
    }
    token = await githubInstallationToken(connection.installationId);
  } else if (connection.credentialKind === "oauth") {
    token = await oauthToken(db, connection);
  } else {
    if (!isLocalDeployment()) {
      throw new Error("PAT credentials are prohibited in SaaS");
    }
    token = await localToken(db, connection);
  }
  return createProvider(
    connection.provider,
    token,
    connection.baseUrl ?? undefined,
    connection.credentialKind,
  );
}
