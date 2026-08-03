import "server-only";

import { createPrivateKey } from "node:crypto";

const GITHUB_API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 15_000;

/** Loads either GitHub's downloaded PKCS#1 PEM or a PKCS#8 PEM. */
export function githubAppPrivateKey(pem: string) {
  return createPrivateKey(pem.replaceAll("\\n", "\n"));
}

interface GitHubUserTokenResponse {
  access_token?: unknown;
  error?: unknown;
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
  const tokens = (await response.json()) as GitHubUserTokenResponse;
  if (
    typeof tokens.access_token !== "string" ||
    tokens.access_token.length === 0 ||
    tokens.access_token.length > 65_536
  ) {
    throw new Error("GitHub user authorization response is invalid");
  }
  return tokens.access_token;
}

/** Proves that the authorizing GitHub user can access this App installation. */
export async function verifyGitHubInstallationAccess(
  installationId: string,
  userToken: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(
    `https://api.github.com/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=1`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${userToken}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(
      response.status === 403 || response.status === 404
        ? "The GitHub installation is not accessible to the authorizing user"
        : `GitHub installation verification failed (${response.status})`,
    );
  }
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
