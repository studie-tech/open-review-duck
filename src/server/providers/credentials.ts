import "server-only";

import { and, eq, sql } from "drizzle-orm";
import {
  credentialAuditEvents,
  localCredentials,
  oauthCredentials,
  providerConnections,
  providerPatCredentials,
} from "@/drizzle/schema";
import { env } from "~/env";
import type { db as database } from "~/server/db";
import { isLocalDeployment } from "~/server/deployment";
import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";
import { createProvider } from ".";
import { githubAppJwt } from "./github-app-authorization";
import { openProviderPat } from "./pat-credential";
import type { PullRequestProvider } from "./types";

type Database = typeof database;

interface GitHubInstallationToken {
  expiresAt: number;
  token: string;
}

const githubInstallationTokens = new Map<
  string,
  Promise<GitHubInstallationToken>
>();

/** Mints one short-lived GitHub App installation token. */
async function mintGitHubInstallationToken(
  installationId: string,
): Promise<GitHubInstallationToken> {
  const jwt = await githubAppJwt({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
  });
  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        permissions: { contents: "read", pull_requests: "write" },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub installation token failed (${response.status})`);
  }
  const body = (await response.json()) as {
    expires_at?: unknown;
    token?: unknown;
  };
  const expiresAt =
    typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
  if (typeof body.token !== "string" || !Number.isFinite(expiresAt)) {
    throw new Error("GitHub installation token response is invalid");
  }
  return { token: body.token, expiresAt };
}

/** Reuses an installation token until shortly before GitHub expires it. */
async function githubInstallationToken(installationId: string) {
  const cached = githubInstallationTokens.get(installationId);
  if (cached) {
    try {
      const token = await cached;
      if (token.expiresAt > Date.now() + 60_000) return token.token;
    } catch {
      // A failed mint is removed below so the next request can recover.
    }
    githubInstallationTokens.delete(installationId);
  }

  const pending = mintGitHubInstallationToken(installationId);
  githubInstallationTokens.set(installationId, pending);
  if (githubInstallationTokens.size > 128) {
    const oldest = githubInstallationTokens.keys().next().value;
    if (oldest && oldest !== installationId) {
      githubInstallationTokens.delete(oldest);
    }
  }
  try {
    return (await pending).token;
  } catch (cause) {
    if (githubInstallationTokens.get(installationId) === pending) {
      githubInstallationTokens.delete(installationId);
    }
    throw cause;
  }
}

/** Uninstalls the service-owned GitHub App before local disconnect completes. */
export async function revokeGitHubInstallation(installationId: string) {
  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}`,
    {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${await githubAppJwt({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY })}`,
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  await response.body?.cancel();
  if (!response.ok && response.status !== 404) {
    throw new Error(`GitHub App uninstall failed (${response.status})`);
  }
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

/** Opens one workspace-bound provider PAT stored by the SaaS credential adapter. */
async function hostedPatToken(
  db: Database,
  connection: typeof providerConnections.$inferSelect,
) {
  const credential = await db.query.providerPatCredentials.findFirst({
    where: eq(providerPatCredentials.connectionId, connection.id),
  });
  if (!credential) throw new Error("Provider PAT credential not found");
  return openProviderPat(
    {
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      provider: connection.provider,
    },
    credential.encryptedToken,
  );
}

/** Returns a valid hosted OAuth token, refreshing it when required. */
async function oauthToken(
  db: Database,
  connection: typeof providerConnections.$inferSelect,
) {
  if (connection.provider !== "gitlab") {
    throw new Error("OAuth credentials are only supported for GitLab");
  }
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

/** Revokes a stored GitLab OAuth grant before its encrypted copy is deleted. */
export async function revokeProviderOAuth(
  db: Database,
  connection: typeof providerConnections.$inferSelect,
) {
  if (
    connection.credentialKind !== "oauth" ||
    connection.provider !== "gitlab"
  ) {
    return;
  }
  if (!env.GITLAB_CLIENT_ID || !env.GITLAB_CLIENT_SECRET) {
    throw new Error("GitLab OAuth client credentials are not configured");
  }
  const credential = await db.query.oauthCredentials.findFirst({
    where: eq(oauthCredentials.connectionId, connection.id),
  });
  if (!credential) return;
  const tokens = [
    await openVaultSecret(
      {
        workspaceId: connection.workspaceId,
        recordId: credential.id,
        provider: "gitlab-oauth-access",
      },
      credential.encryptedAccessToken,
    ),
  ];
  if (credential.encryptedRefreshToken) {
    tokens.push(
      await openVaultSecret(
        {
          workspaceId: connection.workspaceId,
          recordId: credential.id,
          provider: "gitlab-oauth-refresh",
        },
        credential.encryptedRefreshToken,
      ),
    );
  }
  for (const token of tokens) {
    const response = await fetch("https://gitlab.com/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GITLAB_CLIENT_ID,
        client_secret: env.GITLAB_CLIENT_SECRET,
        token,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitLab OAuth revocation failed (${response.status})`);
    }
    await response.body?.cancel();
  }
}

