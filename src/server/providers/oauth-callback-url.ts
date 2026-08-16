export type HostedProvider = "github" | "gitlab";

const completionPaths: Record<HostedProvider, string> = {
  github: "/github/complete",
  gitlab: "/gitlab/complete",
};

/** Narrows an untrusted route segment to one supported SaaS provider. */
export function hostedProvider(value: string): value is HostedProvider {
  return ["github", "gitlab"].includes(value);
}

/** Returns the stable, browser-safe OAuth callback registered with a provider. */
export function oauthCallbackUrl(appUrl: string, provider: HostedProvider) {
  return new URL(completionPaths[provider], appUrl).toString();
}
