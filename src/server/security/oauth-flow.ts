/** Returns a same-origin application path or the supplied safe default. */
export function safeOAuthRedirectPath(
  value: unknown,
  applicationUrl: string,
  fallback = "/settings/providers",
) {
  if (typeof value !== "string" || !value.startsWith("/")) return fallback;
  try {
    const application = new URL(applicationUrl);
    const redirect = new URL(value, application);
    if (
      redirect.origin !== application.origin ||
      !redirect.pathname.startsWith("/") ||
      redirect.pathname.startsWith("//")
    ) {
      return fallback;
    }
    return `${redirect.pathname}${redirect.search}${redirect.hash}`;
  } catch {
    return fallback;
  }
}

/** Accepts only GitHub's positive decimal installation identifiers. */
export function githubInstallationId(value: unknown) {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) {
    return undefined;
  }
  return value;
}

export const GITHUB_USER_AUTHORIZATION_STAGE = "github-user-authorization";
export const USER_IDENTITY_PURPOSE = "user_identity";

/** Narrows an OAuth start purpose to workspace install or personal identity. */
export function oauthAuthorizationPurpose(
  value: unknown,
): "workspace" | "user_identity" {
  return value === USER_IDENTITY_PURPOSE ? "user_identity" : "workspace";
}

/** Accepts the connection a personal-identity authorization is bound to. */
export function oauthAuthorizationConnectionId(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    return undefined;
  }
  return value;
}

/**
 * Resolves the installation bound to the second GitHub authorization stage.
 *
 * New states carry the non-secret installation identifier in both the signed
 * JWT and the encrypted database record. Existing in-flight states only have
 * the encrypted copy and remain valid until they expire.
 */
export function githubAuthorizationInstallationId(
  claims: { installationId?: unknown; stage?: unknown },
  encryptedInstallationId: unknown,
) {
  const encrypted = githubInstallationId(encryptedInstallationId);
  const hasSignedStage =
    claims.stage !== undefined || claims.installationId !== undefined;
  if (!hasSignedStage) return encrypted;
  if (claims.stage !== GITHUB_USER_AUTHORIZATION_STAGE) return undefined;
  const signed = githubInstallationId(claims.installationId);
  if (!signed || (encrypted && encrypted !== signed)) return undefined;
  return signed;
}
