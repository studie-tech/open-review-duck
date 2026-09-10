import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  providerForReviewerWrite: vi.fn(),
  providerScopeForUnit: vi.fn(),
  reviewUnitContainsLine: vi.fn(() => true),
}));

vi.mock("~/server/providers/user-credentials", () => ({
  providerForReviewerWrite: mocks.providerForReviewerWrite,
}));

vi.mock("~/server/review/provider-thread", () => ({
  providerScopeForUnit: mocks.providerScopeForUnit,
  reviewUnitContainsLine: mocks.reviewUnitContainsLine,
}));

import { publishReviewComment } from "./publish-comment";

const userId = "reviewer-one";
const jobId = "00000000-0000-4000-8000-0000000000aa";
const publishedComment = {
  id: "00000000-0000-4000-8000-0000000000bb",
  status: "published" as const,
  publishedAs: "reviewer" as const,
  aiJobId: jobId,
  aiFindingIndex: 0,
  body: "**Title**\n\nBody",
};

const scope = {
  unitId: "unit-1",
  path: "src/example.ts",
  startLine: 1,
  endLine: 40,
  relatedRanges: null,
  changeType: "modified" as const,
  snapshotId: "snap-1",
  snapshotHeadSha: "abc",
  snapshotBaseSha: "def",
  pullRequestId: "pr-1",
  pullRequestNumber: 1,
  headSha: "abc",
  baseSha: "def",
  repositoryExternalId: "repo-1",
  connection: {
    id: "conn-1",
    workspaceId: "ws-1",
    provider: "github" as const,
  },
};

const completedJob = {
  id: jobId,
  userId,
  pullRequestId: scope.pullRequestId,
  snapshotId: scope.snapshotId,
  status: "completed" as const,
  kind: "review" as const,
  parentJobId: null,
  result: {
    findings: [
      {
        path: scope.path,
        line: 12,
        title: "Title",
        body: "Body",
      },
    ],
  },
};

describe("publishReviewComment", () => {
  beforeEach(() => {
    mocks.providerScopeForUnit.mockResolvedValue(scope);
    mocks.reviewUnitContainsLine.mockReturnValue(true);
    mocks.providerForReviewerWrite.mockRejectedValue(
      new Error("missing personal credential"),
    );
  });

  it("returns a published AI comment without resolving provider credentials", async () => {
    const db = {
      query: {
        aiJobs: {
          findFirst: vi.fn().mockResolvedValue(completedJob),
        },
        reviewComments: {
          findFirst: vi.fn().mockResolvedValue(publishedComment),
        },
      },
    };

    await expect(
      publishReviewComment(db as never, userId, {
        unitId: scope.unitId,
        line: 12,
        aiJobId: jobId,
        aiFindingIndex: 0,
      }),
    ).resolves.toBe(publishedComment);
    expect(mocks.providerForReviewerWrite).not.toHaveBeenCalled();
  });
});
