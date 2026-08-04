import { createHash, randomBytes, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { SignJWT } from "jose";
import { NextResponse } from "next/server";
import { oauthStates } from "@/drizzle/schema";
import { env } from "~/env";
import { applicationAuth } from "~/server/auth";
import { db } from "~/server/db";
import { normalizeAzureOrganizationUrl } from "~/server/providers/azure-organization-url";
import {
  hostedProvider,
  oauthCallbackUrl,
} from "~/server/providers/oauth-callback-url";
import { safeOAuthRedirectPath } from "~/server/security/oauth-flow";
import { enforceRateLimit } from "~/server/security/rate-limit";
import { sealVaultSecret } from "~/server/security/vault";
import {
  ensurePersonalWorkspace,
  requireWorkspaceAdministrator,
} from "~/server/workspaces/service";

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
  const workspace = await ensurePersonalWorkspace(db, authentication.userId);
  try {
    await requireWorkspaceAdministrator(
      db,
      workspace.id,
      authentication.userId,
    );
    await enforceRateLimit(
      db,
      `provider-oauth-start:${workspace.id}:${authentication.userId}`,
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
  const state = await new SignJWT({ workspaceId: workspace.id, provider })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(id)
    .setSubject(authentication.userId)
    .setIssuer("reviewduck")
    .setAudience("provider-oauth")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(env.OAUTH_STATE_SECRET));
  const verifier = randomBytes(64).toString("base64url");
  const body = (await request.json().catch(() => ({}))) as {
    organizationUrl?: unknown;
    redirectPath?: unknown;
  };
  let organizationUrl: string | undefined;
  if (provider === "azure_devops" && typeof body.organizationUrl === "string") {
    try {
      organizationUrl = normalizeAzureOrganizationUrl(body.organizationUrl);
    } catch (cause) {
      return NextResponse.json(
        {
          error:
            cause instanceof Error
              ? cause.message
              : "Azure DevOps organization URL is invalid",
        },
        { status: 400 },
      );
    }
  }
  if (provider === "azure_devops" && !organizationUrl) {
    return NextResponse.json(
      { error: "Azure DevOps organization URL is required" },
      { status: 400 },
    );
  }
  const callback = oauthCallbackUrl(env.APP_URL, provider);
  await db.insert(oauthStates).values({
    id,
    workspaceId: workspace.id,
    provider,
    stateHash: createHash("sha256").update(state).digest("hex"),
    encryptedVerifier: await sealVaultSecret(
      { workspaceId: workspace.id, recordId: id, provider: "oauth-state" },
      JSON.stringify({ verifier, organizationUrl, callback }),
    ),
    redirectPath: safeOAuthRedirectPath(body.redirectPath, env.APP_URL),
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  let authorizationUrl: URL;
  if (provider === "github") {
    if (!env.GITHUB_APP_SLUG) throw new Error("GitHub App is not configured");
    authorizationUrl = new URL(
      `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`,
    );
  } else if (provider === "gitlab") {
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
  } else {
    if (!env.AZURE_ENTRA_CLIENT_ID) {
      throw new Error("Microsoft Entra OAuth is not configured");
    }
    authorizationUrl = new URL(
      `https://login.microsoftonline.com/${env.AZURE_ENTRA_TENANT_ID}/oauth2/v2.0/authorize`,
    );
    authorizationUrl.searchParams.set("client_id", env.AZURE_ENTRA_CLIENT_ID);
    authorizationUrl.searchParams.set("redirect_uri", callback);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set(
      "scope",
      "499b84ac-1321-427f-aa17-267ca6975798/user_impersonation offline_access",
    );
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
