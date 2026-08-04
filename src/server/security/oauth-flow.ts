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
