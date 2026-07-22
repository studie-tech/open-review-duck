import { describe, expect, it } from "vitest";
import type { ProviderReviewThread } from "~/server/providers/types";
import {
  assignProviderThreadsToUnits,
  canCarryReviewWait,
  hasNewProviderActivity,
  providerActivityForUnit,
} from "./waiting";

const threads: ProviderReviewThread[] = [
  {
    externalId: "thread-1",
    path: "src/review.ts",
    line: 12,
    side: "right",
    status: "open",
    comments: [
      {
        externalId: "comment-1",
        author: "reviewer",
        body: "Could this be a constant?",
        createdAt: "2026-07-20T12:00:00.000Z",
      },
      {
        externalId: "comment-2",
        author: "author",
        body: "Yes, I will update it.",
        createdAt: "2026-07-20T12:05:00.000Z",
      },
    ],
  },
  {
    externalId: "thread-2",
    path: "src/other.ts",
    line: 4,
    side: "right",
    status: "open",
    comments: [
      {
        externalId: "comment-1",
        author: "reviewer",
        body: "Unrelated",
        createdAt: "2026-07-20T12:00:00.000Z",
      },
    ],
  },
];

describe("providerActivityForUnit", () => {
  it("records thread-scoped comment identifiers for the selected code unit", () => {
    expect(
      providerActivityForUnit(threads, {
        path: "src/review.ts",
        startLine: 10,
        endLine: 20,
      }),
    ).toEqual({
      providerThreadIds: ["thread-1"],
      observedCommentIds: ["thread-1:comment-1", "thread-1:comment-2"],
    });
  });

  it("continues tracking a known thread if its provider line moves", () => {
    expect(
      providerActivityForUnit(
        threads,
        {
          path: "src/review.ts",
          startLine: 30,
          endLine: 40,
        },
        ["thread-1"],
      ).providerThreadIds,
    ).toEqual(["thread-1"]);
  });
});

describe("assignProviderThreadsToUnits", () => {
  const overlappingUnits = [
    {
      id: "module",
      path: "src/review.ts",
      kind: "module",
      startLine: 1,
      endLine: 40,
    },
    {
      id: "function",
      path: "src/review.ts",
      kind: "function",
      startLine: 10,
      endLine: 20,
    },
  ];

  it("assigns provider-native threads to the smallest matching code unit", () => {
    expect(
      assignProviderThreadsToUnits(threads, overlappingUnits)[0]?.unitId,
    ).toBe("function");
  });

  it("keeps ReviewDuck-published threads on the exact originating unit", () => {
    expect(
      assignProviderThreadsToUnits(
        threads,
        overlappingUnits,
        new Map([["thread-1", "module"]]),
      )[0]?.unitId,
    ).toBe("module");
  });
});

describe("hasNewProviderActivity", () => {
  it("wakes a unit for a new reply, including providers with per-thread IDs", () => {
    expect(
      hasNewProviderActivity(
        ["thread-1:comment-1"],
        ["thread-1:comment-1", "thread-1:comment-2"],
      ),
    ).toBe(true);
  });

  it("does not wake a unit when a previously observed comment disappears", () => {
    expect(
      hasNewProviderActivity(
        ["thread-1:comment-1", "thread-1:comment-2"],
        ["thread-1:comment-1"],
      ),
    ).toBe(false);
  });
});

describe("canCarryReviewWait", () => {
  it("carries waiting state only while the exact code chunk is unchanged", () => {
    expect(canCarryReviewWait("same", "same")).toBe(true);
    expect(canCarryReviewWait("before", "after")).toBe(false);
  });
});
