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
  managedAiModels,
  pullRequests,
  reviewUnits,
} from "@/drizzle/schema";
import { reviewDuckAgentPrompt } from "~/config/prompts";
import { env } from "~/env";
import { createBoundedSemaphore } from "~/lib/concurrency";
import {
  explainPromptBodies,
  loadAiPromptBodies,
} from "~/server/ai/prompt-store";
import type { db as database } from "~/server/db";
import { observeOperation } from "~/server/observability/sentry";
import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";
import { hydrateReviewUnits } from "~/server/storage/review-units";
import { aiResultSchema } from "~/validators/ai";
import { explanationChangedLineRanges } from "./change-scope";
import {
  executeDurableToolCall,
  loadAiMessages,
  persistAiMessage,
} from "./durable-state";
import { resolveAiModel } from "./models";
import { loadPriorConversation } from "./prior-conversation";
import { createAiRepositoryContext } from "./repository-context";
import {
  acceptAiJobResult,
  settleAiJobQuota,
  type TokenUsage,
} from "./service";
import { aiIgnoreMatcher, sourcePolicyDecision } from "./source-policy";
import {
  acceptFirstFinalSubmission,
  boundedTurnOutput,
  estimatePendingInputTokens,
} from "./turn-guards";
import { untrustedFileSource } from "./untrusted-content";
import { accumulateAiUsage, providerUsage } from "./usage";

type Database = typeof database;
const EMBEDDED_UNIT_SOURCE_MAX_BYTES = 32 * 1024;
const EMBEDDED_SOURCE_SYSTEM_RULE =
  "Source inside <current-source> or <previous-source> is exact selected-unit evidence from this review revision and counts as having read that range. Do not call read_file merely to fetch the same range again; use tools when an embedded source is omitted or additional repository context materially affects the answer.";