/** Rotates a one-time refresh token under a transaction-scoped provider lock. */
async function refreshOauthToken(db: Database, connectionId: string) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`oauth-refresh:${connectionId}`}, 0))`,
    );
    const [row] = await tx
      .select({ connection: providerConnections, credential: oauthCredentials })
      .from(providerConnections)
      .innerJoin(
        oauthCredentials,
        eq(oauthCredentials.connectionId, providerConnections.id),
      )
      .where(eq(providerConnections.id, connectionId))
      .limit(1);
    if (!row) throw new Error("OAuth credential not found");
    if (row.connection.provider !== "gitlab") {
      throw new Error("OAuth credentials are only supported for GitLab");
    }
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
    const tokenUrl = "https://gitlab.com/oauth/token";
    const clientId = env.GITLAB_CLIENT_ID;
    const clientSecret = env.GITLAB_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("OAuth client credentials are not configured");
    }
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`OAuth token refresh failed (${response.status})`);
    }
    const tokens = (await response.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    };
    if (
      typeof tokens.access_token !== "string" ||
      tokens.access_token.length === 0 ||
      tokens.access_token.length > 65_536 ||
      typeof tokens.expires_in !== "number" ||
      !Number.isFinite(tokens.expires_in) ||
      tokens.expires_in <= 0 ||
      tokens.expires_in > 7 * 86_400 ||
      (tokens.refresh_token !== undefined &&
        (typeof tokens.refresh_token !== "string" ||
          tokens.refresh_token.length === 0 ||
          tokens.refresh_token.length > 65_536)) ||
      typeof tokens.refresh_token !== "string"
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
    const [updated] = await tx
      .update(oauthCredentials)
      .set({
        encryptedAccessToken,
        encryptedRefreshToken,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1_000),
        refreshVersion: sql`${oauthCredentials.refreshVersion} + 1`,
      })
      .where(eq(oauthCredentials.id, row.credential.id))
      .returning();
    if (!updated)
      throw new Error("OAuth credential disappeared during refresh");
    await tx.insert(credentialAuditEvents).values({
      workspaceId: row.connection.workspaceId,
      credentialId: row.connection.id,
      action: "rotated",
      provider: row.connection.provider,
      metadata: { credentialKind: "oauth" },
    });
    return updated;
  });
}

/** Resolves a provider client through the target-specific credential adapter. */
export async function providerForConnection(
  db: Database,
  connection: typeof providerConnections.$inferSelect,
): Promise<PullRequestProvider> {
  if (connection.credentialStatus !== "active") {
    throw new Error(
      `Provider authorization is ${connection.credentialStatus}; reconnect it before continuing`,
    );
  }
  const local = isLocalDeployment();
  if (
    connection.provider === "azure_devops" &&
    connection.credentialKind !== (local ? "local_pat" : "pat")
  ) {
    throw new Error("Azure DevOps connections require a personal access token");
  }
  let token: string;
  if (
    !local &&
    connection.provider === "github" &&
    connection.credentialKind === "github_app"
  ) {
    if (!connection.installationId) {
      throw new Error("GitHub App installation identity is missing");
    }
    token = await githubInstallationToken(connection.installationId);
  } else if (connection.credentialKind === "oauth") {
    token = await oauthToken(db, connection);
  } else if (!local && connection.credentialKind === "pat") {
    token = await hostedPatToken(db, connection);
  } else {
    if (!local) {
      throw new Error("Unsupported SaaS provider credential");
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
