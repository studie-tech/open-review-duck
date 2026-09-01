import "server-only";

import { randomUUID } from "node:crypto";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { type aiJobs, aiJobToolCalls, aiJobTurns } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";

type Database = typeof database;
type DurableAiJob = Pick<typeof aiJobs.$inferSelect, "id" | "workspaceId">;

export interface DurableToolCallInput {
  callId: string;
  name: string;
  arguments: unknown;
  execute: () => Promise<unknown>;
  /** Produces the only error text retained in the encrypted replay ledger. */
  sanitizeError: (cause: unknown) => string;
}

/** Persists one encrypted model message idempotently by turn sequence. */
export async function persistAiMessage(
  db: Database,
  job: DurableAiJob,
  sequence: number,
  message: ModelMessage,
): Promise<void> {
  const id = randomUUID();
  await db
    .insert(aiJobTurns)
    .values({
      id,
      jobId: job.id,
      sequence,
      role: message.role,
      encryptedContent: await sealVaultSecret(
        { workspaceId: job.workspaceId, recordId: id, provider: "ai-turn" },
        JSON.stringify(message),
      ),
    })
    .onConflictDoNothing({
      target: [aiJobTurns.jobId, aiJobTurns.sequence],
    });
}

/** Restores an AI job's encrypted durable conversation in sequence order. */
export async function loadAiMessages(
  db: Database,
  job: DurableAiJob,
): Promise<ModelMessage[]> {
  const turns = await db.query.aiJobTurns.findMany({
    where: eq(aiJobTurns.jobId, job.id),
    orderBy: [asc(aiJobTurns.sequence)],
  });
  return Promise.all(
    turns.map(async (turn) =>
      z.custom<ModelMessage>().parse(
        JSON.parse(
          await openVaultSecret(
            {
              workspaceId: job.workspaceId,
              recordId: turn.id,
              provider: "ai-turn",
            },
            turn.encryptedContent,
          ),
        ),
      ),
    ),
  );
}

/** Executes one read-only tool call or replays its encrypted completed output. */
export async function executeDurableToolCall(
  db: Database,
  job: DurableAiJob,
  turnSequence: number,
  input: DurableToolCallInput,
): Promise<unknown> {
  const existing = await db.query.aiJobToolCalls.findFirst({
    where: and(
      eq(aiJobToolCalls.jobId, job.id),
      eq(aiJobToolCalls.toolCallId, input.callId),
    ),
  });
  if (existing?.status === "completed" && existing.encryptedOutput) {
    return JSON.parse(
      await openVaultSecret(
        {
          workspaceId: job.workspaceId,
          recordId: existing.id,
          provider: "ai-tool-output",
        },
        existing.encryptedOutput,
      ),
    ) as unknown;
  }

  const id = existing?.id ?? randomUUID();
  if (!existing) {
    await db.insert(aiJobToolCalls).values({
      id,
      jobId: job.id,
      turnSequence,
      toolCallId: input.callId,
      toolName: input.name,
      encryptedInput: await sealVaultSecret(
        {
          workspaceId: job.workspaceId,
          recordId: id,
          provider: "ai-tool-input",
        },
        JSON.stringify(input.arguments),
      ),
    });
  }

  const started = Date.now();
  try {
    const output = await input.execute();
    await persistToolOutcome(db, {
      id,
      workspaceId: job.workspaceId,
      status: "completed",
      output,
      started,
    });
    return output;
  } catch (cause) {
    await persistToolOutcome(db, {
      id,
      workspaceId: job.workspaceId,
      status: "failed",
      output: { error: input.sanitizeError(cause) },
      started,
    });
    throw cause;
  }
}

/** Seals and records the terminal result of one durable tool execution. */
async function persistToolOutcome(
  db: Database,
  input: {
    id: string;
    workspaceId: string;
    status: "completed" | "failed";
    output: unknown;
    started: number;
  },
): Promise<void> {
  await db
    .update(aiJobToolCalls)
    .set({
      status: input.status,
      encryptedOutput: await sealVaultSecret(
        {
          workspaceId: input.workspaceId,
          recordId: input.id,
          provider: "ai-tool-output",
        },
        JSON.stringify(input.output),
      ),
      durationMs: Date.now() - input.started,
      completedAt: new Date(),
    })
    .where(eq(aiJobToolCalls.id, input.id));
}
