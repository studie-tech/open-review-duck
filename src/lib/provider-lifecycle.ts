import { checkIsPending, mergeGatingChecks } from "~/lib/provider-merge-gate";
import type {
  ProviderCheckState,
  ProviderCheckSummary,
  ProviderPullRequestCheck,
  ProviderPullRequestLifecycle,
} from "~/server/providers/types";

/** Rolls individual check states into the badge shown after a review. */
export function providerCheckSummary(
  checks: readonly Pick<ProviderPullRequestCheck, "state" | "required">[],
): ProviderCheckSummary {
  if (checks.length === 0) return "empty";
  const gating = mergeGatingChecks(checks);
  if (gating.some((check) => check.state === "failure")) return "failing";
  if (checks.some((check) => check.state === "failure")) return "failing";
  if (gating.some((check) => checkIsPending(check.state))) return "pending";
  return "passing";
}

/** Builds the provider lifecycle payload shared by GitHub, GitLab, and Azure. */
export function buildProviderLifecycle(input: {
  checks: ProviderPullRequestCheck[];
  pullRequestState: ProviderPullRequestLifecycle["pullRequestState"];
  headSha: string;
  mergeable: boolean | null;
  canMerge: boolean;
  mergeBlockedReason?: string;
  mergeActionLabel: string;
}): ProviderPullRequestLifecycle {
  return {
    ...input,
    summary: providerCheckSummary(input.checks),
  };
}

/** Returns a short label for one normalized check state. */
export function providerCheckStateLabel(state: ProviderCheckState) {
  if (state === "in_progress") return "Running";
  if (state === "queued") return "Queued";
  if (state === "success") return "Passed";
  if (state === "failure") return "Failed";
  if (state === "cancelled") return "Cancelled";
  if (state === "skipped") return "Skipped";
  return "Neutral";
}

/** Returns the summary badge copy for the completion-page checks card. */
export function providerLifecycleSummaryLabel(
  summary: ProviderCheckSummary,
  checkCount: number,
  options?: { canMerge?: boolean; optionalPending?: boolean },
) {
  if (summary === "failing") {
    return checkCount === 1 ? "1 check failed" : "Checks failed";
  }
  if (summary === "pending") {
    return options?.canMerge ? "Checked & ready" : "Checks running";
  }
  if (summary === "passing") {
    if (options?.optionalPending) return "Checked & ready";
    return checkCount === 1 ? "Check passed" : "All checks passed";
  }
  return "No checks reported";
}

/** Polls while CI is still running or mergeability has not been computed. */
export function followPendingProviderLifecycle(query: {
  state: {
    data?: {
      summary?: ProviderCheckSummary;
      mergeable?: boolean | null;
      pullRequestState?: ProviderPullRequestLifecycle["pullRequestState"];
    };
  };
}) {
  const data = query.state.data;
  if (!data) return false;
  if (data.summary === "pending") return 8_000;
  if (
    data.mergeable === null &&
    (data.pullRequestState === "open" || data.pullRequestState === "draft")
  ) {
    return 8_000;
  }
  return false;
}
