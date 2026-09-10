import "server-only";

import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import {
  credentialAuditEvents,
  providerConnections,
  userProviderCredentials,
  workspaceMembers,
} from "@/drizzle/schema";
import { env } from "~/env";
import type { PublicationIdentity } from "~/lib/personal-provider-identity";
import { providerLabel } from "~/lib/provider-labels";
import type { db as database } from "~/server/db";
import { isLocalDeployment } from "~/server/deployment";
import { createProvider } from "~/server/providers";
import { providerForConnection } from "~/server/providers/credentials";
import {
  refreshGitHubUserToken,
  revokeGitHubUserToken,
} from "~/server/providers/github-app-authorization";
import type {
  ProviderName,
  PullRequestProvider,
} from "~/server/providers/types";
import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";

type Database = typeof database;
type ProviderConnection = typeof providerConnections.$inferSelect;
type UserProviderCredential = typeof userProviderCredentials.$inferSelect;

const USER_OAUTH_KINDS = new Set(["github_user", "oauth"]);

/** Tells the reviewer they still need to connect a personal provider identity. */
export function missingPersonalProviderMessage(provider: ProviderName) {
  return `Connect your ${providerLabel(provider)} account to post as yourself. Open Settings → Code providers and connect your account.`;
}

/** Tells the reviewer their stored personal authorization is no longer usable. */
export function expiredPersonalProviderMessage(provider: ProviderName) {
  return `Your ${providerLabel(provider)} authorization expired. Reconnect your account in Settings → Code providers.`;
}

/** Reads whether this reviewer asked to post as themselves in this workspace. */
export async function reviewerPublishesAsSelf(
  db: Database,
  workspaceId: string,
  userId: string,
) {
  const membership = await db.query.workspaceMembers.findFirst({
    columns: { publishAsSelf: true },
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId),
    ),
  });
  return membership?.publishAsSelf === true;
}

