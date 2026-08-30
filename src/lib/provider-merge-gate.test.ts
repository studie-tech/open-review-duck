import { describe, expect, it } from "vitest";
import {
  applyCheckRequiredFlags,
  azureMergeGate,
  githubMergeGate,
  gitlabMergeGate,
} from "./provider-merge-gate";

describe("githubMergeGate", () => {
  it("allows merge when required checks passed and optional checks are still queued", () => {
    expect(
      githubMergeGate({
        mergeable: true,
        mergeableState: "blocked",
        reviewDecision: "APPROVED",
        checks: [
          { state: "success", required: true },
          { state: "queued", required: false },
          { state: "skipped", required: false },
        ],
      }),
    ).toEqual({ mergeable: true, canMerge: true });
  });

  it("allows merge when GitHub reports unstable optional failures", () => {
    expect(
      githubMergeGate({
        mergeable: true,
        mergeableState: "unstable",
        checks: [
          { state: "success", required: true },
          { state: "failure", required: false },
        ],
      }),
    ).toEqual({ mergeable: true, canMerge: true });
  });

  it("blocks merge when a required check is still pending", () => {
    expect(
      githubMergeGate({
        mergeable: true,
        mergeableState: "blocked",
        reviewDecision: "APPROVED",
        checks: [
          { state: "in_progress", required: true },
          { state: "success", required: false },
        ],
      }),
    ).toEqual({
      mergeable: true,
      canMerge: false,
      mergeBlockedReason: "Required checks or reviews are not satisfied",
    });
  });

  it("blocks merge when a required check failed", () => {
    expect(
      githubMergeGate({
        mergeable: true,
        mergeableState: "blocked",
        reviewDecision: "APPROVED",
        checks: [{ state: "failure", required: true }],
      }),
    ).toEqual({
      mergeable: true,
      canMerge: false,
      mergeBlockedReason: "Required checks or reviews are not satisfied",
    });
  });

  it("blocks merge when required approvals are missing", () => {
    expect(
      githubMergeGate({
        mergeable: true,
        mergeableState: "blocked",
        reviewDecision: "REVIEW_REQUIRED",
        checks: [{ state: "success", required: true }],
      }),
    ).toEqual({
      mergeable: true,
      canMerge: false,
      mergeBlockedReason: "Required approvals are missing",
    });
  });

  it("blocks merge when the branch has conflicts", () => {
    expect(
      githubMergeGate({
        mergeable: false,
        mergeableState: "dirty",
        reviewDecision: "APPROVED",
        checks: [{ state: "success", required: true }],
      }),
    ).toEqual({
      mergeable: false,
      canMerge: false,
      mergeBlockedReason: "Has merge conflicts",
    });
  });

  it("keeps merge blocked when GitHub reports blocked without required-check data", () => {
    expect(
      githubMergeGate({
        mergeable: true,
        mergeableState: "blocked",
        checks: [{ state: "queued" }],
      }),
    ).toEqual({
      mergeable: true,
      canMerge: false,
      mergeBlockedReason: "Required checks or reviews are not satisfied",
    });
  });

  it("blocks merge when a required check is absent and an optional check is pending", () => {
    expect(
      githubMergeGate({
        mergeable: true,
        mergeableState: "blocked",
        reviewDecision: "APPROVED",
        checks: applyCheckRequiredFlags(
          [{ id: "status-10", name: "coverage", state: "in_progress" }],
          new Map([
            ["ci / test", true],
            ["coverage", false],
          ]),
        ),
      }),
    ).toEqual({
      mergeable: true,
      canMerge: false,
      mergeBlockedReason: "Required checks or reviews are not satisfied",
    });
  });
});

