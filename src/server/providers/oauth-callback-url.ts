export type HostedProvider = "github" | "gitlab" | "azure_devops";

const completionPaths: Record<HostedProvider, string> = {
  github: "/github/complete",
  gitlab: "/gitlab/complete",
  azure_devops: "/azure-devops/complete",
};

const legacyCallbackPaths: Record<HostedProvider, string> = {
  github: "/api/integrations/github/callback",
  gitlab: "/api/integrations/gitlab/callback",
  azure_devops: "/api/integrations/azure_devops/callback",
};

/** Narrows an untrusted route segment to one supported SaaS provider. */
export function hostedProvider(value: string): value is HostedProvider {
  return ["github", "gitlab", "azure_devops"].includes(value);
}

/** Returns the stable, browser-safe OAuth callback registered with a provider. */
export function oauthCallbackUrl(appUrl: string, provider: HostedProvider) {
  return new URL(completionPaths[provider], appUrl).toString();
}

/** Resolves a state-bound callback, falling back to the legacy path for old states. */
export function stateOAuthCallbackUrl(
  appUrl: string,
  provider: HostedProvider,
  storedCallback: unknown,
) {
  const current = oauthCallbackUrl(appUrl, provider);
  const legacy = new URL(legacyCallbackPaths[provider], appUrl).toString();
  return storedCallback === current || storedCallback === legacy
    ? storedCallback
    : legacy;
}
