import { deepestCause } from "~/lib/error-cause";
import { providerLabel } from "~/lib/provider-labels";
import {
  classifyProviderFailure,
  classifyProviderFailureText,
  reportsProviderStatusFailure,
} from "~/server/providers/status-class";
import { ProviderError, type ProviderName } from "~/server/providers/types";

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
  const current = deepestCause(cause);

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
  const label = providerLabel(provider);
  const kind = classifyProviderFailure(cause);
  if (kind) {
    if (kind === "unauthorized") {
      return rejectedConnectedTokenMessage(label);
    }
    if (kind === "rate_limit") {
      return rateLimitedSyncMessage(label);
    }
    if (kind === "sso") {
      return ssoSyncMessage(label);
    }
    if (kind === "forbidden") {
      return provider === "github"
        ? "GitHub blocked access to this pull request. Confirm the token includes this repository with Contents: Read and write and Pull requests: Read and write."
        : `${label} blocked access to this pull request. Check the token's repository and pull-request permissions.`;
    }
    if (kind === "not_found") {
      return missingPullRequestMessage(label);
    }
    if (kind === "timeout") {
      return `${label} did not respond in time. Check the provider URL and try again.`;
    }
    const status = cause instanceof ProviderError ? cause.status : undefined;
    return `${label} returned an unexpected response${status ? ` (${status})` : ""}. Try again or check the provider connection.`;
  }

  if (cause instanceof Error && reportsProviderStatusFailure(cause.message)) {
    return persistedSyncErrorMessage(provider, cause.message);
  }

  return `ReviewDuck could not reach ${label}. Check your network and provider connection, then try again.`;
}

/** Converts a persisted provider failure into safe, actionable guidance. */
export function persistedSyncErrorMessage(
  provider: ProviderName,
  error: string | null,
) {
  const kind = classifyProviderFailureText(error ?? "");
  const label = providerLabel(provider);

  if (kind === "unauthorized") {
    return rejectedConnectedTokenMessage(label);
  }
  if (kind === "rate_limit") {
    return rateLimitedSyncMessage(label);
  }
  if (kind === "sso" || kind === "forbidden") {
    if (provider === "azure_devops") {
      return "Azure DevOps denied access while loading this pull request. Reconnect a token with Code: Read & write access to this repository.";
    }
    return `${label} denied access while loading this pull request. Check that the connection includes this repository and can read its code and pull requests.`;
  }
  if (kind === "not_found") {
    return missingPullRequestMessage(label);
  }
  if (kind === "timeout") {
    return `${label} did not respond in time. Try the synchronization again.`;
  }

  return `${label} synchronization failed. Check the provider connection and try again.`;
}

/** Sync copy for a rejected connected token. */
function rejectedConnectedTokenMessage(label: string) {
  return `${label} rejected the connected token. Reconnect the provider with a valid token.`;
}

/** Sync copy for a provider rate limit. */
function rateLimitedSyncMessage(label: string) {
  return `${label} rate-limited this sync. Wait a moment and try again.`;
}

/** Sync copy for a token that still needs organization SSO. */
function ssoSyncMessage(label: string) {
  return `${label} requires organization SSO authorization for this token. Authorize the token with the repository's organization, then sync again.`;
}

/** Sync copy when the pull request or a changed file is missing. */
function missingPullRequestMessage(label: string) {
  return `${label} could not find this pull request or one of its changed files. Check that the connected token can access the repository.`;
}