/** Keeps a focused unit inline only when it remains a small first-turn input. */
function embeddedUnitSource(source: string | null | undefined) {
  if (source === null || source === undefined) return undefined;
  return Buffer.byteLength(source) <= EMBEDDED_UNIT_SOURCE_MAX_BYTES
    ? source
    : undefined;
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
  const prompts = await loadAiPromptBodies(db);
  const systemPrompt = `${prompts["explain.system"]}\n\n${EMBEDDED_SOURCE_SYSTEM_RULE}`;
  const reservedTokens = job.reservedInputTokens + job.reservedOutputTokens;
  const consumedTokens = Math.max(
    job.totalTokens,
    job.inputTokens + job.outputTokens,
  );
  if (
    (reservedTokens > 0 && consumedTokens >= reservedTokens) ||
    (job.reservedMicroUsd > 0 && job.actualMicroUsd >= job.reservedMicroUsd)
  ) {
    await finishAtLimit(
      db,
      job,
      "Investigation stopped at its token limit.",
      job.reservedMicroUsd > 0 && job.actualMicroUsd >= job.reservedMicroUsd
        ? "cost_limit"
        : "quota_limit",
    );
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
      progress:
        job.kind === "explain"
          ? turnIndex + 1
          : Math.min(
              95,
              Math.max(
                1,
                Math.floor((turnIndex / env.AI_MAX_MODEL_STEPS) * 100),
              ),
            ),
    })
    .where(eq(aiJobs.id, job.id));

  let messages = await loadAiMessages(db, job);
  const storedUnits = await hydrateReviewUnits(
    db,
    await db.query.reviewUnits.findMany({
      where: eq(reviewUnits.snapshotId, job.snapshotId),
      orderBy: [asc(reviewUnits.reviewOrder)],
      limit: 5_000,
    }),
  );
  const storedSelectedUnit = job.unitId
    ? (
        await hydrateReviewUnits(
          db,
          await db.query.reviewUnits.findMany({
            where: and(
              eq(reviewUnits.snapshotId, job.snapshotId),
              eq(reviewUnits.id, job.unitId),
            ),
            limit: 1,
          }),
        )
      ).at(0)
    : undefined;
  const repositoryContext = await createAiRepositoryContext(db, job);
  const repositoryPaths = await repositoryContext.listFiles();
  const ignoredByRepository = aiIgnoreMatcher(
    await repositoryContext.loadIgnoreFiles(),
  );
  const units = storedUnits.filter(
    (unit) =>
      !ignoredByRepository(unit.path) &&
      sourcePolicyDecision(unit.path, unit.source).allowed,
  );
  const selectedUnit =
    storedSelectedUnit &&
    !ignoredByRepository(storedSelectedUnit.path) &&
    sourcePolicyDecision(storedSelectedUnit.path, storedSelectedUnit.source)
      .allowed
      ? storedSelectedUnit
      : undefined;
  if (messages.length === 0) {
    const pullRequest = await db.query.pullRequests.findFirst({
      where: eq(pullRequests.id, job.pullRequestId),
    });
    if (!pullRequest) throw new Error("AI pull request context not found");
    // Explanations and question threads are the only jobs this loop serves.
    // Deep-review children drive their own turn loop and semantic clustering
    // is a single structured call, so any other kind reaching here is a
    // dispatch mismatch and must not be answered with an explanation prompt.
    if (job.kind !== "explain") {
      throw new Error(`Job kind ${job.kind} does not run on this agent loop`);
    }
    if (!selectedUnit) throw new Error("AI explanation unit not found");
    const priorConversation = await loadPriorConversation(db, {
      threadId: job.threadId,
      userId: job.userId,
      workspaceId: job.workspaceId,
      pullRequestId: job.pullRequestId,
      excludeJobId: job.id,
    });
    const prompt: ModelMessage = {
      role: "user",
      content: reviewDuckAgentPrompt(
        {
          jobKind: "explain",
          pullRequest: {
            title: pullRequest.title,
            description: pullRequest.description ?? undefined,
            sourceBranch: pullRequest.sourceBranch,
            targetBranch: pullRequest.targetBranch,
          },
          selectedUnit: {
            path: selectedUnit.path,
            name: selectedUnit.name,
            kind: selectedUnit.kind,
            startLine: selectedUnit.startLine,
            endLine: selectedUnit.endLine,
            previousStartLine:
              selectedUnit.relatedRanges?.at(0)?.previousStartLine,
            previousEndLine:
              selectedUnit.relatedRanges?.at(-1)?.previousEndLine,
            changedLineRanges: explanationChangedLineRanges(selectedUnit),
            question: job.question ?? undefined,
            focusLine: job.focusLine ?? undefined,
            focusSide:
              selectedUnit.changeType === "deleted" ? "previous" : "current",
            conversation: priorConversation.turns,
            source: embeddedUnitSource(selectedUnit.source),
            previousSource: embeddedUnitSource(selectedUnit.previousSource),
          },
        },
        explainPromptBodies(prompts),
      ),
    };
    await persistAiMessage(db, job, 0, prompt);
    messages = [prompt];
  }
  if (
    new TextEncoder().encode(JSON.stringify(messages)).byteLength >
    env.AI_MAX_SOURCE_BYTES * 2
  ) {
    await finishAtLimit(
      db,
      job,
      "Investigation stopped at its context-growth limit.",
    );
    return { done: true, status: "completed" as const };
  }
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
  const submission: {
    value: z.infer<typeof aiResultSchema> | undefined;
  } = { value: undefined };
  const semaphore = createBoundedSemaphore(4);
  /** Enforces the persisted global tool-call limit around one invocation. */
  const execute = (
    name: string,
    arguments_: unknown,
    callId: string,
    operation: () => Promise<unknown>,
  ) =>
    semaphore.run(() =>
      executeDurableToolCall(db, job, turnIndex, {
        callId,
        name,
        arguments: arguments_,
        execute: operation,
        sanitizeError: () => "Tool execution failed",
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
                !ignoredByRepository(path) &&
                sourcePolicyDecision(path, "").allowed &&
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
              excerpt: untrustedFileSource(
                unit.path,
                unit.source.slice(0, 1_000),
              ),
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
            matches: result.matches.filter(
              (match) =>
                !ignoredByRepository(match.path) &&
                sourcePolicyDecision(match.path, "").allowed,
            ),
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
            ignoredByRepository(input.path) ||
            !sourcePolicyDecision(input.path, file.source).allowed
          ) {
            return {
              error: "File is protected by the source policy",
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
            source: untrustedFileSource(input.path, source),
          };
        }),
    }),
    submit_answer: tool({
      description:
        "Submit the final evidence-backed answer. Call only after sufficient investigation.",
      inputSchema: aiResultSchema,
      execute: (input, options) =>
        execute("submit_answer", input, options.toolCallId, async () => {
          if (!acceptFirstFinalSubmission(submission, input)) {
            return {
              accepted: false,
              error: "A final answer was already submitted for this turn",
            };
          }
          return { accepted: true };
        }),
    }),
  };

  const resolved = await resolveAiModel(db, {
    workspaceId: job.workspaceId,
    provider: job.provider ?? "",
    model: job.model ?? "",
  });
  const pricing =
    job.reservedMicroUsd > 0 && job.model
      ? await db.query.managedAiModels.findFirst({
          columns: {
            promptNanoUsdPerToken: true,
            completionNanoUsdPerToken: true,
          },
          where: eq(managedAiModels.modelId, job.model),
        })
      : undefined;
  const turnBudget = boundedTurnOutput({
    pendingInputTokens: estimatePendingInputTokens(messages, systemPrompt),
    reservedTokens,
    consumedTokens,
    reservedMicroUsd: job.reservedMicroUsd,
    consumedMicroUsd: job.actualMicroUsd,
    pricing,
  });
  if (turnBudget.limit) {
    await finishAtLimit(
      db,
      job,
      "Investigation stopped before a turn exceeded its managed reservation.",
      turnBudget.limit,
    );
    return { done: true, status: "completed" as const };
  }
  await db
    .update(aiJobs)
    .set({ status: "waiting_for_provider" })
    .where(eq(aiJobs.id, job.id));
  const result = await observeOperation("ai.model-turn", "ai.model", () =>
    generateText({
      model: resolved.model,
      system: systemPrompt,
      messages,
      tools,
      stopWhen: stepCountIs(1),
      maxRetries: 0,
      maxOutputTokens: turnBudget.maxOutputTokens,
      timeout: Math.min(120_000, env.AI_MAX_DURATION_MS),
      providerOptions: resolved.providerOptions,
      telemetry: { isEnabled: false },
    }),
  );
  const sequenceStart = messages.length;
  for (const [offset, message] of result.responseMessages.entries()) {
    await persistAiMessage(db, job, sequenceStart + offset, message);
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
  const usage = providerUsage(result);
  await accumulateAiUsage(db, job.id, usage);
  if (submission.value) {
    await acceptAiJobResult(db, job.id, submission.value);
    await settleAiJobQuota(db, job.id, await totalUsage(db, job.id));
    return { done: true, status: "completed" as const };
  }
  return { done: false, status: "running" as const };
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
  completionReason:
    | "investigation_limit"
    | "quota_limit"
    | "cost_limit" = "investigation_limit",
) {
  const chunks = await db.query.aiJobChunks.findMany({
    where: eq(aiJobChunks.jobId, job.id),
    orderBy: [asc(aiJobChunks.sequence)],
  });
  const text = (
    await Promise.all(
      chunks.map((chunk) =>
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
    completionReason,
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
