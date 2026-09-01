import type {
  ProviderCheckState,
  ProviderPullRequestCheck,
} from "~/server/providers/types";

export interface ProviderMergeGate {
  mergeable: boolean | null;
  canMerge: boolean;
  mergeBlockedReason?: string;
}

export interface ProviderMergeGateCheck {
  state: ProviderCheckState;
  required?: boolean;
}

export type GitHubReviewDecision =
  | "APPROVED"
  | "REVIEW_REQUIRED"
  | "CHANGES_REQUESTED";

export interface AzurePolicyEvaluationGate {
  enabled?: boolean;
  blocking?: boolean;
  deleted?: boolean;
  status?: string;
  name?: string;
}

const PENDING_CHECK_STATES = new Set<ProviderCheckState>([
  "queued",
  "in_progress",
]);

const ADO_POLICY_PENDING = new Set(["queued", "running"]);
const ADO_POLICY_REJECTED = new Set(["rejected", "broken"]);

/** True when this check is still running or waiting to start. */
export function checkIsPending(state: ProviderCheckState) {
  return PENDING_CHECK_STATES.has(state);
}

/** Checks that the provider treats as merge gates, when that is known. */
export function mergeGatingChecks<T extends ProviderMergeGateCheck>(
  checks: readonly T[],
): T[] {
  if (checks.some((check) => check.required === true)) {
    return checks.filter((check) => check.required === true);
  }
  if (checks.some((check) => check.required === false)) {
    return [];
  }
  return [...checks];
}

/** Why required checks currently block merge, if they do. */
function requiredChecksBlockReason(
  checks: readonly ProviderMergeGateCheck[],
): "pending" | "failing" | undefined {
  const required = checks.filter((check) => check.required === true);
  if (required.length === 0) return undefined;
  if (required.some((check) => check.state === "failure")) return "failing";
  if (required.some((check) => checkIsPending(check.state))) return "pending";
  return undefined;
}

/**
 * Copies provider-required flags onto already-normalized checks.
 *
 * GraphQL can list a required check that REST has not reported yet. Those
 * names become queued placeholders so a pending optional check cannot
 * unlock merge while a required check is still missing.
 */
export function applyCheckRequiredFlags(
  checks: ProviderPullRequestCheck[],
  requiredByName: ReadonlyMap<string, boolean>,
  requiredById?: ReadonlyMap<string, boolean>,
): ProviderPullRequestCheck[] {
  if (requiredByName.size === 0 && (requiredById?.size ?? 0) === 0) {
    return checks;
  }
  const flagged = checks.map((check) => {
    const required =
      requiredById?.get(check.id) ?? requiredByName.get(check.name);
    return required === undefined ? check : { ...check, required };
  });
  const presentNames = new Set(flagged.map((check) => check.name));
  const placeholders: ProviderPullRequestCheck[] = [];
  for (const [name, required] of requiredByName) {
    if (!required || presentNames.has(name)) continue;
    placeholders.push({
      id: `required-${name}`,
      name,
      state: "queued",
      required: true,
    });
    presentNames.add(name);
  }
  return placeholders.length === 0 ? flagged : [...flagged, ...placeholders];
}

