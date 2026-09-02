// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
}));

vi.mock("~/trpc/react", () => ({
  api: {
    ai: {
      start: {
        useMutation: () => ({ isPending: false, mutate: mocks.mutate }),
      },
    },
  },
}));

vi.mock("./review-workspace-diff", () => ({
  showAiStartError: vi.fn(),
}));

import { useAiQuestionStreamController } from "./use-ai-question-stream-controller";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useAiQuestionStreamController", () => {
  it("claims a logical question synchronously before React pending state updates", () => {
    const { result } = renderHook(() =>
      useAiQuestionStreamController({
        onQuestionsChanged: vi.fn(),
        onUsageChanged: vi.fn(),
        pullRequestId: "11111111-1111-4111-8111-111111111111",
      }),
    );
    const input = {
      canAsk: true,
      focusLine: 42,
      question: "Why is this guard needed?",
      threadId: "33333333-3333-4333-8333-333333333333",
      unitId: "22222222-2222-4222-8222-222222222222",
    };

    let first: string | undefined;
    let repeated: string | undefined;
    act(() => {
      first = result.current.askQuestion(input);
      repeated = result.current.askQuestion(input);
    });

    expect(first).toBe(input.threadId);
    expect(repeated).toBeUndefined();
    expect(mocks.mutate).toHaveBeenCalledOnce();
    expect(mocks.mutate.mock.calls[0]?.[0]).toMatchObject({
      focusLine: input.focusLine,
      kind: "explain",
      pullRequestId: "11111111-1111-4111-8111-111111111111",
      question: input.question,
      threadId: input.threadId,
      unitId: input.unitId,
      clientRequestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
    expect(result.current.liveQuestions).toHaveLength(1);
  });
});
