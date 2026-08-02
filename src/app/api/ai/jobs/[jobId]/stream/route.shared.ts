import { and, asc, eq, gt, isNotNull, lte } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { aiJobChunks, aiJobs } from "@/drizzle/schema";
import type { AiQuestionStreamUpdate } from "~/lib/ai-question-stream";
import { applicationAuth } from "~/server/auth";
import { db } from "~/server/db";
import { openVaultSecret } from "~/server/security/vault";

export const runtime = "nodejs";
export const maxDuration = 800;

const encoder = new TextEncoder();

/** Waits for the next chunk poll while remaining abortable. */
function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Streams persisted AI chunks with a reconnectable numeric cursor. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const authentication = await applicationAuth();
  if (!authentication.userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { jobId } = await params;
  const job = await db.query.aiJobs.findFirst({
    where: and(
      eq(aiJobs.id, jobId),
      eq(aiJobs.userId, authentication.userId),
      isNotNull(aiJobs.question),
    ),
  });
  if (!job) return Response.json({ error: "Not found" }, { status: 404 });
  const requestedCursor = Number(
    request.nextUrl.searchParams.get("cursor") ?? -1,
  );
  /** Closes the current SSE response and is replaced after stream startup. */
  let close = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let cursor = Number.isSafeInteger(requestedCursor) ? requestedCursor : -1;
      let text = "";
      let closed = false;
      const keepAlive = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": keep-alive\n\n"));
      }, 15_000);
      close = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        controller.close();
      };
      request.signal.addEventListener("abort", close, { once: true });
      /** Emits one normalized SSE update. */
      const send = (update: AiQuestionStreamUpdate) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(update)}\n\n`),
        );
      };
      void (async () => {
        if (cursor >= 0) {
          const precedingChunks = await db.query.aiJobChunks.findMany({
            where: and(
              eq(aiJobChunks.jobId, job.id),
              lte(aiJobChunks.sequence, cursor),
            ),
            orderBy: [asc(aiJobChunks.sequence)],
            limit: 5_000,
          });
          text = (
            await Promise.all(
              precedingChunks.map((chunk) =>
                openVaultSecret(
                  db,
                  {
                    workspaceId: job.workspaceId,
                    recordId: chunk.id,
                    provider: "ai-chunk",
                  },
                  chunk.encryptedContent,
                ),
              ),
            )
          ).join("");
          cursor = precedingChunks.at(-1)?.sequence ?? -1;
        }
        while (!closed && !request.signal.aborted) {
          const chunks = await db.query.aiJobChunks.findMany({
            where: and(
              eq(aiJobChunks.jobId, job.id),
              gt(aiJobChunks.sequence, cursor),
            ),
            orderBy: [asc(aiJobChunks.sequence)],
            limit: 100,
          });
          for (const chunk of chunks) {
            text += await openVaultSecret(
              db,
              {
                workspaceId: job.workspaceId,
                recordId: chunk.id,
                provider: "ai-chunk",
              },
              chunk.encryptedContent,
            );
            cursor = chunk.sequence;
            send({
              progress: "Writing the answer…",
              status: "streaming",
              text,
              cursor,
            });
          }
          const current = await db.query.aiJobs.findFirst({
            columns: { status: true, result: true, error: true },
            where: eq(aiJobs.id, job.id),
          });
          if (!current) {
            send({
              error: "The AI job was deleted.",
              progress: "Answer deleted",
              status: "failed",
              text,
              cursor,
            });
            close();
            return;
          }
          if (current.status === "completed") {
            send({
              commentProposals: current.result?.commentProposals,
              progress: "Answer complete",
              status: "completed",
              text: current.result?.summary ?? text,
              cursor,
            });
            close();
            return;
          }
          if (current.status === "failed" || current.status === "cancelled") {
            send({
              error:
                current.error ??
                (current.status === "cancelled"
                  ? "The AI answer was cancelled."
                  : "The AI answer could not be completed."),
              progress:
                current.status === "cancelled"
                  ? "Answer cancelled"
                  : "Answer interrupted",
              status: "failed",
              text,
              cursor,
            });
            close();
            return;
          }
          if (chunks.length === 0) {
            send({
              progress:
                current.status === "waiting_for_provider"
                  ? "Waiting for the model provider…"
                  : "Investigating the review revision…",
              status: "working",
              text,
              cursor,
            });
          }
          await delay(500, request.signal);
        }
      })().catch((cause: unknown) => {
        if (closed || request.signal.aborted) return;
        send({
          error:
            cause instanceof Error
              ? cause.message
              : "The live AI answer stream was interrupted.",
          progress: "Answer interrupted",
          status: "failed",
          text,
          cursor,
        });
        close();
      });
    },
    cancel() {
      close();
    },
  });
  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
