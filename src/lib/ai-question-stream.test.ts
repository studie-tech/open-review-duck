import { afterEach, describe, expect, it, vi } from "vitest";
import {
  coalesceAiQuestionStreamUpdates,
  consumeAiQuestionStream,
} from "./ai-question-stream";

describe("consumeAiQuestionStream", () => {
  it("decodes updates split across network chunks", async () => {
    const update = vi.fn();
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"progress":"Writing","status":"streaming","te',
            ),
          );
          controller.enqueue(encoder.encode('xt":"Part"}\n\n: keep-alive\n\n'));
          controller.enqueue(
            encoder.encode(
              'data: {"progress":"Done","status":"completed","text":"Complete"}\n\n',
            ),
          );
          controller.close();
        },
      }),
      { status: 200 },
    );

    const finalUpdate = await consumeAiQuestionStream(response, update);

    expect(update).toHaveBeenNthCalledWith(1, {
      progress: "Writing",
      status: "streaming",
      text: "Part",
    });
    expect(update).toHaveBeenNthCalledWith(2, {
      progress: "Done",
      status: "completed",
      text: "Complete",
    });
    expect(finalUpdate).toEqual({
      progress: "Done",
      status: "completed",
      text: "Complete",
    });
  });
});

describe("coalesceAiQuestionStreamUpdates", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies only the latest chunk of a burst once the window closes", () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const updates = coalesceAiQuestionStreamUpdates(apply, 100);

    for (const text of ["A", "AB", "ABC"]) {
      updates.push({ progress: "Writing", status: "streaming", text });
    }
    expect(apply).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({
      progress: "Writing",
      status: "streaming",
      text: "ABC",
    });
  });

  it("applies a terminal update immediately and only once", () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const updates = coalesceAiQuestionStreamUpdates(apply, 100);

    updates.push({ progress: "Writing", status: "streaming", text: "A" });
    updates.push({
      progress: "Answer complete",
      status: "completed",
      text: "AB",
    });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({
      progress: "Answer complete",
      status: "completed",
      text: "AB",
    });

    vi.advanceTimersByTime(100);

    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("flushes the waiting chunk on request and drops it on cancel", () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const updates = coalesceAiQuestionStreamUpdates(apply, 100);

    updates.push({ progress: "Writing", status: "streaming", text: "A" });
    updates.flush();

    expect(apply).toHaveBeenCalledWith({
      progress: "Writing",
      status: "streaming",
      text: "A",
    });

    updates.push({ progress: "Writing", status: "streaming", text: "AB" });
    updates.cancel();
    vi.advanceTimersByTime(100);

    expect(apply).toHaveBeenCalledTimes(1);
  });
});
