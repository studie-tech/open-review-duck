const tokenCredentialKinds = new Set(["pat", "local_pat"]);
const managedCredentialKinds = new Set(["github_app", "oauth"]);

/** Returns whether a connection can be repaired by storing a replacement PAT. */
export function supportsTokenReplacement(
  localMode: boolean,
  credentialKind: string,
) {
  return localMode || tokenCredentialKinds.has(credentialKind);
}

/**
 * Providers with no hosted authorization flow to send a reviewer through.
 *
 * Azure DevOps is reached with a personal access token and nothing else, so a
 * connection of its can only be repaired by replacing that token. A legacy row
 * can still carry a managed credential kind — the column has no per-provider
 * constraint, and this repository's own tests build one — so the kind alone
 * cannot say whether a reconnect is possible.
 */
const providersWithoutHostedAuthorization = new Set(["azure_devops"]);

/** Returns whether a connection can be repaired through hosted authorization. */
export function supportsManagedReauthorization(
  localMode: boolean,
  credentialKind: string,
  provider: string,
) {
  return (
    !localMode &&
    managedCredentialKinds.has(credentialKind) &&
    !providersWithoutHostedAuthorization.has(provider)
  );
}
