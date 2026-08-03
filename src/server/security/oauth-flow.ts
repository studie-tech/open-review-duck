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
    if (redirect.origin !== application.origin) return fallback;
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
