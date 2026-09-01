import { providerLabel } from "~/lib/provider-labels";
import { classifyProviderFailure } from "./status-class";
import { ProviderError, type ProviderName } from "./types";

const permissionHelp: Record<ProviderName, string> = {
  github:
    "Confirm Contents: Read and write and Pull requests: Read and write, and approve the token for the organization if required.",
  gitlab:
    "Confirm the token has the api scope and Developer access or higher so its identity can approve merge requests.",
  azure_devops:
    "Confirm the token has Code: Read & write so it can manage code-review votes.",
};

/** Normalizes provider connection failures into actionable copy. */
export function providerConnectionErrorMessage(
  provider: ProviderName,
  cause: unknown,
) {
  const label = providerLabel(provider);
  const kind = classifyProviderFailure(cause);

  if (kind === "unauthorized") {
    return `${label} rejected this token. Create a new token, copy the complete value, and try again.`;
  }
  if (kind === "rate_limit") {
    return `${label}'s API rate limit is exhausted. Wait for ${label} to reset it before retrying; repeated retries will not help.`;
  }
  if (kind === "sso") {
    return `${label} requires organization SSO authorization for this token. Authorize it with the organization and try again.`;
  }
  if (kind === "forbidden") {
    return `${label} accepted the token but blocked access. ${permissionHelp[provider]}`;
  }
  if (kind === "not_found") {
    return provider === "github"
      ? "GitHub could not find this API endpoint. Check the Enterprise API URL, or leave it empty for github.com."
      : `${label} could not find this API endpoint. Check the provider URL and try again.`;
  }
  if (kind === "timeout") {
    return `${label} did not respond in time. Check the provider URL and try again.`;
  }
  if (kind === "unexpected") {
    const status = cause instanceof ProviderError ? cause.status : undefined;
    return `${label} returned an unexpected response${status ? ` (${status})` : ""}. Check the token and provider URL, then try again.`;
  }

  if (cause instanceof Error) {
    const message = cause.message.toLowerCase();
    if (
      message.includes("require a personal access token") ||
      message.includes("local provider credential") ||
      message.includes("local credential")
    ) {
      return `${label} cannot use the saved token in this deployment. Replace the token to store a compatible credential here.`;
    }
    if (message.includes("provider authorization is")) {
      return `${label} authorization is no longer active. Reconnect the account before retrying.`;
    }
    if (
      message.includes("decrypt") ||
      message.includes("encrypted token") ||
      message.includes("credential is missing")
    ) {
      return `${label}'s saved token is unavailable or could not be decrypted. Replace the token to restore access.`;
    }
  }

  return `ReviewDuck could not reach ${label}. Check your network and provider URL, then try again.`;
}
