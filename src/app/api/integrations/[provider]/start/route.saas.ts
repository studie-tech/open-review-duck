import { createHash, randomBytes, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { NextResponse } from "next/server";
import { oauthStates, providerConnections } from "@/drizzle/schema";
import { env } from "~/env";
import { applicationAuth } from "~/server/auth";
import { db } from "~/server/db";
import {
  hostedProvider,
  oauthCallbackUrl,
} from "~/server/providers/oauth-callback-url";
import {
  oauthAuthorizationConnectionId,
  oauthAuthorizationPurpose,
  safeOAuthRedirectPath,
} from "~/server/security/oauth-flow";
import { enforceRateLimit } from "~/server/security/rate-limit";
import { sealVaultSecret } from "~/server/security/vault";
import { requirePersonalWorkspaceAdministrator } from "~/server/workspaces/access";
import { ensurePersonalWorkspace } from "~/server/workspaces/service";

/** Starts one App/OAuth connection with signed, one-time, PKCE-bound state. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const authentication = await applicationAuth();
  if (!authentication.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { provider } = await params;
  if (!hostedProvider(provider)) {
    return NextResponse.json(
      { error: "Unsupported provider" },
      { status: 404 },
    );
  }
  if (!env.APP_URL || !env.OAUTH_STATE_SECRET) {
    throw new Error("Hosted OAuth is not configured");
  }
  const body = (await request.json().catch(() => ({}))) as {
    redirectPath?: unknown;
    purpose?: unknown;
    connectionId?: unknown;
  };
  const purpose = oauthAuthorizationPurpose(body.purpose);
  const connectionId =
    purpose === "user_identity"
      ? oauthAuthorizationConnectionId(body.connectionId)
      : undefined;
  if (purpose === "user_identity" && !connectionId) {
    return NextResponse.json(
      { error: "A provider connection is required" },
      { status: 400 },
    );
  }
  const workspace = await ensurePersonalWorkspace(db, authentication.userId);
  try {
    if (purpose === "workspace") {
      await requirePersonalWorkspaceAdministrator(db, authentication.userId);
    } else if (connectionId) {
      const connection = await db.query.providerConnections.findFirst({
        where: and(
          eq(providerConnections.id, connectionId),
          eq(providerConnections.workspaceId, workspace.id),
          eq(providerConnections.provider, provider),
        ),
      });
      if (!connection) {
        return NextResponse.json(
          { error: "Provider connection not found" },
          { status: 404 },
        );
      }
    }
    await enforceRateLimit(
      db,
      `${purpose === "user_identity" ? "personal-oauth-start" : "provider-oauth-start"}:${workspace.id}:${authentication.userId}`,
      10,
      10 * 60_000,
    );
  } catch (cause) {
    if (cause instanceof TRPCError && cause.code === "FORBIDDEN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (cause instanceof TRPCError && cause.code === "TOO_MANY_REQUESTS") {
      return NextResponse.json(
        { error: "Too many authorization attempts" },
        { status: 429 },
      );
    }
    if (cause instanceof TRPCError) {
      return NextResponse.json(
        { error: "Authorization could not be started" },
        { status: 500 },
      );
    }
    throw cause;
  }
  const id = randomUUID();
  const state = await new SignJWT({
    workspaceId: workspace.id,
    provider,
    purpose,
    ...(connectionId ? { connectionId } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(id)
    .setSubject(authentication.userId)
    .setIssuer("reviewduck")
    .setAudience("provider-oauth")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(env.OAUTH_STATE_SECRET));
  const verifier = randomBytes(64).toString("base64url");
  const callback = oauthCallbackUrl(env.APP_URL, provider);
  await db.insert(oauthStates).values({
    id,
    workspaceId: workspace.id,
    provider,
    stateHash: createHash("sha256").update(state).digest("hex"),
    encryptedVerifier: await sealVaultSecret(
      { workspaceId: workspace.id, recordId: id, provider: "oauth-state" },
      JSON.stringify({
        verifier,
        ...(connectionId ? { connectionId } : {}),
      }),
    ),
    redirectPath: safeOAuthRedirectPath(body.redirectPath, env.APP_URL),
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  let authorizationUrl: URL;
  if (provider === "github" && purpose === "workspace") {
    if (!env.GITHUB_APP_SLUG) throw new Error("GitHub App is not configured");
    authorizationUrl = new URL(
      `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`,
    );
  } else if (provider === "github") {
    if (!env.GITHUB_APP_CLIENT_ID) {
      throw new Error("GitHub App is not configured");
    }
    authorizationUrl = new URL("https://github.com/login/oauth/authorize");
    authorizationUrl.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID);
    authorizationUrl.searchParams.set("redirect_uri", callback);
    authorizationUrl.searchParams.set(
      "code_challenge",
      createHash("sha256").update(verifier).digest("base64url"),
    );
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
  } else {
    if (!env.GITLAB_CLIENT_ID)
      throw new Error("GitLab OAuth is not configured");
    authorizationUrl = new URL("https://gitlab.com/oauth/authorize");
    authorizationUrl.searchParams.set("client_id", env.GITLAB_CLIENT_ID);
    authorizationUrl.searchParams.set("redirect_uri", callback);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", "api");
    authorizationUrl.searchParams.set(
      "code_challenge",
      createHash("sha256").update(verifier).digest("base64url"),
    );
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
  }
  authorizationUrl.searchParams.set("state", state);
  return NextResponse.json(
    { authorizationUrl: authorizationUrl.toString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
