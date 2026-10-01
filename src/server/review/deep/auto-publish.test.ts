import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  payload: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("~/server/review/deep/payload", () => ({
  deepReviewRunPayload: mocks.payload,
}));

vi.mock("~/server/review/publish-comment", () => ({
  publishReviewComment: mocks.publish,
}));

import {
  autoPublishDeepReviewFindings,
  reviewUnitForAutoPublish,
  unpublishedAutoPublishFindings,
} from "./auto-publish";

const parentJobId = "00000000-0000-4000-8000-0000000000bb";
const workspaceId = "00000000-0000-4000-8000-0000000000aa";
const snapshotId = "00000000-0000-4000-8000-0000000000cc";
const userId = "reviewer-one";
const unitId = "00000000-0000-4000-8000-0000000000dd";

const job = {
  id: parentJobId,
  workspaceId,
  snapshotId,
  userId,
  kind: "review" as const,
  parentJobId: null,
  status: "completed" as const,
  deepReviewTerminalState: "complete" as const,
  runFailureClass: null,
  completionReason: null,
  error: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  completedAt: new Date("2026-01-01T00:05:00.000Z"),
};

/** Builds one snapshot unit with only the fields auto-publish reads. */
function unit(overrides: {
  id?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
}) {
  return {
    id: overrides.id ?? unitId,
    path: overrides.path ?? "src/alpha.ts",
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 40,
    changeType: "modified" as const,
    relatedRanges: null,
  };
}

describe("unpublishedAutoPublishFindings", () => {
  it("keeps only publishable findings that have not been posted", () => {
    expect(
      unpublishedAutoPublishFindings(
        [
          {
            id: "f-open",
            path: "src/alpha.ts",
            startLine: 12,
            publishable: true,
          },
          {
            id: "f-posted",
            path: "src/alpha.ts",
            startLine: 20,
            publishable: true,
          },
          {
            id: "f-hidden",
            path: "src/alpha.ts",
            startLine: 30,
            publishable: false,
          },
        ],
        ["f-posted"],
      ),
    ).toEqual([{ id: "f-open", path: "src/alpha.ts", startLine: 12 }]);
  });
});

describe("reviewUnitForAutoPublish", () => {
  it("picks the innermost unit that contains the line", () => {
    expect(
      reviewUnitForAutoPublish(
        [
          unit({ id: "wide", startLine: 1, endLine: 80 }),
          unit({ id: "narrow", startLine: 10, endLine: 20 }),
        ],
        "src/alpha.ts",
        12,
      )?.id,
    ).toBe("narrow");
  });

  it("returns nothing when no unit of that file contains the line", () => {
    expect(
      reviewUnitForAutoPublish(
        [unit({ startLine: 1, endLine: 8 })],
        "src/alpha.ts",
        40,
      ),
    ).toBeNull();
  });
});

describe("autoPublishDeepReviewFindings", () => {
  beforeEach(() => {
    mocks.payload.mockReset();
    mocks.publish.mockReset();
  });

  it("does nothing when the workspace asked to validate findings first", async () => {
    const db = {
      query: {
        aiJobs: { findFirst: async () => job },
        aiPreferences: {
          findFirst: async () => ({ autoPublishFindings: false }),
        },
        reviewUnits: { findMany: async () => [] },
      },
    };

    await expect(
      autoPublishDeepReviewFindings(db as never, parentJobId),
    ).resolves.toEqual({ published: 0, failed: 0 });
    expect(mocks.payload).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("posts each remaining publishable finding on its unit", async () => {
    mocks.payload.mockResolvedValue({
      findings: [
        {
          id: "f-open",
          path: "src/alpha.ts",
          startLine: 12,
          publishable: true,
        },
      ],
      publishedFindingIds: [],
    });
    mocks.publish.mockResolvedValue({ id: "comment-1" });
    const db = {
      query: {
        aiJobs: { findFirst: async () => job },
        aiPreferences: {
          findFirst: async () => ({ autoPublishFindings: true }),
        },
        reviewUnits: { findMany: async () => [unit({})] },
      },
    };

    await expect(
      autoPublishDeepReviewFindings(db as never, parentJobId),
    ).resolves.toEqual({ published: 1, failed: 0 });
    expect(mocks.publish).toHaveBeenCalledWith(db, userId, {
      unitId,
      line: 12,
      aiJobId: parentJobId,
      aiFindingId: "f-open",
    });
  });

  it("continues after one finding fails to post", async () => {
    mocks.payload.mockResolvedValue({
      findings: [
        {
          id: "f-fail",
          path: "src/alpha.ts",
          startLine: 12,
          publishable: true,
        },
        {
          id: "f-ok",
          path: "src/alpha.ts",
          startLine: 20,
          publishable: true,
        },
      ],
      publishedFindingIds: [],
    });
    mocks.publish
      .mockRejectedValueOnce(new Error("provider refused"))
      .mockResolvedValueOnce({ id: "comment-2" });
    const db = {
      query: {
        aiJobs: { findFirst: async () => job },
        aiPreferences: {
          findFirst: async () => ({ autoPublishFindings: true }),
        },
        reviewUnits: { findMany: async () => [unit({})] },
      },
    };

    await expect(
      autoPublishDeepReviewFindings(db as never, parentJobId),
    ).resolves.toEqual({ published: 1, failed: 1 });
    expect(mocks.publish).toHaveBeenCalledTimes(2);
  });
});
