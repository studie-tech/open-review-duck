import { createHash, randomBytes, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { NextResponse } from "next/server";
import {
  credentialAuditEvents,
  oauthCredentials,
  oauthStates,
  providerConnections,
} from "@/drizzle/schema";
import { env } from "~/env";
import { applicationAuth } from "~/server/auth";
import { db } from "~/server/db";
import { createProvider } from "~/server/providers";
import { invalidateGitHubInstallationToken } from "~/server/providers/credentials";
import {
  exchangeGitHubUserCode,
  githubAppJwt,
  revokeGitHubUserToken,
  verifyGitHubInstallationOwnership,
} from "~/server/providers/github-app-authorization";
import {
  hostedProvider,
  oauthCallbackUrl,
} from "~/server/providers/oauth-callback-url";
import {
  GITHUB_USER_AUTHORIZATION_STAGE,
  githubAuthorizationInstallationId,
  githubInstallationId,
} from "~/server/security/oauth-flow";
import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";
import { requireWorkspaceAdministrator } from "~/server/workspaces/access";

class InstallationClaimedError extends Error {
  override name = "InstallationClaimedError";
}

/** Prevents callback credentials from entering caches or subsequent Referer headers. */
function securedCallbackResponse(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

/** Starts the verification-only GitHub user authorization stage with PKCE. */
async function githubUserAuthorization(input: {
  workspaceId: string;
  userId: string;
  installationId: string;
  redirectPath: string | null;
}) {
  if (!env.APP_URL || !env.OAUTH_STATE_SECRET || !env.GITHUB_APP_CLIENT_ID) {
    throw new Error("GitHub user authorization is not configured");
  }
  const id = randomUUID();
  const verifier = randomBytes(64).toString("base64url");
  const callback = oauthCallbackUrl(env.APP_URL, "github");
  const state = await new SignJWT({
    workspaceId: input.workspaceId,
    provider: "github",
    stage: GITHUB_USER_AUTHORIZATION_STAGE,
    installationId: input.installationId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(id)
    .setSubject(input.userId)
    .setIssuer("reviewduck")
    .setAudience("provider-oauth")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(env.OAUTH_STATE_SECRET));
  await db.insert(oauthStates).values({
    id,
    workspaceId: input.workspaceId,
    provider: "github",
    stateHash: createHash("sha256").update(state).digest("hex"),
    encryptedVerifier: await sealVaultSecret(
      {
        workspaceId: input.workspaceId,
        recordId: id,
        provider: "oauth-state",
      },
      JSON.stringify({
        verifier,
        installationId: input.installationId,
      }),
    ),
    redirectPath: input.redirectPath,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  const authorization = new URL("https://github.com/login/oauth/authorize");
  authorization.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID);
  authorization.searchParams.set("redirect_uri", callback);
  authorization.searchParams.set("state", state);
  authorization.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  authorization.searchParams.set("code_challenge_method", "S256");
  return authorization;
}

/** Completes a GitHub App installation or PKCE OAuth authorization once. */
async function completeProviderAuthorization(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  if (!hostedProvider(provider) || !env.APP_URL || !env.OAUTH_STATE_SECRET) {
    return securedCallbackResponse(new NextResponse(null, { status: 404 }));
  }
  const authentication = await applicationAuth();
  if (!authentication.userId) {
    return securedCallbackResponse(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
  }
  const url = new URL(request.url);
  const stateToken = url.searchParams.get("state");
  if (!stateToken || stateToken.length > 8_192) {
    return securedCallbackResponse(
      NextResponse.json({ error: "OAuth state is missing" }, { status: 400 }),
    );
  }
  let stateId: string;
  let stateClaims: { installationId?: unknown; stage?: unknown } = {};
  try {
    const verified = await jwtVerify(
      stateToken,
      new TextEncoder().encode(env.OAUTH_STATE_SECRET),
      {
        issuer: "reviewduck",
        audience: "provider-oauth",
        algorithms: ["HS256"],
      },
    );
    if (
      verified.payload.provider !== provider ||
      typeof verified.payload.jti !== "string" ||
      verified.payload.sub !== authentication.userId
    ) {
      throw new Error("OAuth state provider mismatch");
    }
    stateId = verified.payload.jti;
    stateClaims = {
      installationId: verified.payload.installationId,
      stage: verified.payload.stage,
    };
  } catch {
    return securedCallbackResponse(
      NextResponse.json({ error: "OAuth state is invalid" }, { status: 400 }),
    );
  }
  const stateHash = createHash("sha256").update(stateToken).digest("hex");
  const [state] = await db
    .update(oauthStates)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(oauthStates.id, stateId),
        eq(oauthStates.provider, provider),
        eq(oauthStates.stateHash, stateHash),
        isNull(oauthStates.consumedAt),
        gt(oauthStates.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!state?.encryptedVerifier) {
    return securedCallbackResponse(
      NextResponse.json(
        { error: "OAuth state is expired or already used" },
        { status: 400 },
      ),
    );
  }
  try {
    await requireWorkspaceAdministrator(
      db,
      state.workspaceId,
      authentication.userId,
    );
  } catch (cause) {
    if (cause instanceof TRPCError && cause.code === "FORBIDDEN") {
      return securedCallbackResponse(
        NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      );
    }
    throw cause;
  }
  const stateSecret = JSON.parse(
    await openVaultSecret(
      {
        workspaceId: state.workspaceId,
        recordId: state.id,
        provider: "oauth-state",
      },
      state.encryptedVerifier,
    ),
  ) as {
    verifier?: unknown;
    installationId?: unknown;
  };
  const callback = oauthCallbackUrl(env.APP_URL, provider);
  if (provider === "github") {
    const pendingInstallationId = githubAuthorizationInstallationId(
      stateClaims,
      stateSecret.installationId,
    );
    if (!pendingInstallationId) {
      const installationId = githubInstallationId(
        url.searchParams.get("installation_id"),
      );
      if (!installationId) {
        return securedCallbackResponse(
          NextResponse.json(
            { error: "GitHub installation is missing or invalid" },
            { status: 400 },
          ),
        );
      }
      return securedCallbackResponse(
        NextResponse.redirect(
          await githubUserAuthorization({
            workspaceId: state.workspaceId,
            userId: authentication.userId,
            installationId,
            redirectPath: state.redirectPath,
          }),
        ),
      );
    }
    const code = url.searchParams.get("code");
    if (
      !code ||
      code.length > 2_048 ||
      typeof stateSecret.verifier !== "string" ||
      !env.GITHUB_APP_CLIENT_ID ||
      !env.GITHUB_APP_CLIENT_SECRET
    ) {
      return securedCallbackResponse(
        NextResponse.json(
          { error: "GitHub user authorization is missing" },
          { status: 400 },
        ),
      );
    }
    const userToken = await exchangeGitHubUserCode({
      clientId: env.GITHUB_APP_CLIENT_ID,
      clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      code,
      codeVerifier: stateSecret.verifier,
      redirectUri: callback,
    });
    let verificationFailure: unknown;
    let installationOwner:
      | { accountId: string; accountLogin: string }
      | undefined;
    try {
      installationOwner = await verifyGitHubInstallationOwnership(
        pendingInstallationId,
        userToken,
        await githubAppJwt({
          appId: env.GITHUB_APP_ID,
          privateKey: env.GITHUB_APP_PRIVATE_KEY,
        }),
      );
    } catch (cause) {
      verificationFailure = cause;
    }
    let revocationFailure: unknown;
    try {
      await revokeGitHubUserToken({
        clientId: env.GITHUB_APP_CLIENT_ID,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET,
        token: userToken,
      });
    } catch (cause) {
      revocationFailure = cause;
    }
    if (verificationFailure || !installationOwner) {
      return securedCallbackResponse(
        NextResponse.json(
          { error: "The GitHub installation could not be verified" },
          { status: 403 },
        ),
      );
    }
    if (revocationFailure) {
      return securedCallbackResponse(
        NextResponse.json(
          { error: "GitHub authorization cleanup failed; please try again" },
          { status: 502 },
        ),
      );
    }
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`github-installation:${pendingInstallationId}`}, 0))`,
      );
      const claimed = await tx.query.providerConnections.findFirst({
        where: and(
          eq(providerConnections.provider, "github"),
          eq(providerConnections.credentialKind, "github_app"),
          eq(providerConnections.installationId, pendingInstallationId),
        ),
        columns: { workspaceId: true },
      });
      if (claimed && claimed.workspaceId !== state.workspaceId) {
        throw new InstallationClaimedError(
          "This GitHub App installation is already connected to another workspace",
        );
      }
      const [connection] = await tx
        .insert(providerConnections)
        .values({
          workspaceId: state.workspaceId,
          provider,
          externalAccountId: installationOwner.accountId,
          credentialKind: "github_app",
          credentialStatus: "active",
          credentialFingerprint: createHash("sha256")
            .update(`github\0${pendingInstallationId}`)
            .digest("hex"),
          displayName: installationOwner.accountLogin,
          installationId: pendingInstallationId,
        })
        .onConflictDoUpdate({
          target: [
            providerConnections.workspaceId,
            providerConnections.provider,
            providerConnections.credentialFingerprint,
          ],
          set: {
            credentialKind: "github_app",
            credentialStatus: "active",
            externalAccountId: installationOwner.accountId,
            displayName: installationOwner.accountLogin,
            installationId: pendingInstallationId,
          },
        })
        .returning({ id: providerConnections.id });
      if (!connection) throw new Error("Could not persist GitHub connection");
      await tx.insert(credentialAuditEvents).values({
        workspaceId: state.workspaceId,
        actorId: authentication.userId,
        credentialId: connection.id,
        action: "authorized",
        provider,
        metadata: { credentialKind: "github_app" },
      });
    });
    invalidateGitHubInstallationToken(pendingInstallationId);
    return securedCallbackResponse(
      NextResponse.redirect(
        new URL(state.redirectPath ?? "/settings/providers", env.APP_URL),
      ),
    );
  }
  const code = url.searchParams.get("code");
  if (
    !code ||
    code.length > 2_048 ||
    typeof stateSecret.verifier !== "string"
  ) {
    return securedCallbackResponse(
      NextResponse.json({ error: "OAuth code is missing" }, { status: 400 }),
    );
  }
  const tokenUrl = "https://gitlab.com/oauth/token";
  const clientId = env.GITLAB_CLIENT_ID;
  const clientSecret = env.GITLAB_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw new Error("OAuth client is not configured");
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: stateSecret.verifier,
    redirect_uri: callback,
  });
  const tokenResponse = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenResponse.ok) {
    return securedCallbackResponse(
      NextResponse.json(
        { error: `OAuth exchange failed (${tokenResponse.status})` },
        { status: 502 },
      ),
    );
  }
  const tokens = (await tokenResponse.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (
    typeof tokens.access_token !== "string" ||
    tokens.access_token.length === 0 ||
    tokens.access_token.length > 65_536 ||
    typeof tokens.refresh_token !== "string" ||
    tokens.refresh_token.length === 0 ||
    tokens.refresh_token.length > 65_536 ||
    typeof tokens.expires_in !== "number" ||
    !Number.isFinite(tokens.expires_in) ||
    tokens.expires_in <= 0 ||
    tokens.expires_in > 7 * 86_400
  ) {
    return securedCallbackResponse(
      NextResponse.json(
        { error: "OAuth token response is invalid" },
        { status: 502 },
      ),
    );
  }
  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;
  const expiresIn = tokens.expires_in;
  const baseUrl = "https://gitlab.com/api/v4";
  const identity = await createProvider(
    provider,
    accessToken,
    baseUrl,
    "oauth",
  ).getConnectionIdentity();
  const credentialFingerprint = createHash("sha256")
    .update(`${provider}\0${identity.externalAccountId}`)
    .digest("hex");
  await db.transaction(async (tx) => {
    const [connection] = await tx
      .insert(providerConnections)
      .values({
        workspaceId: state.workspaceId,
        provider,
        externalAccountId: identity.externalAccountId,
        credentialKind: "oauth",
        credentialStatus: "active",
        credentialFingerprint,
        displayName: identity.displayName,
        baseUrl,
      })
      .onConflictDoUpdate({
        target: [
          providerConnections.workspaceId,
          providerConnections.provider,
          providerConnections.credentialFingerprint,
        ],
        set: {
          externalAccountId: identity.externalAccountId,
          credentialStatus: "active",
          displayName: identity.displayName,
          baseUrl,
        },
      })
      .returning();
    if (!connection) throw new Error("Could not persist provider connection");
    const existing = await tx.query.oauthCredentials.findFirst({
      where: eq(oauthCredentials.connectionId, connection.id),
    });
    const credentialId = existing?.id ?? randomUUID();
    const encryptedAccessToken = await sealVaultSecret(
      {
        workspaceId: state.workspaceId,
        recordId: credentialId,
        provider: `${provider}-oauth-access`,
      },
      accessToken,
    );
    const encryptedRefreshToken = await sealVaultSecret(
      {
        workspaceId: state.workspaceId,
        recordId: credentialId,
        provider: `${provider}-oauth-refresh`,
      },
      refreshToken,
    );
    await tx
      .insert(oauthCredentials)
      .values({
        id: credentialId,
        connectionId: connection.id,
        encryptedAccessToken,
        encryptedRefreshToken,
        expiresAt: new Date(Date.now() + expiresIn * 1_000),
      })
      .onConflictDoUpdate({
        target: oauthCredentials.connectionId,
        set: {
          encryptedAccessToken,
          encryptedRefreshToken,
          expiresAt: new Date(Date.now() + expiresIn * 1_000),
          refreshVersion: sql`${oauthCredentials.refreshVersion} + 1`,
        },
      });
    await tx.insert(credentialAuditEvents).values({
      workspaceId: state.workspaceId,
      actorId: authentication.userId,
      credentialId: connection.id,
      action: "authorized",
      provider,
      metadata: { credentialKind: "oauth" },
    });
  });
  return securedCallbackResponse(
    NextResponse.redirect(
      new URL(state.redirectPath ?? "/settings/providers", env.APP_URL),
    ),
  );
}

/** Ensures every callback outcome suppresses caching and referrer propagation. */
export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  try {
    return await completeProviderAuthorization(request, context);
  } catch (cause) {
    if (cause instanceof InstallationClaimedError) {
      return securedCallbackResponse(
        NextResponse.json({ error: cause.message }, { status: 409 }),
      );
    }
    console.error("Provider authorization callback failed", {
      provider: (await context.params).provider,
      cause,
    });
    return securedCallbackResponse(
      NextResponse.json(
        { error: "Provider authorization could not be completed" },
        { status: 500 },
      ),
    );
  }
}
