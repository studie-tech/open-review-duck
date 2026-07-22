import { ProviderError, type ProviderName } from "./types";

const providerLabels: Record<ProviderName, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  azure_devops: "Azure DevOps",
};

const permissionHelp: Record<ProviderName, string> = {
  github:
    "Confirm Contents: Read-only and Pull requests: Read and write, and approve the token for the organization if required.",
  gitlab: "Confirm the token has the api scope and at least Reporter access.",
  azure_devops:
    "Confirm the token has Code: Read & write, or Code: Read with Pull request threads: Read & write.",
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
      if (cause.message.toLowerCase().includes("rate limit")) {
        return `${label} rate-limited this verification. Wait a moment and try again.`;
      }
      return `${label} accepted the token but blocked access. ${permissionHelp[provider]}`;
    }
    if (cause.status === 404) {
      return provider === "github"
        ? "GitHub could not find this API endpoint. Check the Enterprise API URL, or leave it empty for github.com."
        : `${label} could not find this API endpoint. Check the provider URL and try again.`;
    }
    if (cause.status === 429) {
      return `${label} rate-limited this verification. Wait a moment and try again.`;
    }
    return `${label} returned an unexpected response${cause.status ? ` (${cause.status})` : ""}. Check the token and provider URL, then try again.`;
  }

  if (cause instanceof Error && cause.name === "TimeoutError") {
    return `${label} did not respond in time. Check the provider URL and try again.`;
  }

  return `ReviewDuck could not reach ${label}. Check your network and provider URL, then try again.`;
}
