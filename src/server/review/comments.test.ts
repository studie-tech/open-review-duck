import { describe, expect, it } from "vitest";
import {
  providerCommentBody,
  publicationAttemptKey,
  publishedThreadForComment,
  visibleProviderCommentBody,
} from "./comments";

const commentId = "5dc41c5e-0935-46d2-8674-1de5f60d0384";

describe("provider comment idempotency", () => {
  it("adds and hides a stable publication marker", () => {
    const providerBody = providerCommentBody("Please rename this.", commentId);

    expect(providerBody).toContain(`reviewduck-comment:${commentId}`);
    expect(visibleProviderCommentBody(providerBody)).toBe(
      "Please rename this.",
    );
  });

  it("reuses one provider key across overlapping publication leases", () => {
    const first = publicationAttemptKey(commentId);
    const retry = publicationAttemptKey(commentId);

    expect(first).toBe(retry);
    expect(first).toBe(commentId);
  });

  it("reconciles a provider thread after an ambiguous publish response", () => {
    const thread = {
      externalId: "thread-42",
      path: "src/example.ts",
      line: 12,
      side: "right" as const,
      status: "open" as const,
      comments: [
        {
          externalId: "comment-42",
          body: providerCommentBody("Please rename this.", commentId),
          author: "reviewer",
          createdAt: "2026-07-22T12:00:00.000Z",
        },
      ],
    };

    expect(publishedThreadForComment([thread], commentId)).toBe(thread);
    expect(
      publishedThreadForComment(
        [thread],
        "4e7a842a-003a-4bc0-9756-b2384901d3c0",
      ),
    ).toBeUndefined();
  });
});
