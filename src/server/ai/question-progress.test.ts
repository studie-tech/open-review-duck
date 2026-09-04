import { describe, expect, it } from "vitest";
import { aiQuestionProgress, formatAiElapsed } from "./question-progress";

const createdAt = new Date("2026-09-04T10:00:00.000Z");
const now = new Date("2026-09-04T10:04:03.000Z");

describe("focused AI question progress", () => {
  it("formats short and multi-minute elapsed times", () => {
    expect(formatAiElapsed(9_900)).toBe("9s");
    expect(formatAiElapsed(243_000)).toBe("4m 03s");
  });

  it("distinguishes the local queue from the model provider", () => {
    expect(
      aiQuestionProgress({
        createdAt,
        model: "x-ai/grok-4.6",
        now,
        progress: 0,
        status: "queued",
      }),
    ).toBe("Queued for the local AI worker · 4m 03s");
    expect(
      aiQuestionProgress({
        createdAt,
        model: "x-ai/grok-4.6",
        now,
        progress: 2,
        status: "waiting_for_provider",
      }),
    ).toBe("Waiting for x-ai/grok-4.6 · investigation pass 2 · 4m 03s");
  });

  it("shows active and completed review-tool activity", () => {
    expect(
      aiQuestionProgress({
        createdAt,
        model: "x-ai/grok-4.6",
        now,
        progress: 1,
        status: "waiting_for_provider",
        tool: { status: "running", toolName: "read_file" },
      }),
    ).toBe("Reading source code · 4m 03s");
    expect(
      aiQuestionProgress({
        createdAt,
        model: "x-ai/grok-4.6",
        now,
        progress: 2,
        status: "waiting_for_provider",
        tool: { status: "completed", toolName: "search_code" },
      }),
    ).toBe(
      "Waiting for x-ai/grok-4.6 · investigation pass 2 · changed code searched · 4m 03s",
    );
  });
});
