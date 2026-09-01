import { ProviderError } from "./types";

export type ProviderStatusClass =
  | "unauthorized"
  | "sso"
  | "rate_limit"
  | "forbidden"
  | "not_found"
  | "timeout"
  | "unexpected"
  | "unknown";

/** Classifies a live provider failure by HTTP status, SSO, rate-limit, or timeout. */
export function classifyProviderFailure(
  cause: unknown,
): ProviderStatusClass | undefined {
  if (cause instanceof ProviderError) {
    return classifyProviderHttpStatus(cause.status, cause.message);
  }
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return "timeout";
  }
  return undefined;
}

/** Classifies a persisted or free-text provider failure without trusting raw digits. */
export function classifyProviderFailureText(
  message: string,
): ProviderStatusClass {
  const text = message.toLowerCase();
  if (reportsStatus(text, 401) || /unauthori[sz]ed|invalid token/.test(text)) {
    return "unauthorized";
  }
  if (reportsStatus(text, 403) || /forbidden|not allowed/.test(text)) {
    return classifyForbiddenMessage(text);
  }
  if (reportsStatus(text, 404) || /not found/.test(text)) {
    return "not_found";
  }
  if (reportsStatus(text, 429) || /rate limit|too many requests/.test(text)) {
    return "rate_limit";
  }
  if (/timeout|timed out/.test(text)) {
    return "timeout";
  }
  return "unknown";
}

/** True when free text reports an HTTP status or authorization failure. */
export function reportsProviderStatusFailure(message: string) {
  return /(?:^|\D)(?:401|403|404|429)(?:\D|$)|rate limit|too many requests|forbidden|not allowed|unauthori[sz]ed|invalid token/i.test(
    message,
  );
}

/** True when a live provider failure is a 401 or 403, including SSO and 403 rate limits. */
export function isProviderPermissionFailure(cause: unknown) {
  const kind = classifyProviderFailure(cause);
  if (kind === "unauthorized" || kind === "forbidden" || kind === "sso") {
    return true;
  }
  return (
    kind === "rate_limit" &&
    cause instanceof ProviderError &&
    cause.status === 403
  );
}

/** Classifies a live HTTP status, including 403 SSO and rate-limit subclasses. */
function classifyProviderHttpStatus(
  status: number | undefined,
  message: string,
): ProviderStatusClass {
  if (status === 401) return "unauthorized";
  if (status === 429) return "rate_limit";
  if (status === 404) return "not_found";
  if (status === 403) return classifyForbiddenMessage(message.toLowerCase());
  return "unexpected";
}

/** Distinguishes a 403 rate-limit or SSO failure from a permission block. */
function classifyForbiddenMessage(message: string): ProviderStatusClass {
  if (message.includes("rate limit")) return "rate_limit";
  if (message.includes("single sign-on")) return "sso";
  return "forbidden";
}

/**
 * Reads an HTTP status only where one was reported, not where a digit stands.
 *
 * A persisted failure is free text, and a line number, a byte offset or a
 * driver's bound-parameter placeholder all reach it. `$401` carries the digits
 * of a rejected credential without being one, and a bare word boundary treats
 * the two alike: the guidance that follows would send a reviewer to reconnect a
 * connection that never failed.
 */
function reportsStatus(message: string, status: number) {
  return new RegExp(`(?<![$\\w.])${status}(?![\\w.])`).test(message);
}
