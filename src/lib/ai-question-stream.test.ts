import { describe, expect, it, vi } from "vitest";
import { consumeAiQuestionStream } from "./ai-question-stream";

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
