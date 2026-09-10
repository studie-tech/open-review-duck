import type { ProviderName } from "~/server/providers/types";

/** Which provider identity opened a comment ReviewDuck published. */
export type PublicationIdentity = "workspace" | "reviewer";

/** Returns whether a stored publication identity is one ReviewDuck understands. */
export function isPublicationIdentity(
  value: string,
): value is PublicationIdentity {
  return value === "workspace" || value === "reviewer";
}

/**
 * Returns whether this workspace connection can authorize a personal identity
 * through the provider's hosted OAuth or GitHub App user flow.
 */
export function personalCredentialUsesOAuth(
  connection: { provider: ProviderName; credentialKind: string },
  localMode: boolean,
) {
  if (localMode) return false;
  if (
    connection.provider === "github" &&
    connection.credentialKind === "github_app"
  ) {
    return true;
  }
  return (
    connection.provider === "gitlab" && connection.credentialKind === "oauth"
  );
}
