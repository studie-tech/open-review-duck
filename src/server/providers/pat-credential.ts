import "server-only";

import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";
import { normalizeAzureOrganizationUrl } from "./azure-organization-url";
import type { ProviderName } from "./types";

interface ProviderPatContext {
  connectionId: string;
  provider: ProviderName;
  workspaceId: string;
}

/** Restricts SaaS PATs to supported hosted providers and normalizes Azure URLs. */
export function hostedPatBaseUrl(
  provider: ProviderName,
  baseUrl: string | undefined,
) {
  if (provider === "azure_devops") {
    if (!baseUrl) throw new Error("Azure DevOps requires an organization URL");
    return normalizeAzureOrganizationUrl(baseUrl);
  }
  if (baseUrl) {
    throw new Error(
      "SaaS PAT connections support GitHub.com and GitLab.com only",
    );
  }
  return undefined;
}

/** Encrypts a hosted provider PAT inside its exact tenant and connection boundary. */
export function sealProviderPat(context: ProviderPatContext, token: string) {
  return sealVaultSecret(
    {
      workspaceId: context.workspaceId,
      recordId: context.connectionId,
      provider: `${context.provider}-pat`,
    },
    token,
  );
}

/** Opens a hosted provider PAT only inside its original authenticated boundary. */
export function openProviderPat(
  context: ProviderPatContext,
  encryptedToken: string,
) {
  return openVaultSecret(
    {
      workspaceId: context.workspaceId,
      recordId: context.connectionId,
      provider: `${context.provider}-pat`,
    },
    encryptedToken,
  );
}
