import { createHash, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, isNotNull, lt, lte, sql } from "drizzle-orm";
import { after, type NextRequest } from "next/server";
import { aiJobChunks, aiJobs, aiStreamLeases } from "@/drizzle/schema";
import type { AiQuestionStreamUpdate } from "~/lib/ai-question-stream";
import { applicationAuth } from "~/server/auth";
import { db } from "~/server/db";
import { enforceRateLimit } from "~/server/security/rate-limit";
import { openVaultSecret } from "~/server/security/vault";

export const runtime = "nodejs";
export const maxDuration = 800;

const encoder = new TextEncoder();
const STREAM_LEASE_MILLISECONDS = 45_000;
const MAX_CONCURRENT_STREAMS = 4;

/** Acquires one renewable per-user stream slot under a transaction lock. */
async function acquireStreamLease(userId: string, jobId: string) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`ai-stream:${userId}`}, 0))`,
    );
    await tx
      .delete(aiStreamLeases)
      .where(
        and(
          eq(aiStreamLeases.userId, userId),
          lt(aiStreamLeases.expiresAt, new Date()),
        ),
      );
    const active = await tx.$count(
      aiStreamLeases,
      eq(aiStreamLeases.userId, userId),
    );
    if (active >= MAX_CONCURRENT_STREAMS) return undefined;
    const id = randomUUID();
    await tx.insert(aiStreamLeases).values({
      id,
      userId,
      jobId,
      expiresAt: new Date(Date.now() + STREAM_LEASE_MILLISECONDS),
    });
    return id;
  });
}

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
  const targetKey = createHash("sha256").update(jobId).digest("hex");
  try {
    await enforceRateLimit(
      db,
      `ai-stream-user:${authentication.userId}`,
      20,
      60_000,
    );
    await enforceRateLimit(
      db,
      `ai-stream:${authentication.userId}:${targetKey}`,
      8,
      60_000,
    );
  } catch (cause) {
    if (!(cause instanceof TRPCError) || cause.code !== "TOO_MANY_REQUESTS") {
      throw cause;
    }
    return Response.json(
      { error: "Too many AI stream connections" },
      { status: 429 },
    );
  }
  const job = await db.query.aiJobs.findFirst({
    where: and(
      eq(aiJobs.id, jobId),
      eq(aiJobs.userId, authentication.userId),
      isNotNull(aiJobs.question),
    ),
  });
  if (!job) return Response.json({ error: "Not found" }, { status: 404 });
  const streamLeaseId = await acquireStreamLease(authentication.userId, job.id);
  if (!streamLeaseId) {
    return Response.json(
      { error: "Too many concurrent AI stream connections" },
      { status: 429 },
    );
  }
  const requestedCursor = Number(
    request.nextUrl.searchParams.get("cursor") ?? -1,
  );
  /** Closes the current SSE response and is replaced after stream startup. */
  let close = () => undefined;
  /** Signals post-response cleanup after every terminal stream path. */
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  after(async () => {
    await Promise.race([
      closed,
      new Promise<void>((resolve) => setTimeout(resolve, 60_000)),
    ]);
    await db
      .delete(aiStreamLeases)
      .where(eq(aiStreamLeases.id, streamLeaseId))
      .catch(() => undefined);
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let cursor = Number.isSafeInteger(requestedCursor) ? requestedCursor : -1;
      let text = "";
      let closed = false;
      const keepAlive = setInterval(() => {
        if (closed) return;
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
        void db
          .update(aiStreamLeases)
          .set({
            expiresAt: new Date(Date.now() + STREAM_LEASE_MILLISECONDS),
          })
          .where(eq(aiStreamLeases.id, streamLeaseId))
          .returning({ id: aiStreamLeases.id })
          .then(([renewed]) => {
            if (!renewed) close();
          })
          // A transient database error should not tear down a healthy stream;
          // the next heartbeat retries, while the lease TTL remains the bound.
          .catch(() => undefined);
      }, 15_000);
      close = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        markClosed();
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
          const [chunks, current] = await Promise.all([
            db.query.aiJobChunks.findMany({
              where: and(
                eq(aiJobChunks.jobId, job.id),
                gt(aiJobChunks.sequence, cursor),
              ),
              orderBy: [asc(aiJobChunks.sequence)],
              limit: 100,
            }),
            db.query.aiJobs.findFirst({
              columns: { status: true, result: true, error: true },
              where: eq(aiJobs.id, job.id),
            }),
          ]);
          for (const chunk of chunks) {
            text += await openVaultSecret(
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
        close();
      })().catch((cause: unknown) => {
        if (closed || request.signal.aborted) return;
        try {
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
        } finally {
          close();
        }
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
