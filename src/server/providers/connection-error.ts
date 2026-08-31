import { ProviderError, type ProviderName } from "./types";

const providerLabels: Record<ProviderName, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  azure_devops: "Azure DevOps",
};

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
  const label = providerLabels[provider];

  if (cause instanceof ProviderError) {
    if (cause.status === 401) {
      return `${label} rejected this token. Create a new token, copy the complete value, and try again.`;
    }
    if (cause.status === 403) {
      const message = cause.message.toLowerCase();
      if (message.includes("rate limit")) {
        return `${label}'s API rate limit is exhausted. Wait for ${label} to reset it before retrying; repeated retries will not help.`;
      }
      if (message.includes("single sign-on")) {
        return `${label} requires organization SSO authorization for this token. Authorize it with the organization and try again.`;
      }
      return `${label} accepted the token but blocked access. ${permissionHelp[provider]}`;
    }
    if (cause.status === 404) {
      return provider === "github"
        ? "GitHub could not find this API endpoint. Check the Enterprise API URL, or leave it empty for github.com."
        : `${label} could not find this API endpoint. Check the provider URL and try again.`;
    }
    if (cause.status === 429) {
      return `${label}'s API rate limit is exhausted. Wait for ${label} to reset it before retrying; repeated retries will not help.`;
    }
    return `${label} returned an unexpected response${cause.status ? ` (${cause.status})` : ""}. Check the token and provider URL, then try again.`;
  }

  if (cause instanceof Error && cause.name === "TimeoutError") {
    return `${label} did not respond in time. Check the provider URL and try again.`;
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
