import "server-only";

import { randomUUID } from "node:crypto";
import { type ModelMessage, tool } from "@ai-sdk/provider-utils";
import { generateText, stepCountIs } from "ai";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  aiJobChunks,
  aiJobEvidence,
  aiJobs,
  aiJobToolCalls,
  aiJobTurns,
  reviewUnits,
} from "@/drizzle/schema";
import { env } from "~/env";
import type { db as database } from "~/server/db";
import { observeOperation } from "~/server/observability/sentry";
import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";
import { hydrateReviewUnits } from "~/server/storage/review-units";
import { aiResultSchema } from "~/validators/ai";
import { resolveAiModel } from "./models";
import { createAiRepositoryContext } from "./repository-context";
import {
  acceptAiJobResult,
  settleAiJobQuota,
  type TokenUsage,
} from "./service";
import {
  bigPickleIgnoreMatcher,
  bigPickleSourceDecision,
} from "./source-policy";

type Database = typeof database;

const SYSTEM_PROMPT = `You are ReviewDuck's read-only code-review investigator.
Investigate before answering. Use list_files, search_code, and read_file to ground every material claim in the exact review revision. Do not invent files or behavior. Never expose storage URLs, credentials, hidden reasoning, or secrets. Call submit_answer only when the answer is complete and evidence-backed.`;

class FourWaySemaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  /** Runs one operation after obtaining one of four read-only tool slots. */
  async run<T>(operation: () => Promise<T>) {
    if (this.active >= 4) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

/** Persists one encrypted model message idempotently by turn sequence. */
async function persistMessage(
  db: Database,
  job: typeof aiJobs.$inferSelect,
  sequence: number,
  message: ModelMessage,
) {
  const id = randomUUID();
  await db
    .insert(aiJobTurns)
    .values({
      id,
      jobId: job.id,
      sequence,
      role: message.role,
      encryptedContent: await sealVaultSecret(
        db,
        { workspaceId: job.workspaceId, recordId: id, provider: "ai-turn" },
        JSON.stringify(message),
      ),
    })
    .onConflictDoNothing({
      target: [aiJobTurns.jobId, aiJobTurns.sequence],
    });
}

/** Restores the encrypted durable conversation for a resumed model turn. */
async function loadMessages(db: Database, job: typeof aiJobs.$inferSelect) {
  const turns = await db.query.aiJobTurns.findMany({
    where: eq(aiJobTurns.jobId, job.id),
    orderBy: [asc(aiJobTurns.sequence)],
  });
  return Promise.all(
    turns.map(async (turn) =>
      z.custom<ModelMessage>().parse(
        JSON.parse(
          await openVaultSecret(
            db,
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

/** Executes and persists one idempotent read-only tool call. */
async function persistToolCall(
  db: Database,
  job: typeof aiJobs.$inferSelect,
  turnSequence: number,
  input: {
    callId: string;
    name: string;
    arguments: unknown;
    execute: () => Promise<unknown>;
  },
) {
  const existing = await db.query.aiJobToolCalls.findFirst({
    where: and(
      eq(aiJobToolCalls.jobId, job.id),
      eq(aiJobToolCalls.toolCallId, input.callId),
    ),
  });
  if (existing?.status === "completed" && existing.encryptedOutput) {
    return JSON.parse(
      await openVaultSecret(
        db,
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
        db,
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
    await db
      .update(aiJobToolCalls)
      .set({
        status: "completed",
        encryptedOutput: await sealVaultSecret(
          db,
          {
            workspaceId: job.workspaceId,
            recordId: id,
            provider: "ai-tool-output",
          },
          JSON.stringify(output),
        ),
        durationMs: Date.now() - started,
        completedAt: new Date(),
      })
      .where(eq(aiJobToolCalls.id, id));
    return output;
  } catch (cause) {
    await db
      .update(aiJobToolCalls)
      .set({
        status: "failed",
        encryptedOutput: await sealVaultSecret(
          db,
          {
            workspaceId: job.workspaceId,
            recordId: id,
            provider: "ai-tool-output",
          },
          JSON.stringify({
            error: cause instanceof Error ? cause.message : "Tool failed",
          }),
        ),
        durationMs: Date.now() - started,
        completedAt: new Date(),
      })
      .where(eq(aiJobToolCalls.id, id));
    throw cause;
  }
}

/** Normalizes provider usage into the application ledger representation. */
function usageFromResult(result: {
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokenDetails: {
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
  };
  providerMetadata?: unknown;
}) {
  const usage = result.usage;
  const metadata = result.providerMetadata as
    | { openrouter?: { usage?: { cost?: number } } }
    | undefined;
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cacheRead: usage.inputTokenDetails.cacheReadTokens ?? 0,
    cacheWrite: usage.inputTokenDetails.cacheWriteTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    microUsd: Math.ceil((metadata?.openrouter?.usage?.cost ?? 0) * 1_000_000),
  } satisfies TokenUsage;
}

/** Executes exactly one non-retrying model turn for a durable AI job. */
export async function executeAiTurn(
  db: Database,
  jobId: string,
  turnIndex: number,
) {
  const job = await db.query.aiJobs.findFirst({ where: eq(aiJobs.id, jobId) });
  if (!job) throw new Error("AI job not found");
  if (["completed", "failed", "cancelled"].includes(job.status)) {
    return { done: true, status: job.status };
  }
  if (
    job.cancelledAt ||
    (job.startedAt &&
      Date.now() - job.startedAt.getTime() >= env.AI_MAX_DURATION_MS)
  ) {
    await finishAtLimit(db, job, "Investigation stopped at its time limit.");
    return { done: true, status: "completed" as const };
  }
  const existingTools = await db.$count(
    aiJobToolCalls,
    eq(aiJobToolCalls.jobId, job.id),
  );
  if (existingTools >= env.AI_MAX_TOOL_CALLS) {
    await finishAtLimit(db, job, "Investigation stopped at its tool limit.");
    return { done: true, status: "completed" as const };
  }
  await db
    .update(aiJobs)
    .set({
      status: "running",
      startedAt: job.startedAt ?? new Date(),
      progress: Math.min(
        95,
        Math.max(1, Math.floor((turnIndex / env.AI_MAX_MODEL_STEPS) * 100)),
      ),
    })
    .where(eq(aiJobs.id, job.id));

  let messages = await loadMessages(db, job);
  if (messages.length === 0) {
    const prompt: ModelMessage = {
      role: "user",
      content:
        job.question ??
        (job.kind === "review"
          ? "Thoroughly review this pull request. Report only actionable, evidence-backed findings."
          : "Explain the focused change and its important dependencies."),
    };
    await persistMessage(db, job, 0, prompt);
    messages = [prompt];
  }
  const storedUnits = await hydrateReviewUnits(
    db,
    await db.query.reviewUnits.findMany({
      where: eq(reviewUnits.snapshotId, job.snapshotId),
      orderBy: [asc(reviewUnits.reviewOrder)],
      limit: 5_000,
    }),
  );
  const repositoryContext = await createAiRepositoryContext(db, job);
  const repositoryPaths = await repositoryContext.listFiles();
  const ignoreFiles =
    job.provider === "opencode"
      ? await Promise.all(
          repositoryPaths
            .filter(
              (path) =>
                path === ".gitignore" ||
                path === ".openreviewignore" ||
                path.endsWith("/.gitignore") ||
                path.endsWith("/.openreviewignore"),
            )
            .slice(0, 100)
            .map(async (path) => {
              const file = await repositoryContext.readFile(path, 256_000);
              return file ? { path, source: file.source } : undefined;
            }),
        ).then((files) => files.filter((file) => file !== undefined))
      : [];
  const ignoredByRepository = bigPickleIgnoreMatcher(ignoreFiles);
  const units =
    job.provider === "opencode"
      ? storedUnits.filter(
          (unit) =>
            !ignoredByRepository(unit.path) &&
            bigPickleSourceDecision(unit.path, unit.source).allowed,
        )
      : storedUnits;
  const distinctReadPaths = new Set(
    (
      await db
        .selectDistinct({ path: aiJobEvidence.path })
        .from(aiJobEvidence)
        .where(eq(aiJobEvidence.jobId, job.id))
    ).map((row) => row.path),
  );
  const sourceBytesRead = await db
    .select({
      bytes: sql<number>`coalesce(sum(${aiJobEvidence.endByte} - ${aiJobEvidence.startByte}), 0)`,
    })
    .from(aiJobEvidence)
    .where(eq(aiJobEvidence.jobId, job.id))
    .then((rows) => Number(rows[0]?.bytes ?? 0));
  let newSourceBytes = 0;
  let submitted: z.infer<typeof aiResultSchema> | undefined;
  const semaphore = new FourWaySemaphore();
  /** Enforces the persisted global tool-call limit around one invocation. */
  const execute = (
    name: string,
    arguments_: unknown,
    callId: string,
    operation: () => Promise<unknown>,
  ) =>
    semaphore.run(() =>
      persistToolCall(db, job, turnIndex, {
        callId,
        name,
        arguments: arguments_,
        execute: operation,
      }),
    );

  const tools = {
    list_files: tool({
      description:
        "List files in the exact repository revision, with changed symbols where available. Use this to map dependencies before reading.",
      inputSchema: z.object({ query: z.string().max(200).optional() }),
      execute: (input, options) =>
        execute("list_files", input, options.toolCallId, async () => {
          const query = input.query?.toLowerCase();
          const changed = new Map<string, Array<Record<string, unknown>>>();
          for (const unit of units) {
            changed.set(unit.path, [
              ...(changed.get(unit.path) ?? []),
              {
                symbol: unit.name,
                kind: unit.kind,
                lines: [unit.startLine, unit.endLine],
                changeType: unit.changeType,
              },
            ]);
          }
          return repositoryPaths
            .filter(
              (path) =>
                (job.provider !== "opencode" ||
                  (!ignoredByRepository(path) &&
                    bigPickleSourceDecision(path, "").allowed)) &&
                (!query ||
                  path.toLowerCase().includes(query) ||
                  (changed.get(path) ?? []).some((symbol) =>
                    String(symbol.symbol).toLowerCase().includes(query),
                  )),
            )
            .slice(0, 500)
            .map((path) => ({
              path,
              changedSymbols: (changed.get(path) ?? []).slice(0, 25),
            }));
        }),
    }),
    search_code: tool({
      description:
        "Search changed source text with a literal, case-insensitive query.",
      inputSchema: z.object({
        query: z.string().min(2).max(300),
        pathPrefix: z.string().max(1_000).optional(),
      }),
      execute: (input, options) =>
        execute("search_code", input, options.toolCallId, async () => {
          const query = input.query.toLowerCase();
          return units
            .filter(
              (unit) =>
                (!input.pathPrefix || unit.path.startsWith(input.pathPrefix)) &&
                unit.source.toLowerCase().includes(query),
            )
            .slice(0, 100)
            .map((unit) => ({
              path: unit.path,
              symbol: unit.name,
              line: unit.startLine,
              excerpt: unit.source.slice(0, 1_000),
            }));
        }),
    }),
    semantic_search: tool({
      description:
        "Find compiler-indexed symbol definitions and references for this exact revision when a SCIP artifact is available.",
      inputSchema: z.object({ query: z.string().min(2).max(300) }),
      execute: (input, options) =>
        execute("semantic_search", input, options.toolCallId, async () => {
          const result = await repositoryContext.searchSemantics(input.query);
          return {
            ...result,
            matches:
              job.provider === "opencode"
                ? result.matches.filter(
                    (match) =>
                      !ignoredByRepository(match.path) &&
                      bigPickleSourceDecision(match.path, "").allowed,
                  )
                : result.matches,
          };
        }),
    }),
    read_file: tool({
      description:
        "Read a bounded line range from any file in the exact repository revision. Repeated reads return the same content digest.",
      inputSchema: z
        .object({
          path: z.string().min(1).max(2_000),
          startLine: z.number().int().positive().default(1),
          endLine: z.number().int().positive().max(100_000),
        })
        .refine(
          ({ startLine, endLine }) =>
            endLine >= startLine && endLine - startLine <= 4_000,
          "Read ranges must contain at most 4,001 lines",
        ),
      execute: (input, options) =>
        execute("read_file", input, options.toolCallId, async () => {
          if (
            !distinctReadPaths.has(input.path) &&
            distinctReadPaths.size >= env.AI_MAX_DISTINCT_FILES
          ) {
            return { limit: "distinct_files" };
          }
          const remainingBytes =
            env.AI_MAX_SOURCE_BYTES - sourceBytesRead - newSourceBytes;
          if (remainingBytes <= 0) return { limit: "source_bytes" };
          const file = await repositoryContext.readFile(
            input.path,
            Math.min(remainingBytes, 1_000_000),
          );
          if (!file) {
            return {
              error:
                "File is absent, binary, too large, or unavailable in this exact revision",
            };
          }
          if (
            job.provider === "opencode" &&
            (ignoredByRepository(input.path) ||
              !bigPickleSourceDecision(input.path, file.source).allowed)
          ) {
            return {
              error: "File is protected by the free-model source policy",
            };
          }
          const lines = file.source.match(/[^\n]*(?:\n|$)/g) ?? [];
          const before = lines
            .slice(0, Math.max(0, input.startLine - 1))
            .join("");
          const source = lines
            .slice(Math.max(0, input.startLine - 1), input.endLine)
            .join("")
            .replace(/\n$/, "");
          const startByte = Buffer.byteLength(before);
          const bytes = Buffer.byteLength(source);
          if (
            sourceBytesRead + newSourceBytes + bytes >
            env.AI_MAX_SOURCE_BYTES
          ) {
            return { limit: "source_bytes" };
          }
          newSourceBytes += bytes;
          distinctReadPaths.add(input.path);
          await db
            .insert(aiJobEvidence)
            .values({
              jobId: job.id,
              snapshotFileId: file.snapshotFileId,
              sourceBlobId: file.blob.id,
              path: input.path,
              digest: file.blob.digest,
              startByte,
              endByte: startByte + bytes,
              startLine: input.startLine,
              endLine:
                input.startLine + Math.max(0, source.split("\n").length - 1),
            })
            .onConflictDoNothing();
          return {
            path: input.path,
            startLine: input.startLine,
            endLine: input.startLine + source.split("\n").length - 1,
            source,
          };
        }),
    }),
    submit_answer: tool({
      description:
        "Submit the final evidence-backed answer. Call only after sufficient investigation.",
      inputSchema: aiResultSchema,
      execute: (input, options) =>
        execute("submit_answer", input, options.toolCallId, async () => {
          submitted = input;
          return { accepted: true };
        }),
    }),
  };

  const resolved = await resolveAiModel(db, {
    workspaceId: job.workspaceId,
    provider: job.provider ?? "",
    model: job.model ?? "",
  });
  const result = await observeOperation("ai.model-turn", "ai.model", () =>
    generateText({
      model: resolved.model,
      system: SYSTEM_PROMPT,
      messages,
      tools,
      stopWhen: stepCountIs(1),
      maxRetries: 0,
      maxOutputTokens: 8_000,
      timeout: Math.min(120_000, env.AI_MAX_DURATION_MS),
      providerOptions: resolved.providerOptions,
      telemetry: { isEnabled: false },
    }),
  );
  const sequenceStart = messages.length;
  for (const [offset, message] of result.responseMessages.entries()) {
    await persistMessage(db, job, sequenceStart + offset, message);
  }
  if (result.text) {
    const chunkId = randomUUID();
    const currentChunkCount = await db.$count(
      aiJobChunks,
      eq(aiJobChunks.jobId, job.id),
    );
    await db
      .insert(aiJobChunks)
      .values({
        id: chunkId,
        jobId: job.id,
        sequence: currentChunkCount,
        kind: "text",
        encryptedContent: await sealVaultSecret(
          db,
          {
            workspaceId: job.workspaceId,
            recordId: chunkId,
            provider: "ai-chunk",
          },
          result.text,
        ),
      })
      .onConflictDoNothing();
    await db
      .update(aiJobs)
      .set({ status: "streaming" })
      .where(eq(aiJobs.id, job.id));
  }
  const usage = usageFromResult(result);
  await accumulateUsage(db, job.id, usage);
  if (submitted) {
    await acceptAiJobResult(db, job.id, submitted);
    await settleAiJobQuota(db, job.id, await totalUsage(db, job.id));
    return { done: true, status: "completed" as const };
  }
  return { done: false, status: "running" as const };
}

/** Adds one model turn's provider usage to its job. */
async function accumulateUsage(db: Database, jobId: string, usage: TokenUsage) {
  await db
    .update(aiJobs)
    .set({
      inputTokens: sql`${aiJobs.inputTokens} + ${usage.input}`,
      outputTokens: sql`${aiJobs.outputTokens} + ${usage.output}`,
      cacheReadTokens: sql`${aiJobs.cacheReadTokens} + ${usage.cacheRead}`,
      cacheWriteTokens: sql`${aiJobs.cacheWriteTokens} + ${usage.cacheWrite}`,
      totalTokens: sql`${aiJobs.totalTokens} + ${usage.totalTokens}`,
      actualMicroUsd: sql`${aiJobs.actualMicroUsd} + ${usage.microUsd ?? 0}`,
    })
    .where(eq(aiJobs.id, jobId));
}

/** Reads the accumulated usage used for quota settlement. */
async function totalUsage(db: Database, jobId: string): Promise<TokenUsage> {
  const job = await db.query.aiJobs.findFirst({ where: eq(aiJobs.id, jobId) });
  if (!job) throw new Error("AI job not found");
  return {
    input: job.inputTokens,
    output: job.outputTokens,
    cacheRead: job.cacheReadTokens,
    cacheWrite: job.cacheWriteTokens,
    totalTokens: job.totalTokens,
    microUsd: job.actualMicroUsd,
  };
}

/** Completes a bounded investigation with an explicitly labelled partial answer. */
export async function finishAiJobAtInvestigationLimit(
  db: Database,
  jobId: string,
) {
  const job = await db.query.aiJobs.findFirst({ where: eq(aiJobs.id, jobId) });
  if (!job || ["completed", "failed", "cancelled"].includes(job.status)) return;
  await finishAtLimit(
    db,
    job,
    "Investigation limit reached before the model submitted a final answer.",
  );
}

/** Completes an exhausted investigation with an evidence-backed partial answer. */
async function finishAtLimit(
  db: Database,
  job: typeof aiJobs.$inferSelect,
  reason: string,
) {
  const chunks = await db.query.aiJobChunks.findMany({
    where: eq(aiJobChunks.jobId, job.id),
    orderBy: [asc(aiJobChunks.sequence)],
  });
  const text = (
    await Promise.all(
      chunks.map((chunk) =>
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
  ).join("\n");
  await acceptAiJobResult(
    db,
    job.id,
    {
      summary: `Partial answer — ${reason}\n\n${text || "No answer text was produced."}`,
      commentProposals: [],
      annotations: [],
      findings: [],
    },
    "investigation_limit",
  );
  await settleAiJobQuota(db, job.id, await totalUsage(db, job.id));
}

/** Marks a provider failure terminal and settles the reservation once. */
export async function failAiJob(db: Database, jobId: string, cause: unknown) {
  const error = cause instanceof Error ? cause.message : "AI provider failed";
  await db
    .update(aiJobs)
    .set({
      status: "failed",
      completionReason: "provider_failure",
      error,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(aiJobs.id, jobId),
        sql`${aiJobs.status} not in ('completed', 'cancelled')`,
      ),
    );
  await settleAiJobQuota(db, jobId, await totalUsage(db, jobId));
}