/** Interprets GitHub mergeable_state using required checks and reviews. */
export function githubMergeGate(input: {
  merged?: boolean;
  closed?: boolean;
  draft?: boolean;
  mergeable?: boolean | null;
  mergeableState?: string;
  reviewDecision?: GitHubReviewDecision | null;
  checks?: readonly ProviderMergeGateCheck[];
}): ProviderMergeGate {
  if (input.merged) {
    return {
      mergeable: true,
      canMerge: false,
      mergeBlockedReason: "Already merged",
    };
  }
  if (input.closed) {
    return {
      mergeable: false,
      canMerge: false,
      mergeBlockedReason: "This pull request is closed",
    };
  }
  if (input.draft) {
    return {
      mergeable: input.mergeable ?? null,
      canMerge: false,
      mergeBlockedReason: "Draft pull requests cannot be merged",
    };
  }
  const mergeable = input.mergeable ?? null;
  const mergeableState = input.mergeableState ?? "unknown";
  if (mergeableState === "dirty" || mergeable === false) {
    return {
      mergeable: false,
      canMerge: false,
      mergeBlockedReason: "Has merge conflicts",
    };
  }
  if (mergeableState === "behind") {
    return {
      mergeable,
      canMerge: false,
      mergeBlockedReason: "Branch is behind the target and must be updated",
    };
  }
  if (mergeableState === "unknown" || mergeable === null) {
    return {
      mergeable: null,
      canMerge: false,
      mergeBlockedReason: "Mergeability is still being computed",
    };
  }
  if (
    mergeableState === "clean" ||
    mergeableState === "unstable" ||
    mergeableState === "has_hooks"
  ) {
    return { mergeable: true, canMerge: true };
  }
  if (mergeableState === "blocked") {
    return githubBlockedMergeGate(mergeable, input);
  }
  return {
    mergeable,
    canMerge: Boolean(mergeable),
    mergeBlockedReason: mergeable
      ? undefined
      : "This pull request cannot be merged yet",
  };
}

/** Interprets GitLab detailed_merge_status without adding local extra gates. */
export function gitlabMergeGate(input: {
  state?: string;
  detailedMergeStatus?: string;
  mergeStatus?: string;
  hasConflicts?: boolean;
}): ProviderMergeGate {
  if (input.state === "merged") {
    return {
      mergeable: true,
      canMerge: false,
      mergeBlockedReason: "Already merged",
    };
  }
  if (input.state === "closed") {
    return {
      mergeable: false,
      canMerge: false,
      mergeBlockedReason: "This merge request is closed",
    };
  }
  const status = input.detailedMergeStatus ?? input.mergeStatus;
  if (status === "mergeable" || status === "can_be_merged") {
    return { mergeable: true, canMerge: true };
  }
  const reasons: Record<string, string> = {
    conflict: "Has merge conflicts",
    cannot_be_merged: "Has merge conflicts",
    discussions_not_resolved: "Unresolved discussions must be resolved",
    draft_status: "Draft merge requests cannot be merged",
    ci_must_pass: "Pipeline must succeed before this can be merged",
    ci_still_running: "Pipeline is still running",
    not_approved: "Required approvals are missing",
    requested_changes: "Requested changes must be addressed",
    need_rebase: "Branch must be rebased onto the target",
    checking: "Mergeability is still being computed",
    unchecked: "Mergeability is still being computed",
    not_open: "This merge request is no longer open",
    locked_paths: "Locked files must be unlocked",
  };
  const mergeable =
    status === "conflict" || status === "cannot_be_merged" || input.hasConflicts
      ? false
      : null;
  return {
    mergeable,
    canMerge: false,
    mergeBlockedReason:
      (status && reasons[status]) || "This merge request cannot be merged yet",
  };
}

/** Interprets Azure mergeStatus plus blocking branch policies. */
export function azureMergeGate(input: {
  status?: string;
  isDraft?: boolean;
  mergeStatus?: string;
  policies?: readonly AzurePolicyEvaluationGate[];
}): ProviderMergeGate {
  if (input.status === "completed") {
    return {
      mergeable: true,
      canMerge: false,
      mergeBlockedReason: "Already completed",
    };
  }
  if (input.status === "abandoned") {
    return {
      mergeable: false,
      canMerge: false,
      mergeBlockedReason: "This pull request is abandoned",
    };
  }
  if (input.isDraft) {
    return {
      mergeable: null,
      canMerge: false,
      mergeBlockedReason: "Draft pull requests cannot be completed",
    };
  }
  if (input.mergeStatus === "conflicts") {
    return {
      mergeable: false,
      canMerge: false,
      mergeBlockedReason: "Has merge conflicts",
    };
  }
  if (input.mergeStatus === "failure") {
    return {
      mergeable: false,
      canMerge: false,
      mergeBlockedReason: "The merge could not be completed",
    };
  }
  if (input.mergeStatus === "queued") {
    return {
      mergeable: null,
      canMerge: false,
      mergeBlockedReason: "Mergeability is still being computed",
    };
  }
  const policyBlock = azurePolicyBlockReason(input.policies);
  if (input.mergeStatus === "rejectedByPolicy" || policyBlock) {
    return {
      mergeable: input.mergeStatus === "succeeded" ? true : null,
      canMerge: false,
      mergeBlockedReason: policyBlock ?? "Branch policies are not satisfied",
    };
  }
  if (input.mergeStatus === "succeeded") {
    return { mergeable: true, canMerge: true };
  }
  return {
    mergeable: null,
    canMerge: false,
    mergeBlockedReason: "Mergeability is still being computed",
  };
}