/** Chooses the identity the reviewer currently wants new provider writes to use. */
export async function preferredPublicationIdentity(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<PublicationIdentity> {
  return (await reviewerPublishesAsSelf(db, workspaceId, userId))
    ? "reviewer"
    : "workspace";
}

/**
 * Resolves a provider client for one publication identity.
 *
 * `workspace` is the shared connection. `reviewer` is the caller's stored
 * personal credential for that connection and fails closed when it is missing.
 */
export async function providerForPublicationIdentity(
  db: Database,
  connection: ProviderConnection,
  userId: string,
  identity: PublicationIdentity,
): Promise<PullRequestProvider> {
  if (identity === "workspace") {
    return providerForConnection(db, connection);
  }
  const token = await userProviderToken(db, connection, userId);
  return createProvider(
    connection.provider,
    token,
    connection.baseUrl ?? undefined,
    personalProviderKind(connection),
  );
}

/**
 * Resolves the provider client one write should use, and names that identity
 * so the ledger can edit or delete with the same credential later.
 *
 * A stored `publishedAs` wins so a comment posted as ReviewDuck is not edited
 * with a user token. New writes follow the reviewer's current preference.
 */
export async function providerForReviewerWrite(
  db: Database,
  connection: ProviderConnection,
  userId: string,
  publishedAs?: string | null,
) {
  const identity: PublicationIdentity =
    publishedAs === "reviewer"
      ? "reviewer"
      : publishedAs === "workspace"
        ? "workspace"
        : await preferredPublicationIdentity(
            db,
            connection.workspaceId,
            userId,
          );
  return {
    provider: await providerForPublicationIdentity(
      db,
      connection,
      userId,
      identity,
    ),
    publishedAs: identity,
  };
}

/** Public fields of one stored personal provider identity. */
export function publicUserProviderCredential(
  credential: Pick<
    UserProviderCredential,
    "connectionId" | "credentialKind" | "displayLogin" | "externalAccountId"
  >,
) {
  return {
    connectionId: credential.connectionId,
    credentialKind: credential.credentialKind,
    displayLogin: credential.displayLogin,
    externalAccountId: credential.externalAccountId,
  };
}

/** Lists the reviewer's personal identities for every workspace connection. */
export async function listUserProviderCredentials(
  db: Database,
  userId: string,
  workspaceId: string,
) {
  return db
    .select({
      connectionId: userProviderCredentials.connectionId,
      credentialKind: userProviderCredentials.credentialKind,
      displayLogin: userProviderCredentials.displayLogin,
      externalAccountId: userProviderCredentials.externalAccountId,
    })
    .from(userProviderCredentials)
    .innerJoin(
      providerConnections,
      eq(userProviderCredentials.connectionId, providerConnections.id),
    )
    .where(
      and(
        eq(userProviderCredentials.userId, userId),
        eq(providerConnections.workspaceId, workspaceId),
      ),
    );
}

/** Verifies a personal PAT against the connection host and stores it. */
export async function savePersonalProviderPat(
  db: Database,
  input: {
    userId: string;
    connection: ProviderConnection;
    accessToken: string;
  },
) {
  const credentialKind = isLocalDeployment() ? "local_pat" : "pat";
  const provider = createProvider(
    input.connection.provider,
    input.accessToken,
    input.connection.baseUrl ?? undefined,
    input.connection.provider === "azure_devops" ? credentialKind : "pat",
  );
  const identity = await provider.getConnectionIdentity();
  return saveUserProviderCredential(db, {
    userId: input.userId,
    connection: input.connection,
    credentialKind,
    accessToken: input.accessToken,
    displayLogin: identity.displayName,
    externalAccountId: identity.externalAccountId,
  });
}

/** Encrypts and upserts one personal provider credential for this reviewer. */
export async function saveUserProviderCredential(
  db: Database,
  input: {
    userId: string;
    connection: ProviderConnection;
    credentialKind: string;
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    displayLogin: string;
    externalAccountId: string;
  },
) {
  const existing = await db.query.userProviderCredentials.findFirst({
    where: and(
      eq(userProviderCredentials.userId, input.userId),
      eq(userProviderCredentials.connectionId, input.connection.id),
    ),
    columns: { id: true },
  });
  const credentialId = existing?.id ?? randomUUID();
  const encryptedAccessToken = await sealUserSecret(
    input.connection,
    credentialId,
    accessVaultProvider(input.connection.provider, input.credentialKind),
    input.accessToken,
  );
  const encryptedRefreshToken = input.refreshToken
    ? await sealUserSecret(
        input.connection,
        credentialId,
        `${input.connection.provider}-user-oauth-refresh`,
        input.refreshToken,
      )
    : null;
  const values = {
    id: credentialId,
    userId: input.userId,
    connectionId: input.connection.id,
    provider: input.connection.provider,
    credentialKind: input.credentialKind,
    encryptedAccessToken,
    encryptedRefreshToken,
    expiresAt:
      input.expiresIn !== undefined
        ? new Date(Date.now() + input.expiresIn * 1_000)
        : null,
    displayLogin: input.displayLogin,
    externalAccountId: input.externalAccountId,
  };
  const [saved] = await db
    .insert(userProviderCredentials)
    .values(values)
    .onConflictDoUpdate({
      target: [
        userProviderCredentials.userId,
        userProviderCredentials.connectionId,
      ],
      set: {
        provider: values.provider,
        credentialKind: values.credentialKind,
        encryptedAccessToken,
        encryptedRefreshToken,
        expiresAt: values.expiresAt,
        displayLogin: values.displayLogin,
        externalAccountId: values.externalAccountId,
        refreshVersion: sql`${userProviderCredentials.refreshVersion} + 1`,
      },
    })
    .returning();
  if (!saved) throw new Error("Could not persist personal provider credential");
  if (saved.id !== credentialId) {
    await db
      .update(userProviderCredentials)
      .set({
        encryptedAccessToken: await sealUserSecret(
          input.connection,
          saved.id,
          accessVaultProvider(input.connection.provider, input.credentialKind),
          input.accessToken,
        ),
        encryptedRefreshToken: input.refreshToken
          ? await sealUserSecret(
              input.connection,
              saved.id,
              `${input.connection.provider}-user-oauth-refresh`,
              input.refreshToken,
            )
          : null,
      })
      .where(eq(userProviderCredentials.id, saved.id));
  }
  await db.insert(credentialAuditEvents).values({
    workspaceId: input.connection.workspaceId,
    actorId: input.userId,
    credentialId: input.connection.id,
    action: existing ? "rotated" : "authorized",
    provider: input.connection.provider,
    metadata: { credentialKind: input.credentialKind, subject: "reviewer" },
  });
  return publicUserProviderCredential(saved);
}

/** Drops one personal credential after optionally revoking it at the provider. */
export async function deleteUserProviderCredential(
  db: Database,
  userId: string,
  connection: ProviderConnection,
) {
  const credential = await db.query.userProviderCredentials.findFirst({
    where: and(
      eq(userProviderCredentials.userId, userId),
      eq(userProviderCredentials.connectionId, connection.id),
    ),
  });
  if (!credential) return;
  await revokeStoredUserCredential(connection, credential);
  await db
    .delete(userProviderCredentials)
    .where(eq(userProviderCredentials.id, credential.id));
  await db.insert(credentialAuditEvents).values({
    workspaceId: connection.workspaceId,
    actorId: userId,
    credentialId: connection.id,
    action: "disconnected",
    provider: connection.provider,
    metadata: {
      credentialKind: credential.credentialKind,
      subject: "reviewer",
    },
  });
}

/** Revokes every personal grant on a workspace connection before it is deleted. */
export async function revokeUserProviderCredentials(
  db: Database,
  connection: ProviderConnection,
) {
  const credentials = await db.query.userProviderCredentials.findMany({
    where: eq(userProviderCredentials.connectionId, connection.id),
  });
  let failures = 0;
  for (const credential of credentials) {
    if (!(await revokeStoredUserCredential(connection, credential))) {
      failures += 1;
    }
  }
  return failures;
}

/** Opens a usable personal access token, refreshing OAuth grants when needed. */
async function userProviderToken(
  db: Database,
  connection: ProviderConnection,
  userId: string,
) {
  let credential = await db.query.userProviderCredentials.findFirst({
    where: and(
      eq(userProviderCredentials.userId, userId),
      eq(userProviderCredentials.connectionId, connection.id),
    ),
  });
  if (!credential) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: missingPersonalProviderMessage(connection.provider),
    });
  }
  if (credentialNeedsRefresh(credential)) {
    try {
      credential = await refreshUserProviderCredential(db, credential.id);
    } catch (cause) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: expiredPersonalProviderMessage(connection.provider),
        cause,
      });
    }
  }
  return openVaultSecret(
    {
      workspaceId: connection.workspaceId,
      recordId: credential.id,
      provider: accessVaultProvider(
        connection.provider,
        credential.credentialKind,
      ),
    },
    credential.encryptedAccessToken,
  );
}

