import type { z } from "zod";

/**
 * Builds the focused-answer stream schema on first use.
 *
 * The review workspace imports this module for its stream reader, so a
 * top-level Zod import puts the whole validator library in the review route's
 * initial bundle even though nothing validates until someone asks the AI a
 * question. Loading it here keeps the schema identical and defers the download.
 */
async function aiQuestionStreamUpdateSchema() {
  const { z } = await import("zod");
  return z.object({
    commentProposals: z
      .array(
        z.object({
          body: z.string(),
          path: z.string(),
          line: z.number().int().positive(),
        }),
      )
      .optional(),
    error: z.string().optional(),
    cursor: z.number().int().min(-1).optional(),
    progress: z.string(),
    status: z.enum(["working", "streaming", "completed", "failed"]),
    text: z.string(),
  });
}

export type AiQuestionStreamUpdate = z.infer<
  Awaited<ReturnType<typeof aiQuestionStreamUpdateSchema>>
>;

/** Consumes a server-sent focused-answer stream across arbitrary chunk splits. */
export async function consumeAiQuestionStream(
  response: Response,
  onUpdate: (update: AiQuestionStreamUpdate) => void,
) {
  if (!response.ok || !response.body) {
    throw new Error(`AI answer stream returned ${response.status}`);
  }
  const schema = await aiQuestionStreamUpdateSchema();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastUpdate: AiQuestionStreamUpdate | undefined;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const update = schema.safeParse(JSON.parse(data));
      if (update.success) {
        lastUpdate = update.data;
        onUpdate(update.data);
      }
    }
    if (done) return lastUpdate;
  }
}

/** Milliseconds a streamed answer update waits for a later one to supersede it. */
const AI_QUESTION_STREAM_FLUSH_MS = 100;

/**
 * Throttles streamed answer updates onto one flush window.
 *
 * The stream route emits one event per persisted chunk and every update lands
 * in workspace-level state, so applying each chunk on its own re-renders the
 * whole review tree many times per answer. Each update carries the answer text
 * so far, which makes dropping a superseded one lossless, and terminal updates
 * skip the window so a finished answer lands without delay.
 */
export function coalesceAiQuestionStreamUpdates(
  onUpdate: (update: AiQuestionStreamUpdate) => void,
  flushMs: number = AI_QUESTION_STREAM_FLUSH_MS,
) {
  let pending: AiQuestionStreamUpdate | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Closes the open window and applies the update waiting in it. */
  function flush() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const waiting = pending;
    pending = undefined;
    if (waiting) onUpdate(waiting);
  }
  return {
    /** Drops the update waiting, for a stream nobody listens to any more. */
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
    flush,
    /** Queues one update, applying it at once when it ends the stream. */
    push(update: AiQuestionStreamUpdate) {
      pending = update;
      if (update.status === "completed" || update.status === "failed") {
        flush();
        return;
      }
      if (timer === undefined) timer = setTimeout(flush, flushMs);
    },
  };
}
