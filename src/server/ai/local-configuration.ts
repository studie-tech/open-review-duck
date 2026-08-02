import "server-only";

import { z } from "zod";
import type { localAiConfigurations } from "@/drizzle/schema";
import { openVaultSecret } from "~/server/security/vault";

export const localAiSecretSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
});

export type LocalAiSecret = z.infer<typeof localAiSecretSchema>;

/** Reads one local AI secret, returning no configuration when it is damaged. */
export async function readLocalAiSecret(
  workspaceId: string,
  configuration: typeof localAiConfigurations.$inferSelect,
) {
  try {
    return localAiSecretSchema.parse(
      JSON.parse(
        await openVaultSecret(
          {
            workspaceId,
            recordId: configuration.id,
            provider: configuration.provider,
          },
          configuration.encryptedConfiguration,
        ),
      ),
    );
  } catch {
    return undefined;
  }
}

interface CredentialUpdate {
  apiKey?: string;
  baseUrl: string;
  clearApiKey: boolean;
  clearHeaders: boolean;
  headers: Record<string, string>;
}

/** Normalizes a provider endpoint without changing its host or route. */
function normalizeProviderEndpoint(value: string) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.href;
}

/** Compares provider endpoints without treating a trailing slash as a change. */
export function sameProviderEndpoint(left: string, right: string) {
  return normalizeProviderEndpoint(left) === normalizeProviderEndpoint(right);
}

/** Applies explicit replacement and clearing without replaying secrets to a new host. */
export function resolveLocalAiCredentials(
  input: CredentialUpdate,
  previous: LocalAiSecret | undefined,
) {
  const reusable =
    previous && sameProviderEndpoint(input.baseUrl, previous.baseUrl)
      ? previous
      : undefined;
  return {
    apiKey: input.clearApiKey ? undefined : (input.apiKey ?? reusable?.apiKey),
    headers: input.clearHeaders
      ? {}
      : Object.keys(input.headers).length > 0
        ? input.headers
        : (reusable?.headers ?? {}),
  };
}
