import { AzureDevOpsProvider } from "./azure-devops";
import { GitHubProvider } from "./github";
import { GitLabProvider } from "./gitlab";
import type { ProviderName, PullRequestProvider } from "./types";

/** Creates the provider adapter for a stored code-host connection. */
export function createProvider(
  name: ProviderName,
  token: string,
  baseUrl?: string,
  credentialKind?: string,
): PullRequestProvider {
  const normalizedBaseUrl = baseUrl?.replace(/\/+$/, "");
  if (name === "github")
    return new GitHubProvider(
      token,
      normalizedBaseUrl,
      credentialKind === "github_app",
    );
  if (name === "gitlab") return new GitLabProvider(token, normalizedBaseUrl);
  if (credentialKind !== "pat" && credentialKind !== "local_pat") {
    throw new Error("Azure DevOps connections require a personal access token");
  }
  if (!normalizedBaseUrl)
    throw new Error("Azure DevOps connections require an organization URL");
  return new AzureDevOpsProvider(token, normalizedBaseUrl);
}

export * from "./types";