/** Maps an Azure policy evaluation onto the shared check model. */
export function azurePolicyCheckState(status: string): ProviderCheckState {
  if (status === "approved") return "success";
  if (status === "rejected" || status === "broken") return "failure";
  if (status === "queued") return "queued";
  if (status === "running") return "in_progress";
  if (status === "notapplicable" || status === "notApplicable")
    return "skipped";
  return "neutral";
}

/** Why GitHub reported blocked, refined by required checks and reviews. */
function githubBlockedMergeGate(
  mergeable: boolean | null,
  input: {
    reviewDecision?: GitHubReviewDecision | null;
    checks?: readonly ProviderMergeGateCheck[];
  },
): ProviderMergeGate {
  const blocked: ProviderMergeGate = {
    mergeable,
    canMerge: false,
    mergeBlockedReason: "Required checks or reviews are not satisfied",
  };
  if (input.reviewDecision === "REVIEW_REQUIRED") {
    return {
      ...blocked,
      mergeBlockedReason: "Required approvals are missing",
    };
  }
  if (input.reviewDecision === "CHANGES_REQUESTED") {
    return {
      ...blocked,
      mergeBlockedReason: "Requested changes must be addressed",
    };
  }
  const checks = input.checks ?? [];
  const hasRequiredInfo = checks.some((check) => check.required !== undefined);
  if (!hasRequiredInfo) return blocked;
  const requiredBlock = requiredChecksBlockReason(checks);
  if (requiredBlock) return blocked;
  if (mergeable !== true) return blocked;
  const optionalPending = checks.some(
    (check) => check.required === false && checkIsPending(check.state),
  );
  if (optionalPending) {
    return { mergeable: true, canMerge: true };
  }
  return blocked;
}

/** Why an enabled, blocking Azure policy currently prevents complete. */
function azurePolicyBlockReason(
  policies: readonly AzurePolicyEvaluationGate[] | undefined,
): string | undefined {
  if (!policies) return undefined;
  const blocking = policies.filter(
    (policy) => policy.enabled !== false && policy.blocking && !policy.deleted,
  );
  if (blocking.length === 0) return undefined;
  const rejected = blocking.find((policy) =>
    ADO_POLICY_REJECTED.has((policy.status ?? "").toLowerCase()),
  );
  if (rejected) return azurePolicyReason(rejected);
  const pending = blocking.find((policy) =>
    ADO_POLICY_PENDING.has((policy.status ?? "").toLowerCase()),
  );
  if (pending) return azurePolicyReason(pending);
  return undefined;
}

/** Names the Azure policy that is still outstanding. */
function azurePolicyReason(policy: AzurePolicyEvaluationGate) {
  const name = policy.name?.toLowerCase() ?? "";
  if (name.includes("reviewer")) return "Required approvals are missing";
  if (name.includes("work item")) return "A linked work item is required";
  if (name.includes("build") || name.includes("status")) {
    return "Required checks or reviews are not satisfied";
  }
  return "Branch policies are not satisfied";
}
