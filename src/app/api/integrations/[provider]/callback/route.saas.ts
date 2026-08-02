import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { jwtVerify } from "jose";
import { NextResponse } from "next/server";
import {
  oauthCredentials,
  oauthStates,
  providerConnections,
} from "@/drizzle/schema";
import { env } from "~/env";
import { db } from "~/server/db";
import { createProvider } from "~/server/providers";
import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";

type HostedProvider = "github" | "gitlab" | "azure_devops";

/** Narrows an untrusted route segment to one supported SaaS provider. */
function hostedProvider(value: string): value is HostedProvider {
  return ["github", "gitlab", "azure_devops"].includes(value);
}

/** Completes a GitHub App installation or PKCE OAuth authorization once. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  if (!hostedProvider(provider) || !env.APP_URL || !env.OAUTH_STATE_SECRET) {
    return new NextResponse(null, { status: 404 });
  }
  const url = new URL(request.url);
  const stateToken = url.searchParams.get("state");
  if (!stateToken) {
    return NextResponse.json(
      { error: "OAuth state is missing" },
      { status: 400 },
    );
  }
  let stateId: string;
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
      typeof verified.payload.jti !== "string"
    ) {
      throw new Error("OAuth state provider mismatch");
    }
    stateId = verified.payload.jti;
  } catch {
    return NextResponse.json(
      { error: "OAuth state is invalid" },
      { status: 400 },
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
    return NextResponse.json(
      { error: "OAuth state is expired or already used" },
      { status: 400 },
    );
  }
  const stateSecret = JSON.parse(
    await openVaultSecret(
      db,
      {
        workspaceId: state.workspaceId,
        recordId: state.id,
        provider: "oauth-state",
      },
      state.encryptedVerifier,
    ),
  ) as { verifier?: unknown; organizationUrl?: unknown };
  if (provider === "github") {
    const installationId = url.searchParams.get("installation_id");
    if (!installationId) {
      return NextResponse.json(
        { error: "GitHub installation is missing" },
        { status: 400 },
      );
    }
    await db
      .insert(providerConnections)
      .values({
        workspaceId: state.workspaceId,
        provider,
        externalAccountId: installationId,
        credentialKind: "github_app",
        credentialFingerprint: createHash("sha256")
          .update(`github\0${installationId}`)
          .digest("hex"),
        displayName: `GitHub App installation ${installationId}`,
        installationId,
      })
      .onConflictDoUpdate({
        target: [
          providerConnections.workspaceId,
          providerConnections.provider,
          providerConnections.credentialFingerprint,
        ],
        set: { installationId },
      });
    return NextResponse.redirect(
      new URL(state.redirectPath ?? "/settings/providers", env.APP_URL),
    );
  }
  const code = url.searchParams.get("code");
  if (!code || typeof stateSecret.verifier !== "string") {
    return NextResponse.json(
      { error: "OAuth code is missing" },
      { status: 400 },
    );
  }
  const callback = `${env.APP_URL}/api/integrations/${provider}/callback`;
  const tokenUrl =
    provider === "gitlab"
      ? "https://gitlab.com/oauth/token"
      : `https://login.microsoftonline.com/${env.AZURE_ENTRA_TENANT_ID}/oauth2/v2.0/token`;
  const clientId =
    provider === "gitlab" ? env.GITLAB_CLIENT_ID : env.AZURE_ENTRA_CLIENT_ID;
  const clientSecret =
    provider === "gitlab"
      ? env.GITLAB_CLIENT_SECRET
      : env.AZURE_ENTRA_CLIENT_SECRET;
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
    return NextResponse.json(
      { error: `OAuth exchange failed (${tokenResponse.status})` },
      { status: 502 },
    );
  }
  const tokens = (await tokenResponse.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof tokens.access_token !== "string") {
    return NextResponse.json(
      { error: "OAuth token response is invalid" },
      { status: 502 },
    );
  }
  const accessToken = tokens.access_token;
  const baseUrl =
    provider === "gitlab"
      ? "https://gitlab.com/api/v4"
      : typeof stateSecret.organizationUrl === "string"
        ? stateSecret.organizationUrl
        : undefined;
  if (!baseUrl) {
    return NextResponse.json(
      { error: "Azure DevOps organization is missing" },
      { status: 400 },
    );
  }
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
      db,
      {
        workspaceId: state.workspaceId,
        recordId: credentialId,
        provider: `${provider}-oauth-access`,
      },
      accessToken,
    );
    const encryptedRefreshToken =
      typeof tokens.refresh_token === "string"
        ? await sealVaultSecret(
            db,
            {
              workspaceId: state.workspaceId,
              recordId: credentialId,
              provider: `${provider}-oauth-refresh`,
            },
            tokens.refresh_token,
          )
        : existing?.encryptedRefreshToken;
    await tx
      .insert(oauthCredentials)
      .values({
        id: credentialId,
        connectionId: connection.id,
        encryptedAccessToken,
        encryptedRefreshToken,
        expiresAt:
          typeof tokens.expires_in === "number"
            ? new Date(Date.now() + tokens.expires_in * 1_000)
            : undefined,
      })
      .onConflictDoUpdate({
        target: oauthCredentials.connectionId,
        set: {
          encryptedAccessToken,
          encryptedRefreshToken,
          expiresAt:
            typeof tokens.expires_in === "number"
              ? new Date(Date.now() + tokens.expires_in * 1_000)
              : null,
        },
      });
  });
  return NextResponse.redirect(
    new URL(state.redirectPath ?? "/settings/providers", env.APP_URL),
  );
}