describe("gitlabMergeGate", () => {
  it("allows merge when GitLab reports mergeable while optional jobs still run", () => {
    expect(
      gitlabMergeGate({
        state: "opened",
        detailedMergeStatus: "mergeable",
      }),
    ).toEqual({ mergeable: true, canMerge: true });
  });

  it("blocks merge while a required pipeline is still running", () => {
    expect(
      gitlabMergeGate({
        state: "opened",
        detailedMergeStatus: "ci_still_running",
      }),
    ).toEqual({
      mergeable: null,
      canMerge: false,
      mergeBlockedReason: "Pipeline is still running",
    });
  });

  it("blocks merge when the pipeline must succeed and has not", () => {
    expect(
      gitlabMergeGate({
        state: "opened",
        detailedMergeStatus: "ci_must_pass",
      }),
    ).toEqual({
      mergeable: null,
      canMerge: false,
      mergeBlockedReason: "Pipeline must succeed before this can be merged",
    });
  });

  it("blocks merge when required approvals are missing", () => {
    expect(
      gitlabMergeGate({
        state: "opened",
        detailedMergeStatus: "not_approved",
      }),
    ).toEqual({
      mergeable: null,
      canMerge: false,
      mergeBlockedReason: "Required approvals are missing",
    });
  });

  it("blocks merge when the branch has conflicts", () => {
    expect(
      gitlabMergeGate({
        state: "opened",
        detailedMergeStatus: "conflict",
        hasConflicts: true,
      }),
    ).toEqual({
      mergeable: false,
      canMerge: false,
      mergeBlockedReason: "Has merge conflicts",
    });
  });

  it("treats cannot_be_merged as a known conflict", () => {
    expect(
      gitlabMergeGate({
        state: "opened",
        mergeStatus: "cannot_be_merged",
      }),
    ).toEqual({
      mergeable: false,
      canMerge: false,
      mergeBlockedReason: "Has merge conflicts",
    });
  });
});

describe("azureMergeGate", () => {
  it("allows complete when blocking policies passed and optional statuses are still pending", () => {
    expect(
      azureMergeGate({
        status: "active",
        mergeStatus: "succeeded",
        policies: [
          {
            enabled: true,
            blocking: true,
            status: "approved",
            name: "Build",
          },
          {
            enabled: true,
            blocking: false,
            status: "running",
            name: "Optional status",
          },
        ],
      }),
    ).toEqual({ mergeable: true, canMerge: true });
  });

  it("blocks complete when a required build policy is still running", () => {
    expect(
      azureMergeGate({
        status: "active",
        mergeStatus: "succeeded",
        policies: [
          {
            enabled: true,
            blocking: true,
            status: "running",
            name: "Build",
          },
        ],
      }),
    ).toEqual({
      mergeable: true,
      canMerge: false,
      mergeBlockedReason: "Required checks or reviews are not satisfied",
    });
  });

  it("blocks complete when required reviewers have not approved", () => {
    expect(
      azureMergeGate({
        status: "active",
        mergeStatus: "succeeded",
        policies: [
          {
            enabled: true,
            blocking: true,
            status: "rejected",
            name: "Minimum number of reviewers",
          },
        ],
      }),
    ).toEqual({
      mergeable: true,
      canMerge: false,
      mergeBlockedReason: "Required approvals are missing",
    });
  });

  it("blocks complete when work-item linking is required and missing", () => {
    expect(
      azureMergeGate({
        status: "active",
        mergeStatus: "succeeded",
        policies: [
          {
            enabled: true,
            blocking: true,
            status: "rejected",
            name: "Work item linking",
          },
        ],
      }),
    ).toEqual({
      mergeable: true,
      canMerge: false,
      mergeBlockedReason: "A linked work item is required",
    });
  });

  it("blocks complete when the branch has conflicts", () => {
    expect(
      azureMergeGate({
        status: "active",
        mergeStatus: "conflicts",
      }),
    ).toEqual({
      mergeable: false,
      canMerge: false,
      mergeBlockedReason: "Has merge conflicts",
    });
  });
});

describe("applyCheckRequiredFlags", () => {
  it("marks checks from GraphQL required flags by id and name", () => {
    expect(
      applyCheckRequiredFlags(
        [
          { id: "check-1", name: "ci / test", state: "success" },
          { id: "status-10", name: "coverage", state: "in_progress" },
        ],
        new Map([["coverage", false]]),
        new Map([["check-1", true]]),
      ),
    ).toEqual([
      { id: "check-1", name: "ci / test", state: "success", required: true },
      {
        id: "status-10",
        name: "coverage",
        state: "in_progress",
        required: false,
      },
    ]);
  });

  it("queues a placeholder for a GraphQL-required check that has not reported", () => {
    expect(
      applyCheckRequiredFlags(
        [{ id: "status-10", name: "coverage", state: "in_progress" }],
        new Map([
          ["ci / test", true],
          ["coverage", false],
        ]),
      ),
    ).toEqual([
      {
        id: "status-10",
        name: "coverage",
        state: "in_progress",
        required: false,
      },
      {
        id: "required-ci / test",
        name: "ci / test",
        state: "queued",
        required: true,
      },
    ]);
  });
});
