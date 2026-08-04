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
      80,
    );

    expect(result.turns).toEqual([{ question: "new", answer: "answer" }]);
    expect(result.promptBytes).toBeLessThanOrEqual(80);
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

  it("keeps conversation history contiguous after an oversized turn", () => {
    const result = boundPriorConversation(
      [
        {
          createdAt: new Date("2026-08-03T00:00:00Z"),
          id: "new",
          question: "new",
          result: { summary: "fits" },
        },
        {
          createdAt: new Date("2026-08-02T00:00:00Z"),
          id: "middle",
          question: "middle",
          result: { summary: "x".repeat(200) },
        },
        {
          createdAt: new Date("2026-08-01T00:00:00Z"),
          id: "old",
          question: "old",
          result: { summary: "would fit" },
        },
      ],
      100,
    );

    expect(result.turns.map(({ question }) => question)).toEqual(["new"]);
  });

  it("tracks actual and escaped prompt sizes separately", () => {
    const result = boundPriorConversation([
      {
        createdAt: new Date("2026-08-01T00:00:00Z"),
        id: "escaped",
        question: "&&",
        result: { summary: "<>" },
      },
    ]);

    expect(result.promptBytes).toBeGreaterThan(result.bytes);
  });
});
