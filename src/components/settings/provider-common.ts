import type { CodeProvider } from "~/components/settings/provider-token-guide";
import type { RouterOutputs } from "~/trpc/react";

export type Connection = RouterOutputs["provider"]["listConnections"][number];
export type ImportedRepository =
  RouterOutputs["provider"]["listImportedRepositories"][number];
export type Provider = CodeProvider;
export type IntakeMode = ImportedRepository["reviewIntakeMode"];

/** Either side of the settings console: an account or one of its repositories. */
export type SettingsSelection = {
  kind: "connection" | "repository";
  id: string;
};

export const providers: Array<{
  id: Provider;
  label: string;
  description: string;
  hostedDescription: string;
}> = [
  {
    id: "github",
    label: "GitHub",
    description: "Fine-grained token · code read + PR comments",
    hostedDescription: "GitHub App or fine-grained token",
  },
  {
    id: "gitlab",
    label: "GitLab",
    description: "api scope · personal, project, or group token",
    hostedDescription: "OAuth or personal, project, or group token",
  },
  {
    id: "azure_devops",
    label: "Azure DevOps",
    description: "PAT · Code (Read & write) permission",
    hostedDescription: "Organization PAT · Code (Read & write) permission",
  },
];

/**
 * Names a provider the way the connection form does.
 *
 * A two-way test read every provider that was not GitHub as GitLab, so an
 * Azure DevOps connection offered to reconnect the wrong one.
 */
export function providerLabel(provider: string) {
  return providers.find(({ id }) => id === provider)?.label ?? provider;
}

/** Returns the user-facing authorization method for a saved connection. */
export function credentialLabel(kind: string) {
  if (kind === "github_app") return "GitHub App";
  if (kind === "oauth") return "OAuth";
  return "PAT";
}

export const intakeModeMeta: Record<
  IntakeMode,
  { label: string; badgeClassName: string }
> = {
  manual: {
    label: "Manual",
    badgeClassName: "border-line bg-surface-subtle text-mist",
  },
  assigned: {
    label: "Assigned",
    badgeClassName: "border-cyan/25 bg-cyan/[.07] text-cyan",
  },
  all: {
    label: "All PRs",
    badgeClassName: "border-lime/30 bg-lime/[.08] text-lime",
  },
};
