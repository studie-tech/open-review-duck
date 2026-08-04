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

  it("fences overlapping publication attempts with distinct keys", () => {
    const first = publicationAttemptKey(
      commentId,
      "e7e68139-726e-486c-87da-89593e77ac38",
    );
    const retry = publicationAttemptKey(
      commentId,
      "86527c56-4dd4-4141-897c-e61445151827",
    );

    expect(first).not.toBe(retry);
    expect(first).toContain(commentId);
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
