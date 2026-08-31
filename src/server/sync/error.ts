import type { ProviderName } from "~/server/providers/types";
import { ProviderError } from "~/server/providers/types";

const providerLabels: Record<ProviderName, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  azure_devops: "Azure DevOps",
};

interface ErrorDetails {
  name: string;
  message: string;
  code?: string;
  constraint?: string;
}

/** Serializes an unknown failure value for structured diagnostics. */
const diagnosticValue = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Returns whether a later credential update resolved an earlier sync failure.
 *
 * A run can sit queued while the connection is repaired and then fail anyway,
 * so the moment the run failed decides this, not the moment it was queued. A
 * run holding no completion never reported a failure time, and its queue time
 * is the only evidence left.
 */
export function connectionUpdateResolvesSyncFailure(
  syncRun: { createdAt: Date; completedAt: Date | null },
  connectionUpdatedAt: Date,
) {
  return connectionUpdatedAt > (syncRun.completedAt ?? syncRun.createdAt);
}

/** Converts a sync failure into actionable user-facing details. */
export function reviewSyncFailureDetails(cause: unknown): ErrorDetails {
  let current = cause;
  for (let depth = 0; depth < 5; depth += 1) {
    if (
      typeof current !== "object" ||
      current === null ||
      !("cause" in current) ||
      current.cause === undefined
    ) {
      break;
    }
    current = current.cause;
  }

  const record =
    typeof current === "object" && current !== null
      ? (current as Record<string, unknown>)
      : undefined;
  return {
    name:
      current instanceof Error
        ? current.name
        : (diagnosticValue(record?.name) ?? "UnknownError"),
    message: (current instanceof Error
      ? current.message
      : (diagnosticValue(record?.message) ?? "Unknown sync failure")
    ).slice(0, 300),
    code: diagnosticValue(record?.code),
    constraint: diagnosticValue(record?.constraint),
  };
}

/** Converts provider polling failures into actionable review-sync guidance. */
export function providerSyncErrorMessage(
  provider: ProviderName,
  cause: unknown,
) {
  const label = providerLabels[provider];
  if (cause instanceof ProviderError) {
    if (cause.status === 401) {
      return `${label} rejected the connected token. Reconnect the provider with a valid token.`;
    }
    if (cause.status === 403) {
      const message = cause.message.toLowerCase();
      if (message.includes("rate limit")) {
        return `${label} rate-limited this sync. Wait a moment and try again.`;
      }
      if (message.includes("single sign-on")) {
        return `${label} requires organization SSO authorization for this token. Authorize the token with the repository's organization, then sync again.`;
      }
      return provider === "github"
        ? "GitHub blocked access to this pull request. Confirm the token includes this repository with Contents: Read and write and Pull requests: Read and write."
        : `${label} blocked access to this pull request. Check the token's repository and pull-request permissions.`;
    }
    if (cause.status === 404) {
      return `${label} could not find this pull request or one of its changed files. Check that the connected token can access the repository.`;
    }
    if (cause.status === 429) {
      return `${label} rate-limited this sync. Wait a moment and try again.`;
    }
    return `${label} returned an unexpected response${cause.status ? ` (${cause.status})` : ""}. Try again or check the provider connection.`;
  }

  if (cause instanceof Error && cause.name === "TimeoutError") {
    return `${label} did not respond in time. Check the provider URL and try again.`;
  }

  if (
    cause instanceof Error &&
    /(?:^|\D)(?:401|403|404|429)(?:\D|$)|rate limit|too many requests|forbidden|not allowed|unauthori[sz]ed|invalid token/i.test(
      cause.message,
    )
  ) {
    return persistedSyncErrorMessage(provider, cause.message);
  }

  return `ReviewDuck could not reach ${label}. Check your network and provider connection, then try again.`;
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
const reportsStatus = (message: string, status: number) =>
  new RegExp(`(?<![$\\w.])${status}(?![\\w.])`).test(message);

/** Converts a persisted provider failure into safe, actionable guidance. */
export function persistedSyncErrorMessage(
  provider: ProviderName,
  error: string | null,
) {
  const message = error?.toLowerCase() ?? "";
  const label = providerLabels[provider];

  if (
    reportsStatus(message, 401) ||
    /unauthori[sz]ed|invalid token/.test(message)
  ) {
    return `${label} rejected the connected token. Reconnect the provider with a valid token.`;
  }
  if (reportsStatus(message, 403) || /forbidden|not allowed/.test(message)) {
    if (message.includes("rate limit")) {
      return `${label} rate-limited this sync. Wait a moment and try again.`;
    }
    if (provider === "azure_devops") {
      return "Azure DevOps denied access while loading this pull request. Reconnect a token with Code: Read & write access to this repository.";
    }
    return `${label} denied access while loading this pull request. Check that the connection includes this repository and can read its code and pull requests.`;
  }
  if (reportsStatus(message, 404) || /not found/.test(message)) {
    return `${label} could not find this pull request or one of its changed files. Check that the connected token can access the repository.`;
  }
  if (
    reportsStatus(message, 429) ||
    /rate limit|too many requests/.test(message)
  ) {
    return `${label} rate-limited this sync. Wait a moment and try again.`;
  }
  if (/timeout|timed out/.test(message)) {
    return `${label} did not respond in time. Try the synchronization again.`;
  }

  return `${label} synchronization failed. Check the provider connection and try again.`;
}
