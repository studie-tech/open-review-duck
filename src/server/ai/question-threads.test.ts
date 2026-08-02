import { describe, expect, it } from "vitest";
import { withAiQuestionConversationIds } from "./question-threads";

describe("withAiQuestionConversationIds", () => {
  it("keeps explicit threads separate and chronologically ordered", () => {
    const result = withAiQuestionConversationIds([
      {
        createdAt: new Date("2026-07-24T12:01:00Z"),
        id: "b",
        threadId: "22222222-2222-4222-8222-222222222222",
      },
      {
        createdAt: new Date("2026-07-24T12:00:00Z"),
        id: "a",
        threadId: "11111111-1111-4111-8111-111111111111",
      },
    ]);

    expect(result.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(result.map(({ conversationId }) => conversationId)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
  });

  it("rejects a persisted question without its required thread", () => {
    expect(() =>
      withAiQuestionConversationIds([
        {
          createdAt: new Date("2026-07-24T12:00:00Z"),
          id: "missing-thread",
          threadId: null,
        },
      ]),
    ).toThrow("missing a conversation ID");
  });

  it("uses IDs to order equal timestamps deterministically", () => {
    const createdAt = new Date("2026-07-24T12:00:00Z");
    const result = withAiQuestionConversationIds([
      {
        createdAt,
        id: "b",
        threadId: "22222222-2222-4222-8222-222222222222",
      },
      {
        createdAt,
        id: "a",
        threadId: "11111111-1111-4111-8111-111111111111",
      },
    ]);

    expect(result.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(result.map(({ conversationId }) => conversationId)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
  });
});
