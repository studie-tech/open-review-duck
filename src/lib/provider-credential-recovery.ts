const tokenCredentialKinds = new Set(["pat", "local_pat"]);
const managedCredentialKinds = new Set(["github_app", "oauth"]);

/** Returns whether a connection can be repaired by storing a replacement PAT. */
export function supportsTokenReplacement(
  localMode: boolean,
  credentialKind: string,
) {
  return localMode || tokenCredentialKinds.has(credentialKind);
}

/** Returns whether a connection can be repaired through hosted authorization. */
export function supportsManagedReauthorization(
  localMode: boolean,
  credentialKind: string,
) {
  return !localMode && managedCredentialKinds.has(credentialKind);
}
