const MAX_ACTIVE_AUTOMATIC_SYNCS_PER_REPOSITORY = 1;

/** Returns the remaining automatic synchronization capacity for one repository. */
export function automaticSyncSlots(activeSyncs: number) {
  return Math.max(0, MAX_ACTIVE_AUTOMATIC_SYNCS_PER_REPOSITORY - activeSyncs);
}

/** Retries a failed PR only when an explicit reconciliation allows it. */
export function shouldRetryFailedAutomaticSync(input: {
  force?: boolean;
  retryFailed?: boolean;
}) {
  return input.retryFailed ?? input.force === true;
}

/** Reports whether a connection can represent one human reviewer's identity. */
export function supportsAssignedIntake(connection: {
  provider: "github" | "gitlab" | "azure_devops";
  credentialKind: string;
}) {
  return !(
    connection.provider === "github" &&
    connection.credentialKind === "github_app"
  );
}
