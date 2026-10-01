export type HostedProvider = "github" | "gitlab" | "azure_devops";

export type TerminalPullRequestState = "merged" | "closed";

type PullRequestWebhook = {
  provider: HostedProvider;
  event: string;
  action?: string;
  state?: string;
  merged?: boolean;
};

/**
 * Identifies webhook events that only need to retire a tracked pull request.
 * Terminal events must not start analysis because they cannot produce a new
 * reviewable revision and would briefly put the completed PR back in the inbox.
 */
export function terminalPullRequestState(
  webhook: PullRequestWebhook,
): TerminalPullRequestState | undefined {
  const action = webhook.action?.toLowerCase();
  const state = webhook.state?.toLowerCase();
  if (webhook.provider === "github") {
    if (webhook.event !== "pull_request" || action !== "closed") {
      return undefined;
    }
    return webhook.merged ? "merged" : "closed";
  }
  if (webhook.provider === "gitlab") {
    if (webhook.event !== "Merge Request Hook") return undefined;
    if (action === "merge" || state === "merged") return "merged";
    if (action === "close" || state === "closed") return "closed";
    return undefined;
  }
  if (webhook.event === "git.pullrequest.merged" || state === "completed") {
    return "merged";
  }
  return state === "abandoned" ? "closed" : undefined;
}
