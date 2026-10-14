import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  reviewSnapshots,
  reviewUnits,
  reviewWaits,
  users,
} from "@/drizzle/schema";
import { createCallerFactory } from "~/server/api/trpc";
import { db } from "~/server/db";
import type {
  ProviderPullRequestComment,
  ProviderReviewThread,
} from "~/server/providers/types";
import { createMovedCodeFixture } from "~/test/moved-code-fixture";
import { reviewRouter } from "./review";

const provider = vi.hoisted(() => ({
  inline: vi.fn<() => Promise<ProviderReviewThread[]>>(),
  general: vi.fn<() => Promise<ProviderPullRequestComment[]>>(),
}));
vi.mock("~/server/providers/credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/server/providers/credentials")>()),
  providerForConnection: vi.fn(async () => ({
    listInlineCommentThreads: provider.inline,
    listPullRequestComments: provider.general,
  })),
}));

let fixture: Awaited<ReturnType<typeof createMovedCodeFixture>>;
let unit: typeof reviewUnits.$inferSelect;
const createCaller = createCallerFactory(reviewRouter);
const general: ProviderPullRequestComment = {
  externalId: "issue-comment:42",
  kind: "comment",
  body: "Commentary\n\n![Screenshot](https://github.com/user-attachments/assets/screenshot.png)",
  author: "reviewer",
  createdAt: "2026-10-13T19:34:02Z",
  webUrl: "https://github.com/commerce/storefront/pull/184#issuecomment-42",
};

/** Calls the real router with an owner or a caller outside the workspace. */
function caller(userId: string | null) {
  return createCaller({
    db,
    auth: { userId, has: () => true },
    headers: new Headers(),
  });
}

beforeAll(async () => {
  fixture = await createMovedCodeFixture();
  const selected = await db.query.reviewUnits.findFirst({
    where: and(
      eq(reviewUnits.snapshotId, fixture.snapshotId),
      ne(reviewUnits.kind, "file"),
    ),
  });
  if (!selected) throw new Error("Expected an analyzed code unit");
  unit = selected;
});
beforeEach(() => {
  vi.clearAllMocks();
  provider.inline.mockResolvedValue([]);
  provider.general.mockResolvedValue([general]);
});
afterAll(async () => {
  if (fixture) {
    await db
      .delete(reviewSnapshots)
      .where(eq(reviewSnapshots.id, fixture.snapshotId));
    await db.delete(users).where(eq(users.id, fixture.ownerId));
  }
});

describe("PR-wide conversation reads", () => {
  it("returns general commentary and screenshots even when the PR has no inline threads", async () => {
    provider.general.mockResolvedValueOnce([
      {
        ...general,
        body: `${general.body}\n\n<!-- reviewduck-comment:${randomUUID()} -->`,
      },
    ]);
    const result = await caller(fixture.ownerId).providerConversations({
      pullRequestId: fixture.pullRequestId,
    });
    expect(result.threads).toEqual([]);
    expect(result.pullRequestComments).toEqual([general]);
    expect(result.answeredUnitIds).toEqual([]);
  });

  it("does not treat PR comments as replies to paused code units or assign them to code", async () => {
    const inline: ProviderReviewThread = {
      externalId: "thread-42",
      path: unit.path,
      line: unit.startLine,
      side: "right",
      status: "open",
      comments: [
        {
          externalId: "inline-42",
          author: "reviewer",
          body: "Code comment",
          createdAt: "2026-10-13T18:00:00Z",
        },
      ],
    };
    provider.inline.mockResolvedValueOnce([inline]);
    await db.insert(reviewWaits).values({
      userId: fixture.ownerId,
      unitId: unit.id,
      providerThreadIds: [inline.externalId],
      observedCommentIds: ["thread-42:inline-42"],
    });
    const result = await caller(fixture.ownerId).providerConversations({
      pullRequestId: fixture.pullRequestId,
    });
    expect(result.threads).toEqual([
      expect.objectContaining({
        externalId: inline.externalId,
        unitId: unit.id,
      }),
    ]);
    expect(result.pullRequestComments).toEqual([general]);
    expect(result.answeredUnitIds).toEqual([]);
    expect(
      await db.query.reviewWaits.findFirst({
        where: eq(reviewWaits.unitId, unit.id),
      }),
    ).toBeDefined();
  });

  it("authorizes workspace access before reading either provider comment source", async () => {
    await expect(
      caller(`other-${randomUUID()}`).providerConversations({
        pullRequestId: fixture.pullRequestId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller(null).providerConversations({
        pullRequestId: fixture.pullRequestId,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(provider.inline).not.toHaveBeenCalled();
    expect(provider.general).not.toHaveBeenCalled();
  });

  it("reports a failed PR-comment read instead of silently claiming there are no comments", async () => {
    provider.general.mockRejectedValueOnce(
      new Error("Comment source unavailable"),
    );
    await expect(
      caller(fixture.ownerId).providerConversations({
        pullRequestId: fixture.pullRequestId,
      }),
    ).rejects.toMatchObject({ code: "BAD_GATEWAY" });
  });
});
