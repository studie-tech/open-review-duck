import { describe, expect, it } from "vitest";
import { boundPriorConversation } from "./prior-conversation";

describe("prior AI conversation", () => {
  it("keeps the newest complete turns inside the byte limit", () => {
    const result = boundPriorConversation(
      [
        {
          createdAt: new Date("2026-08-01T00:00:00Z"),
          id: "old",
          question: "old",
          result: { summary: "x".repeat(80) },
        },
        {
          createdAt: new Date("2026-08-02T00:00:00Z"),
          id: "new",
          question: "new",
          result: { summary: "answer" },
        },
      ],
      300,
    );

    expect(result.turns).toEqual([{ question: "new", answer: "answer" }]);
    expect(result.bytes).toBeLessThanOrEqual(300);
  });

  it("returns selected turns in chronological order", () => {
    const result = boundPriorConversation([
      {
        createdAt: new Date("2026-08-02T00:00:00Z"),
        id: "new",
        question: "second",
        result: { summary: "two" },
      },
      {
        createdAt: new Date("2026-08-01T00:00:00Z"),
        id: "old",
        question: "first",
        result: { summary: "one" },
      },
    ]);

    expect(result.turns.map(({ question }) => question)).toEqual([
      "first",
      "second",
    ]);
  });
});
