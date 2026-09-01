import type { ProviderName } from "~/server/providers/types";

const PROVIDER_LABELS = {
  github: "GitHub",
  gitlab: "GitLab",
  azure_devops: "Azure DevOps",
} as const satisfies Record<ProviderName, string>;

export const PROVIDER_NAMES = Object.keys(
  PROVIDER_LABELS,
) as (keyof typeof PROVIDER_LABELS)[];

/** Names a provider the way the connection form does. */
export function providerLabel(provider: ProviderName | string) {
  if (Object.hasOwn(PROVIDER_LABELS, provider)) {
    return PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS];
  }
  return provider;
}
