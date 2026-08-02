import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { NextResponse } from "next/server";
import { oauthStates } from "@/drizzle/schema";
import { env } from "~/env";
import { applicationAuth } from "~/server/auth";
import { db } from "~/server/db";
import { normalizeAzureOrganizationUrl } from "~/server/providers/azure-organization-url";
import { sealVaultSecret } from "~/server/security/vault";
import { ensurePersonalWorkspace } from "~/server/workspaces/service";

type HostedProvider = "github" | "gitlab" | "azure_devops";

/** Narrows an untrusted route segment to one supported SaaS provider. */
function hostedProvider(value: string): value is HostedProvider {
  return ["github", "gitlab", "azure_devops"].includes(value);
}

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
  const id = randomUUID();
  const state = await new SignJWT({ workspaceId: workspace.id, provider })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(id)
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
  await db.insert(oauthStates).values({
    id,
    workspaceId: workspace.id,
    provider,
    stateHash: createHash("sha256").update(state).digest("hex"),
    encryptedVerifier: await sealVaultSecret(
      db,
      { workspaceId: workspace.id, recordId: id, provider: "oauth-state" },
      JSON.stringify({ verifier, organizationUrl }),
    ),
    redirectPath:
      typeof body.redirectPath === "string" && body.redirectPath.startsWith("/")
        ? body.redirectPath
        : "/settings/providers",
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  const callback = `${env.APP_URL}/api/integrations/${provider}/callback`;
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
    authorizationUrl.searchParams.set("scope", "api read_user");
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
      "499b84ac-1321-427f-aa17-267ca6975798/user_impersonation offline_access openid profile",
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
