"use client";

import { ChevronDown, ExternalLink, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";

export type CodeProvider = "github" | "gitlab" | "azure_devops";

type ProviderGuide = {
  label: string;
  tokenKind: string;
  summary: string;
  steps: Array<
    | string
    | {
        before: string;
        linkLabel: string;
        after: string;
      }
  >;
  permissions: Array<{
    name: string;
    access: string;
    reason: string;
  }>;
  docsUrl: string;
  docsLabel: string;
};

const providerGuides: Record<CodeProvider, ProviderGuide> = {
  github: {
    label: "GitHub",
    tokenKind: "Fine-grained personal access token",
    summary:
      "A fine-grained token can access private repositories for one resource owner. Add a separate ReviewDuck connection for each user or organization you review for.",
    steps: [
      {
        before: "Open ",
        linkLabel: "GitHub’s fine-grained token page",
        after: " and choose Generate new token.",
      },
      "Name it “ReviewDuck”, add a practical expiration date, and select the user or organization that owns the repositories.",
      "Under Repository access, choose Only select repositories and select each repository you want available in ReviewDuck.",
      "Under Repository permissions, grant Contents: Read-only and Pull requests: Read and write. Metadata read access is added automatically.",
      "Generate the token, copy it immediately, and paste it into ReviewDuck. GitHub only shows the value once.",
    ],
    permissions: [
      {
        name: "Repository access",
        access: "Selected repositories",
        reason: "Prevents the token from reaching unrelated code.",
      },
      {
        name: "Contents",
        access: "Read-only",
        reason: "Reads source files at the pull request revision.",
      },
      {
        name: "Pull requests",
        access: "Read and write",
        reason: "Reads conversations and publishes inline review comments.",
      },
      {
        name: "Metadata",
        access: "Read-only · automatic",
        reason: "Lists and identifies the selected repositories.",
      },
    ],
    docsUrl:
      "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
    docsLabel: "GitHub token documentation",
  },
  gitlab: {
    label: "GitLab",
    tokenKind: "Personal, project, or group access token",
    summary:
      "Use a project or group token when company policy prefers a dedicated bot identity over a personal token.",
    steps: [
      {
        before: "For a personal token, open ",
        linkLabel: "GitLab’s personal access token page",
        after:
          ". For a project token, open the project and choose Settings → Access tokens.",
      },
      "Name it “ReviewDuck” and choose the shortest practical expiration date.",
      "Select the api scope. The read_repository and write_repository scopes alone do not authorize merge-request API comments.",
      "For project or group tokens, assign at least the Reporter role so the token can read code and comment on merge requests.",
      "Create the token, copy it immediately, and paste it into ReviewDuck. GitLab does not show the value again.",
    ],
    permissions: [
      {
        name: "Scope",
        access: "api",
        reason:
          "Reads repository and merge-request data and creates diff discussions.",
      },
      {
        name: "Access role",
        access: "Reporter or higher",
        reason:
          "Provides code visibility and permission to comment on merge requests.",
      },
      {
        name: "Token reach",
        access: "Project or group preferred",
        reason: "Keeps the integration limited to its intended projects.",
      },
    ],
    docsUrl: "https://docs.gitlab.com/user/profile/personal_access_tokens/",
    docsLabel: "GitLab token documentation",
  },
  azure_devops: {
    label: "Azure DevOps",
    tokenKind: "Personal access token",
    summary:
      "Create the token for the same organization URL you enter below and avoid all-organization access.",
    steps: [
      {
        before: "Open ",
        linkLabel: "your Azure DevOps token settings",
        after: ", then choose New Token.",
      },
      "Choose New Token, name it “ReviewDuck”, select the specific organization, and set a practical expiration date.",
      "Choose Custom defined scopes. The simplest compatible option is Code: Read & write.",
      "If your organization exposes separate thread permissions, you can instead combine Code: Read with Pull request threads: Read & write.",
      "Create the token, copy it immediately, and paste it into ReviewDuck. Azure DevOps only shows it once.",
    ],
    permissions: [
      {
        name: "Code",
        access: "Read & write",
        reason:
          "Reads repositories and pull requests and permits code-review comments.",
      },
      {
        name: "Least-privilege alternative",
        access: "Code: Read + PR threads: Read & write",
        reason:
          "Use this combination when your organization exposes the separate thread scope.",
      },
      {
        name: "Organization",
        access: "One organization",
        reason:
          "Avoids granting access to unrelated Azure DevOps organizations.",
      },
    ],
    docsUrl:
      "https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops",
    docsLabel: "Azure DevOps PAT documentation",
  },
};

/** Returns the token-management URL for a code provider connection. */
function providerTokenUrl(provider: CodeProvider, baseUrl?: string) {
  if (provider === "azure_devops") {
    if (baseUrl) {
      try {
        return `${new URL(baseUrl).href.replace(/\/+$/, "")}/_usersSettings/tokens`;
      } catch {
        // Fall through to the Azure DevOps organization picker.
      }
    }
    return "https://dev.azure.com/";
  }

  let origin: string | undefined;
  if (baseUrl) {
    try {
      origin = new URL(baseUrl).origin;
    } catch {
      origin = undefined;
    }
  }

  if (provider === "gitlab") {
    return `${origin ?? "https://gitlab.com"}/-/user_settings/personal_access_tokens`;
  }

  if (origin) return `${origin}/settings/personal-access-tokens/new`;
  return "https://github.com/settings/personal-access-tokens/new?name=ReviewDuck&description=Pull%20request%20review%20in%20ReviewDuck&contents=read&pull_requests=write";
}

/** Renders the provider token guide interface. */
export function ProviderTokenGuide({
  provider,
  baseUrl,
}: {
  provider: CodeProvider;
  baseUrl?: string;
}) {
  const guide = providerGuides[provider];
  const [open, setOpen] = useState(true);

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group/guide border-cyan/20 bg-cyan/[.025] overflow-hidden rounded-2xl border"
    >
      <summary className="hover:bg-cyan/[.035] flex cursor-pointer list-none items-center gap-3 px-4 py-4 transition marker:hidden sm:px-5">
        <span className="bg-cyan/10 grid size-9 shrink-0 place-items-center rounded-xl">
          <ShieldCheck className="text-cyan size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-cloud block text-xs font-medium">
            Create {guide.label === "Azure DevOps" ? "an" : "a"} {guide.label}{" "}
            access token
          </span>
          <span className="text-fog mt-0.5 block text-[10px]">
            {guide.tokenKind} · about 3 minutes
          </span>
        </span>
        <ChevronDown className="text-fog size-4 shrink-0 transition-transform group-open/guide:rotate-180" />
      </summary>

      <div className="border-t border-cyan/15 px-4 py-5 sm:px-5">
        <p className="text-mist text-xs leading-5">{guide.summary}</p>

        <div className="mt-5">
          <p className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
            How to create it
          </p>
          <ol className="mt-3 space-y-3">
            {guide.steps.map((step, index) => (
              <li
                key={typeof step === "string" ? step : step.linkLabel}
                className="flex gap-3"
              >
                <span className="border-cyan/20 bg-cyan/[.06] text-cyan grid size-5 shrink-0 place-items-center rounded-full border font-mono text-[9px]">
                  {index + 1}
                </span>
                <p className="text-mist pt-0.5 text-[11px] leading-5">
                  {typeof step === "string" ? (
                    step
                  ) : (
                    <>
                      {step.before}
                      <a
                        href={providerTokenUrl(provider, baseUrl)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-cyan underline decoration-cyan/35 underline-offset-2 transition hover:decoration-cyan"
                      >
                        {step.linkLabel}
                      </a>
                      {step.after}
                    </>
                  )}
                </p>
              </li>
            ))}
          </ol>
        </div>

        <div className="mt-6">
          <p className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
            Required access
          </p>
          <div className="mt-3 overflow-hidden rounded-xl border border-line">
            {guide.permissions.map((permission) => (
              <div
                key={permission.name}
                className="bg-surface/60 grid gap-2 border-b border-line px-3 py-3 last:border-b-0 sm:grid-cols-[150px_180px_1fr] sm:items-center"
              >
                <span className="text-cloud text-[10px] font-medium">
                  {permission.name}
                </span>
                <Badge className="w-fit normal-case">{permission.access}</Badge>
                <span className="text-fog text-[10px] leading-4">
                  {permission.reason}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <a
            href={providerTokenUrl(provider, baseUrl)}
            target="_blank"
            rel="noreferrer"
            className="bg-cyan text-ink hover:bg-cyan/90 inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3 text-[10px] font-medium transition"
          >
            Open {guide.label} token settings
            <ExternalLink className="size-3" />
          </a>
          <a
            href={guide.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-mist hover:text-cloud inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3 text-[10px] transition hover:bg-surface-subtle"
          >
            {guide.docsLabel}
            <ExternalLink className="size-3" />
          </a>
        </div>
      </div>
    </details>
  );
}