/** Rotates one stored personal OAuth grant under a transaction-scoped lock. */
async function refreshUserProviderCredential(
  db: Database,
  credentialId: string,
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`user-oauth-refresh:${credentialId}`}, 0))`,
    );
    const [row] = await tx
      .select({
        connection: providerConnections,
        credential: userProviderCredentials,
      })
      .from(userProviderCredentials)
      .innerJoin(
        providerConnections,
        eq(userProviderCredentials.connectionId, providerConnections.id),
      )
      .where(eq(userProviderCredentials.id, credentialId))
      .limit(1);
    if (!row) throw new Error("Personal provider credential not found");
    if (!credentialNeedsRefresh(row.credential)) return row.credential;
    if (!row.credential.encryptedRefreshToken) {
      throw new Error(
        "Personal provider credential expired without a refresh token",
      );
    }
    const refreshToken = await openVaultSecret(
      {
        workspaceId: row.connection.workspaceId,
        recordId: row.credential.id,
        provider: `${row.connection.provider}-user-oauth-refresh`,
      },
      row.credential.encryptedRefreshToken,
    );
    const tokens =
      row.credential.credentialKind === "github_user"
        ? await refreshGitHubUserGrant(refreshToken)
        : await refreshGitLabUserGrant(refreshToken);
    const encryptedAccessToken = await sealUserSecret(
      row.connection,
      row.credential.id,
      accessVaultProvider(
        row.connection.provider,
        row.credential.credentialKind,
      ),
      tokens.accessToken,
    );
    const encryptedRefreshToken = tokens.refreshToken
      ? await sealUserSecret(
          row.connection,
          row.credential.id,
          `${row.connection.provider}-user-oauth-refresh`,
          tokens.refreshToken,
        )
      : row.credential.encryptedRefreshToken;
    const [updated] = await tx
      .update(userProviderCredentials)
      .set({
        encryptedAccessToken,
        encryptedRefreshToken,
        expiresAt: new Date(Date.now() + tokens.expiresIn * 1_000),
        refreshVersion: sql`${userProviderCredentials.refreshVersion} + 1`,
      })
      .where(eq(userProviderCredentials.id, row.credential.id))
      .returning();
    if (!updated)
      throw new Error(
        "Personal provider credential disappeared during refresh",
      );
    return updated;
  });
}

/** Exchanges a GitHub user-to-server refresh token. */
async function refreshGitHubUserGrant(refreshToken: string) {
  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) {
    throw new Error("GitHub App credentials are not configured");
  }
  return refreshGitHubUserToken({
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    refreshToken,
  });
}

/** Exchanges a GitLab personal OAuth refresh token. */
async function refreshGitLabUserGrant(refreshToken: string) {
  if (!env.GITLAB_CLIENT_ID || !env.GITLAB_CLIENT_SECRET) {
    throw new Error("GitLab OAuth client is not configured");
  }
  const response = await fetch("https://gitlab.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env.GITLAB_CLIENT_ID,
      client_secret: env.GITLAB_CLIENT_SECRET,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`GitLab user token refresh failed (${response.status})`);
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
    typeof tokens.refresh_token !== "string" ||
    tokens.refresh_token.length === 0 ||
    tokens.refresh_token.length > 65_536
  ) {
    throw new Error("GitLab user token refresh response is invalid");
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
  };
}

/** Revokes one stored personal grant when the provider accepts revocation. */
async function revokeStoredUserCredential(
  connection: ProviderConnection,
  credential: UserProviderCredential,
) {
  if (isLocalDeployment()) return true;
  try {
    if (credential.credentialKind === "github_user") {
      if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) {
        return true;
      }
      const token = await openVaultSecret(
        {
          workspaceId: connection.workspaceId,
          recordId: credential.id,
          provider: accessVaultProvider(
            connection.provider,
            credential.credentialKind,
          ),
        },
        credential.encryptedAccessToken,
      );
      await revokeGitHubUserToken({
        clientId: env.GITHUB_APP_CLIENT_ID,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET,
        token,
      });
      return true;
    }
    if (
      credential.credentialKind !== "oauth" ||
      connection.provider !== "gitlab"
    ) {
      return true;
    }
    if (!env.GITLAB_CLIENT_ID || !env.GITLAB_CLIENT_SECRET) return true;
    const tokens = [
      await openVaultSecret(
        {
          workspaceId: connection.workspaceId,
          recordId: credential.id,
          provider: accessVaultProvider(
            connection.provider,
            credential.credentialKind,
          ),
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
            provider: `${connection.provider}-user-oauth-refresh`,
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
      await response.body?.cancel();
      if (!response.ok) {
        throw new Error(
          `GitLab user token revocation failed (${response.status})`,
        );
      }
    }
    return true;
  } catch (cause) {
    console.error("Personal provider credential revocation failed", {
      provider: connection.provider,
      connectionId: connection.id,
      cause,
    });
    return false;
  }
}

/** Returns whether a stored personal OAuth grant is close enough to expiry to rotate. */
function credentialNeedsRefresh(credential: UserProviderCredential) {
  return (
    USER_OAUTH_KINDS.has(credential.credentialKind) &&
    credential.expiresAt !== null &&
    credential.expiresAt.getTime() <= Date.now() + 60_000
  );
}

/** Names the vault provider key for a personal access token. */
function accessVaultProvider(provider: ProviderName, credentialKind: string) {
  return USER_OAUTH_KINDS.has(credentialKind)
    ? `${provider}-user-oauth-access`
    : `${provider}-user-pat`;
}

/** Chooses a createProvider kind that never posts as a GitHub App installation. */
function personalProviderKind(connection: ProviderConnection) {
  if (connection.provider === "azure_devops") {
    return isLocalDeployment() ? "local_pat" : "pat";
  }
  return "github_user";
}

/** Encrypts one personal credential secret inside its workspace boundary. */
function sealUserSecret(
  connection: ProviderConnection,
  credentialId: string,
  provider: string,
  secret: string,
) {
  return sealVaultSecret(
    {
      workspaceId: connection.workspaceId,
      recordId: credentialId,
      provider,
    },
    secret,
  );
}
