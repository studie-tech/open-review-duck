import {
  supportsManagedReauthorization,
  supportsTokenReplacement,
} from "~/lib/provider-credential-recovery";
import { providerLabel } from "~/lib/provider-labels";

export type ProviderPermissionKind = "merge" | "review" | "sync";

export type ProviderPermissionName = "github" | "gitlab" | "azure_devops";

export interface ProviderConnectionRecovery {
  connectionId: string;
  credentialKind: string;
  canReplaceToken: boolean;
  canReconnect: boolean;
}

const mergeAccess: Record<ProviderPermissionName, string> = {
  github: "Contents: Read and write",
  gitlab: "api scope and Developer or higher",
  azure_devops: "Code: Read & write",
};

const reviewAccess: Record<ProviderPermissionName, string> = {
  github: "Pull requests: Read and write",
  gitlab: "api scope and Developer or higher",
  azure_devops: "Code: Read & write",
};

const syncAccess: Record<ProviderPermissionName, string> = {
  github: "Contents: Read-only and Pull requests: Read-only",
  gitlab: "api or read_api scope",
  azure_devops: "Code: Read",
};

/** Builds the provider-settings URL that focuses one connection. */
export function providerSettingsHref(connectionId: string, repair?: "token") {
  const params = new URLSearchParams({ connection: connectionId });
  if (repair) params.set("repair", repair);
  return `/settings/providers?${params}`;
}

/** Returns the access a reviewer must grant to perform one provider action. */
export function providerRequiredAccess(
  provider: ProviderPermissionName,
  kind: ProviderPermissionKind,
) {
  if (kind === "review") return reviewAccess[provider];
  if (kind === "sync") return syncAccess[provider];
  return mergeAccess[provider];
}

/** Builds the recovery metadata stored on live provider review payloads. */
export function providerConnectionRecovery(
  localMode: boolean,
  connection: {
    id: string;
    credentialKind: string;
    provider: string;
  },
): ProviderConnectionRecovery {
  return {
    connectionId: connection.id,
    credentialKind: connection.credentialKind,
    canReplaceToken: supportsTokenReplacement(
      localMode,
      connection.credentialKind,
    ),
    canReconnect: supportsManagedReauthorization(
      localMode,
      connection.credentialKind,
      connection.provider,
    ),
  };
}

/** True when a GitHub credential can merge from the repository permission object. */
export function githubViewerCanMerge(permissions?: {
  admin?: boolean;
  maintain?: boolean;
  push?: boolean;
}) {
  if (!permissions) return true;
  return Boolean(permissions.admin || permissions.maintain || permissions.push);
}

/** Copy and actions that take a reviewer from a blocked merge or review to a fix. */
export function providerPermissionRecovery(
  provider: ProviderPermissionName,
  kind: ProviderPermissionKind,
  connection?: ProviderConnectionRecovery,
) {
  const label = providerLabel(provider);
  const requiredAccess = providerRequiredAccess(provider, kind);
  const finishLabel =
    provider === "azure_devops"
      ? kind === "merge"
        ? "Complete on Azure DevOps"
        : "Finish on Azure DevOps"
      : kind === "merge"
        ? `Merge on ${label}`
        : `Finish on ${label}`;
  const githubApp = connection?.credentialKind === "github_app";
  const replaceHref = connection
    ? providerSettingsHref(
        connection.connectionId,
        connection.canReplaceToken ? "token" : undefined,
      )
    : "/settings/providers";

  if (kind === "sync") {
    return {
      title: `${label} could not be synchronized`,
      description: `ReviewDuck could not refresh this pull request from ${label}. Update the connection if access looks wrong, or finish the remaining steps on ${label}.`,
      requiredAccess,
      finishLabel,
      settingsHref: replaceHref,
      settingsLabel: "Open provider settings",
      reconnect: Boolean(connection?.canReconnect && !githubApp),
      replaceToken: Boolean(connection?.canReplaceToken),
    };
  }

  if (kind === "review") {
    return {
      title: `This connection cannot submit a ${label} review`,
      description: githubApp
        ? "GitHub App installations can read review state, but a personal approval has to be submitted with your GitHub user. Open the pull request to finish there, or connect a token with pull-request write access."
        : `${label} did not allow this review decision. Grant ${requiredAccess}, then ${connection?.canReplaceToken ? "replace the token" : "reconnect the provider"}.`,
      requiredAccess,
      finishLabel,
      settingsHref: replaceHref,
      settingsLabel: connection?.canReplaceToken
        ? "Update token permissions"
        : "Open provider settings",
      reconnect: Boolean(connection?.canReconnect && !githubApp),
      replaceToken: Boolean(connection?.canReplaceToken),
    };
  }

  if (githubApp) {
    return {
      title: "This GitHub App cannot merge",
      description:
        "The connected GitHub App can review this pull request but its token does not include Contents: Read and write, so ReviewDuck cannot merge it. Grant that permission on the installation, then reconnect so ReviewDuck can mint a token that includes it. You can also merge on GitHub.",
      requiredAccess,
      finishLabel,
      settingsHref: replaceHref,
      settingsLabel: connection.canReconnect
        ? "Reconnect GitHub"
        : "Open provider settings",
      reconnect: Boolean(connection.canReconnect),
      replaceToken: Boolean(connection.canReplaceToken),
    };
  }

  return {
    title: `This connection cannot merge on ${label}`,
    description: `${label} accepted the connection but did not grant merge permission. Grant ${requiredAccess}, then ${connection?.canReplaceToken ? "replace the token" : "reconnect the provider"}, or finish the merge on ${label}.`,
    requiredAccess,
    finishLabel,
    settingsHref: replaceHref,
    settingsLabel: connection?.canReplaceToken
      ? "Update token permissions"
      : connection?.canReconnect
        ? `Reconnect ${label}`
        : "Open provider settings",
    reconnect: Boolean(connection?.canReconnect),
    replaceToken: Boolean(connection?.canReplaceToken),
  };
}
