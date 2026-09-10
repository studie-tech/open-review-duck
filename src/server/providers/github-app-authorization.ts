import "server-only";

import { createPrivateKey } from "node:crypto";
import { SignJWT } from "jose";

const GITHUB_API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 15_000;

/** Loads either GitHub's downloaded PKCS#1 PEM or a PKCS#8 PEM. */
export function githubAppPrivateKey(pem: string) {
  return createPrivateKey(pem.replaceAll("\\n", "\n"));
}

/** Signs one short-lived JWT for GitHub App administrative operations. */
export async function githubAppJwt(input: {
  appId: string | undefined;
  privateKey: string | undefined;
}) {
  if (!input.appId || !input.privateKey) {
    throw new Error("GitHub App credentials are not configured");
  }
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(input.appId)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .sign(githubAppPrivateKey(input.privateKey));
}

interface GitHubUserTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
}

export interface GitHubUserAuthorizationTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

/** Reads one GitHub user-to-server token payload. */
function githubUserAuthorizationTokens(tokens: GitHubUserTokenResponse) {
  if (
    typeof tokens.access_token !== "string" ||
    tokens.access_token.length === 0 ||
    tokens.access_token.length > 65_536
  ) {
    throw new Error("GitHub user authorization response is invalid");
  }
  const refreshToken =
    typeof tokens.refresh_token === "string" &&
    tokens.refresh_token.length > 0 &&
    tokens.refresh_token.length <= 65_536
      ? tokens.refresh_token
      : undefined;
  const expiresIn =
    typeof tokens.expires_in === "number" &&
    Number.isFinite(tokens.expires_in) &&
    tokens.expires_in > 0 &&
    tokens.expires_in <= 7 * 86_400
      ? tokens.expires_in
      : undefined;
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresIn,
  } satisfies GitHubUserAuthorizationTokens;
}

/** Exchanges one short-lived GitHub authorization code using PKCE. */
export async function exchangeGitHubUserAuthorization(
  input: {
    clientId: string;
    clientSecret: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub user authorization failed (${response.status})`);
  }
  return githubUserAuthorizationTokens(
    (await response.json()) as GitHubUserTokenResponse,
  );
}

/** Exchanges one short-lived GitHub authorization code using PKCE. */
export async function exchangeGitHubUserCode(
  input: {
    clientId: string;
    clientSecret: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
  fetcher: typeof fetch = fetch,
) {
  return (await exchangeGitHubUserAuthorization(input, fetcher)).accessToken;
}

/** Rotates one stored GitHub user-to-server refresh token. */
export async function refreshGitHubUserToken(
  input: { clientId: string; clientSecret: string; refreshToken: string },
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub user token refresh failed (${response.status})`);
  }
  const tokens = githubUserAuthorizationTokens(
    (await response.json()) as GitHubUserTokenResponse,
  );
  if (!tokens.expiresIn) {
    throw new Error("GitHub user token refresh response is invalid");
  }
  return { ...tokens, expiresIn: tokens.expiresIn };
}

/** Proves that the authorizing GitHub user owns or administers this installation. */
export async function verifyGitHubInstallationOwnership(
  installationId: string,
  userToken: string,
  appToken: string,
  fetcher: typeof fetch = fetch,
) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  const [installationResponse, userResponse] = await Promise.all([
    fetcher(
      `https://api.github.com/app/installations/${encodeURIComponent(installationId)}`,
      {
        headers: { ...headers, Authorization: `Bearer ${appToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    ),
    fetcher("https://api.github.com/user", {
      headers: { ...headers, Authorization: `Bearer ${userToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  ]);
  if (!installationResponse.ok || !userResponse.ok) {
    await Promise.all([
      installationResponse.body?.cancel(),
      userResponse.body?.cancel(),
    ]);
    throw new Error("The GitHub installation ownership could not be verified");
  }
  const installation = (await installationResponse.json()) as {
    account?: { id?: unknown; login?: unknown; type?: unknown };
  };
  const user = (await userResponse.json()) as { id?: unknown };
  const account = installation.account;
  if (
    !account ||
    (typeof account.id !== "number" && typeof account.id !== "string") ||
    typeof account.login !== "string" ||
    (typeof user.id !== "number" && typeof user.id !== "string")
  ) {
    throw new Error("The GitHub installation ownership response is invalid");
  }
  if (account.type === "User") {
    if (String(account.id) !== String(user.id)) {
      throw new Error("The GitHub installation is not owned by this user");
    }
    return { accountId: String(account.id), accountLogin: account.login };
  }
  if (account.type !== "Organization") {
    throw new Error("The GitHub installation account type is unsupported");
  }
  const membershipResponse = await fetcher(
    `https://api.github.com/user/memberships/orgs/${encodeURIComponent(account.login)}`,
    {
      headers: {
        ...headers,
        Authorization: `Bearer ${userToken}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!membershipResponse.ok) {
    await membershipResponse.body?.cancel();
    throw new Error(
      "The GitHub installation organization is not administered by this user",
    );
  }
  const membership = (await membershipResponse.json()) as {
    role?: unknown;
    state?: unknown;
  };
  if (membership.role !== "admin" || membership.state !== "active") {
    throw new Error(
      "The GitHub installation organization is not administered by this user",
    );
  }
  return { accountId: String(account.id), accountLogin: account.login };
}

/** Revokes the verification-only GitHub user token after its single use. */
export async function revokeGitHubUserToken(
  input: { clientId: string; clientSecret: string; token: string },
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(
    `https://api.github.com/applications/${encodeURIComponent(input.clientId)}/token`,
    {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      body: JSON.stringify({ access_token: input.token }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  await response.body?.cancel();
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `GitHub verification token revocation failed (${response.status})`,
    );
  }
}
