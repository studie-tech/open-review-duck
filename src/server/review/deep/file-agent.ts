import "server-only";

import { randomUUID } from "node:crypto";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { generateText, stepCountIs, type ToolSet } from "ai";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  aiJobEvidence,
  aiJobs,
  aiJobToolCalls,
  aiJobTurns,
  aiReviewFindings,
  aiReviewItems,
  managedAiModels,
  pullRequests,
} from "@/drizzle/schema";
import { env } from "~/env";
import { explanationChangedLineRanges } from "~/server/ai/change-scope";
import { resolveAiModel } from "~/server/ai/models";
import type { TokenUsage } from "~/server/ai/service";
import {
  boundedTurnOutput,
  estimatePendingInputTokens,
} from "~/server/ai/turn-guards";
import type { db as database } from "~/server/db";
import { observeOperation } from "~/server/observability/sentry";
import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";
import { createDeepReviewContext, type DeepReviewContext } from "./context";
import {
  classifyReviewItemError,
  type DeepReviewItemState,
  type ReviewFailureClass,
} from "./coverage";
import {
  type DeepReviewToolExecutor,
  deepReviewFileFinished,
  deepReviewFileTools,
} from "./file-tools";
import { sanitizeReason } from "./redaction";
import {
  DEEP_REVIEW_PLAN_MAX_CHECKPOINTS,
  DEEP_REVIEW_PLAN_SYSTEM_PROMPT,
  DEEP_REVIEW_SCOUT_SYSTEM_PROMPT,
  DEEP_REVIEW_SURVEY_SYSTEM_PROMPT,
  type DeepReviewLineRange,
  type DeepReviewPlanCheckpoint,
  planUserPrompt,
  type ScoutPromptInput,
  scoutUserPrompt,
  surveyUserPrompt,
} from "./review-prompts";
import { resolveRulebooks } from "./rulebooks";
import {
  deepReviewSurveyFinished,
  deepReviewSurveyPromptInput,
  deepReviewSurveyTools,
  validateDeepReviewSurveyFindings,
} from "./survey";
import { deepReviewValidationModel, validateFileFindings } from "./validate";

type Database = typeof database;
type ReviewJob = typeof aiJobs.$inferSelect;
type ReviewItem = typeof aiReviewItems.$inferSelect;

/**
 * How many durable model turns one file scout may take.
 *
 * OCR's per-file budget, and the reason the workflow drives the loop rather
 * than the agent: each turn is its own durable step, so a crashed process
 * resumes at the turn boundary instead of restarting the file.
 */
export const DEEP_REVIEW_FILE_MAX_TURNS = 3;

/**
 * The changed-line count above which a file earns a pre-scan planning call.
 *
 * OCR's own gate, kept because it improves the result rather than to save a
 * call: a severity-biased plan over a three-line change has nothing to rank,
 * and its output is noise the scout then has to discount.
 */
export const DEEP_REVIEW_PLAN_LINE_THRESHOLD = 50;

/**
 * Concurrent tool bodies per file scout.
 *
 * The single-agent loop hard-codes four, sized for one agent holding the whole
 * connection pool. A fan-out multiplies this by the number of files in flight,
 * so the child path runs narrower until `DATABASE_POOL_MAX` is measured.
 */
export const DEEP_REVIEW_TOOL_SLOTS = 2;

/** The reason recorded on an item whose scout used every turn it was given. */
const TURN_LIMIT_REASON = "turn_limit";

/** How much of one revision may be inlined into the scout's first prompt. */
const MAX_PROMPT_SOURCE_BYTES = 512_000;

/** The pre-scan plan returns five short checkpoints, never a document. */
const PLAN_MAX_OUTPUT_TOKENS = 1_500;

const MAX_TURN_TIMEOUT_MS = 120_000;

const planResponseSchema = z.object({
  checkpoints: z
    .array(
      z.object({
        focus: z.string().min(1).max(500),
        lines: z.string().min(1).max(64),
        why: z.string().min(1).max(1_000),
      }),
    )
    .max(64),
});

export interface DeepReviewRunLimits {
  maxToolCalls: number;
  maxSourceBytes: number;
  maxDurationMs: number;
}

/** What the whole review tree has spent, not what one child has spent. */
export interface DeepReviewRunUsage {
  toolCalls: number;
  sourceBytes: number;
  consumedTokens: number;
  consumedMicroUsd: number;
}

export interface DeepReviewRunGateInput {
  parent: Pick<
    ReviewJob,
    | "startedAt"
    | "cancelledAt"
    | "status"
    | "reservedInputTokens"
    | "reservedOutputTokens"
    | "reservedMicroUsd"
  >;
  usage: DeepReviewRunUsage;
  now?: number;
  limits?: Partial<DeepReviewRunLimits>;
}

export interface DeepReviewRunStop {
  failureClass: ReviewFailureClass;
  reason: string;
}

export interface ExecuteReviewFileTurnInput {
  childJobId: string;
  turnIndex: number;
  /** Defaults to `DEEP_REVIEW_FILE_MAX_TURNS`; the last turn closes the item. */
  maxTurns?: number;
  /** Injected by tests; production shares one context across the whole run. */
  context?: DeepReviewContext;
}

export interface ReviewFileTurnResult {
  done: boolean;
  state: DeepReviewItemState;
  itemId: string;
  path: string;
  failureClass: ReviewFailureClass | null;
  reason: string | null;
}

interface CloseItemInput {
  job: ReviewJob;
  item: ReviewItem;
  state: Extract<DeepReviewItemState, "completed" | "failed">;
  failureClass?: ReviewFailureClass;
  reason?: string | null;
  error?: string;
}

interface AgentTurnInput {
  job: ReviewJob;
  parent: ReviewJob;
  item: ReviewItem;
  usage: DeepReviewRunUsage;
  turnIndex: number;
  maxTurns: number;
  repository: DeepReviewContext;
}

interface AgentToolInput {
  execute: DeepReviewToolExecutor;
  sourceBytesRead: number;
  readPaths: readonly string[];
  reportedFindings: number;
  onFinish: () => void;
}

/**
 * The two things a durable review agent differs by: its prompt and its tools.
 *
 * Everything else — the transcript, the tool-call ledger, the budget, the
 * terminal transitions — is identical for a file scout and for the whole-pull-
 * request survey, and duplicating it would be duplicating the parts that are
 * subtle.
 */
interface DeepReviewAgent {
  systemPrompt: string;
  operation: string;
  buildPrompt(): Promise<ModelMessage>;
  buildTools(input: AgentToolInput): ToolSet;
  isFinished(): Promise<boolean>;
  /** Anchors and gates what the agent reported, before the item closes. */
  settle(): Promise<void>;
}

/**
 * Bounds how many tool bodies one file scout runs at the same time.
 *
 * The single-agent loop's semaphore is fixed at four because only one agent
 * ever holds it. Under a fan-out the capacity has to be a parameter, or the
 * pool sees slots times files concurrent statements.
 */
function boundedSemaphore(capacity: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  /** Runs one operation once a slot frees, releasing it however it settles. */
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active >= capacity) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await operation();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
  return { run };
}

/**
 * Persists one encrypted model message idempotently by turn sequence.
 *
 * A local mirror of the single-agent loop's private helper rather than a shared
 * import: that module is deliberately untouched by deep review, so the two
 * paths share the durable contract — the table and the vault provider string —
 * instead of sharing code that would couple their execution models.
 */
async function persistMessage(
  db: Database,
  job: ReviewJob,
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
        { workspaceId: job.workspaceId, recordId: id, provider: "ai-turn" },
        JSON.stringify(message),
      ),
    })
    .onConflictDoNothing({
      target: [aiJobTurns.jobId, aiJobTurns.sequence],
    });
}

/**
 * Restores the encrypted durable transcript of one file scout.
 *
 * Unchanged from the single-agent loop, and unchanged deliberately: the filter
 * is `jobId` alone, and every child of a fan-out has its own job, so per-file
 * transcript partitioning needs no sequence banding.
 */
async function loadMessages(db: Database, job: ReviewJob) {
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

/**
 * Executes and persists one idempotent tool call, replaying stored output.
 *
 * The replay branch never re-runs the handler, which is why `report_finding`
 * writes its rows inside its own body: anything this function returns from
 * storage was produced by an execution that will not happen again.
 */
async function persistToolCall(
  db: Database,
  job: ReviewJob,
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
    await db
      .update(aiJobToolCalls)
      .set({
        status: "completed",
        encryptedOutput: await sealVaultSecret(
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
          {
            workspaceId: job.workspaceId,
            recordId: id,
            provider: "ai-tool-output",
          },
          JSON.stringify({
            error: sanitizeReason(cause),
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
}): TokenUsage {
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
  };
}

/** Adds one model call's usage to the child that made it, never to the parent. */
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

/**
 * Reads what the whole review tree has spent so far.
 *
 * Every ceiling in `env` is written per job, and a fan-out would multiply each
 * one by the width of the run. The aggregate is over the children because the
 * parent makes no model calls and reads no source of its own.
 */
export async function readDeepReviewRunUsage(
  db: Database,
  parentJobId: string,
): Promise<DeepReviewRunUsage> {
  const [tools] = await db
    .select({ calls: sql<string>`count(*)` })
    .from(aiJobToolCalls)
    .innerJoin(aiJobs, eq(aiJobToolCalls.jobId, aiJobs.id))
    .where(eq(aiJobs.parentJobId, parentJobId));
  const [evidence] = await db
    .select({
      bytes: sql<string>`coalesce(sum(${aiJobEvidence.endByte} - ${aiJobEvidence.startByte}), 0)`,
    })
    .from(aiJobEvidence)
    .innerJoin(aiJobs, eq(aiJobEvidence.jobId, aiJobs.id))
    .where(eq(aiJobs.parentJobId, parentJobId));
  const [spend] = await db
    .select({
      tokens: sql<string>`coalesce(sum(greatest(${aiJobs.totalTokens}, ${aiJobs.inputTokens} + ${aiJobs.outputTokens})), 0)`,
      microUsd: sql<string>`coalesce(sum(${aiJobs.actualMicroUsd}), 0)`,
    })
    .from(aiJobs)
    .where(eq(aiJobs.parentJobId, parentJobId));
  return {
    toolCalls: Number(tools?.calls ?? 0),
    sourceBytes: Number(evidence?.bytes ?? 0),
    consumedTokens: Number(spend?.tokens ?? 0),
    consumedMicroUsd: Number(spend?.microUsd ?? 0),
  };
}

/**
 * Decides whether the run may spend another turn, before it spends one.
 *
 * Cancellation and the wall clock are read from the parent because children
 * carry neither: the parent holds the run's only `workflowRunId`, and its
 * `startedAt` is the one anchor that does not hand every file its own thirty
 * minutes. The remaining ceilings are per job in `env`, so they are compared
 * against tree totals rather than this child's own.
 */
export function deepReviewRunStop(
  input: DeepReviewRunGateInput,
): DeepReviewRunStop | null {
  const { parent, usage } = input;
  const now = input.now ?? Date.now();
  const maxToolCalls = input.limits?.maxToolCalls ?? env.AI_MAX_TOOL_CALLS;
  const maxSourceBytes =
    input.limits?.maxSourceBytes ?? env.AI_MAX_SOURCE_BYTES;
  const maxDurationMs = input.limits?.maxDurationMs ?? env.AI_MAX_DURATION_MS;
  if (parent.cancelledAt || parent.status === "cancelled") {
    return {
      failureClass: "cancelled",
      reason: "The review was cancelled before this file was reviewed.",
    };
  }
  if (parent.startedAt && now - parent.startedAt.getTime() >= maxDurationMs) {
    return {
      failureClass: "timeout",
      reason:
        "The review reached its time limit before this file was reviewed.",
    };
  }
  if (usage.toolCalls >= maxToolCalls) {
    return {
      failureClass: "tool_limit",
      reason:
        "The review reached its tool-call limit before this file was reviewed.",
    };
  }
  if (usage.sourceBytes >= maxSourceBytes) {
    return {
      failureClass: "budget",
      reason:
        "The review reached its source-exposure limit before this file was reviewed.",
    };
  }
  const reservedTokens =
    parent.reservedInputTokens + parent.reservedOutputTokens;
  if (reservedTokens > 0 && usage.consumedTokens >= reservedTokens) {
    return {
      failureClass: "budget",
      reason:
        "The review reached its token reservation before this file was reviewed.",
    };
  }
  if (
    parent.reservedMicroUsd > 0 &&
    usage.consumedMicroUsd >= parent.reservedMicroUsd
  ) {
    return {
      failureClass: "budget",
      reason:
        "The review reached its cost reservation before this file was reviewed.",
    };
  }
  return null;
}

/**
 * Executes exactly one durable model turn for one file of a deep review.
 *
 * Everything a file can do wrong is caught here and recorded on that file's
 * item: a provider error, a malformed response, a missing revision. The run
 * keeps going, because a fan-out in which one file's failure fails the review
 * is strictly worse than the single-agent reviewer it replaces.
 */
export async function executeReviewFileTurn(
  db: Database,
  input: ExecuteReviewFileTurnInput,
): Promise<ReviewFileTurnResult> {
  return await executeDeepReviewTurn(db, input, "file");
}

/**
 * Executes one durable model turn of the whole-pull-request survey.
 *
 * The survey is one more child of the same run, with its own coverage item, so
 * it is bounded, resumed, gated and swept by exactly the machinery the file
 * agents are: a survey that never runs is a swept item, not a silent absence.
 */
export async function executeReviewSurveyTurn(
  db: Database,
  input: ExecuteReviewFileTurnInput,
): Promise<ReviewFileTurnResult> {
  return await executeDeepReviewTurn(db, input, "survey");
}

/** Drives one durable turn of whichever review agent owns the child job. */
async function executeDeepReviewTurn(
  db: Database,
  input: ExecuteReviewFileTurnInput,
  kind: "file" | "survey",
): Promise<ReviewFileTurnResult> {
  const maxTurns = Math.max(1, input.maxTurns ?? DEEP_REVIEW_FILE_MAX_TURNS);
  const job = await db.query.aiJobs.findFirst({
    where: eq(aiJobs.id, input.childJobId),
  });
  if (!job) throw new Error("Deep review child job not found");
  if (!job.parentJobId) {
    throw new Error("A deep review turn requires a deep review child job");
  }
  // Both agents find their item the same way, because the survey's item is a
  // sealed row like any file's — with a sentinel path instead of a real one.
  const item = await db.query.aiReviewItems.findFirst({
    where: eq(aiReviewItems.childJobId, job.id),
  });
  if (!item) throw new Error("Deep review item not found for this child job");
  if (item.state !== "selected") {
    // A replayed step, or a tree the cancel sweep already closed. Either way
    // the item has its coverage and must not be reviewed a second time.
    return {
      done: true,
      state: item.state,
      itemId: item.id,
      path: item.path,
      failureClass: item.failureClass,
      reason: item.reason,
    };
  }
  const parent = await db.query.aiJobs.findFirst({
    where: eq(aiJobs.id, job.parentJobId),
  });
  if (!parent) throw new Error("Deep review parent job not found");

  const usage = await readDeepReviewRunUsage(db, job.parentJobId);
  const stop = deepReviewRunStop({ parent, usage });
  if (stop) {
    return await closeItem(db, {
      job,
      item,
      state: "failed",
      failureClass: stop.failureClass,
      reason: stop.reason,
      error: stop.reason,
    });
  }

  try {
    const turn: AgentTurnInput = {
      job,
      parent,
      item,
      usage,
      turnIndex: input.turnIndex,
      maxTurns,
      repository: input.context ?? (await createDeepReviewContext(db, { job })),
    };
    return await runAgentTurn(
      db,
      turn,
      kind === "survey" ? surveyAgent(db, turn) : fileScoutAgent(db, turn),
    );
  } catch (cause) {
    // The whole point of the catch: this file is now failed coverage, and the
    // other files of the run never learn that it happened.
    const reason = sanitizeReason(cause);
    return await closeItem(db, {
      job,
      item,
      state: "failed",
      failureClass: classifyReviewItemError(cause),
      reason,
      error: reason,
    });
  }
}

/** Runs the model for one turn and records whatever it settles the item as. */
async function runAgentTurn(
  db: Database,
  input: AgentTurnInput,
  agent: DeepReviewAgent,
): Promise<ReviewFileTurnResult> {
  const { job, parent, item, usage, turnIndex, maxTurns } = input;
  await db
    .update(aiJobs)
    .set({
      status: "running",
      startedAt: job.startedAt ?? new Date(),
      progress: Math.min(
        95,
        Math.max(1, Math.floor((turnIndex / maxTurns) * 100)),
      ),
    })
    .where(eq(aiJobs.id, job.id));

  let messages = await loadMessages(db, job);
  if (messages.length === 0) {
    await persistMessage(db, job, 0, await agent.buildPrompt());
    // Re-read rather than trusting the value just built: the insert ignores a
    // conflict, so a racing attempt's prompt may be the stored one, and the
    // turn has to send exactly what the transcript holds.
    messages = await loadMessages(db, job);
  }

  const resolved = await resolveAiModel(db, {
    workspaceId: job.workspaceId,
    provider: job.provider ?? "",
    model: job.model ?? "",
  });
  const reservedTokens =
    parent.reservedInputTokens + parent.reservedOutputTokens;
  const pricing =
    parent.reservedMicroUsd > 0 && job.model
      ? await db.query.managedAiModels.findFirst({
          columns: {
            promptNanoUsdPerToken: true,
            completionNanoUsdPerToken: true,
          },
          where: eq(managedAiModels.modelId, job.model),
        })
      : undefined;
  const turnBudget = boundedTurnOutput({
    pendingInputTokens: estimatePendingInputTokens(
      messages,
      agent.systemPrompt,
    ),
    reservedTokens,
    consumedTokens: usage.consumedTokens,
    reservedMicroUsd: parent.reservedMicroUsd,
    consumedMicroUsd: usage.consumedMicroUsd,
    pricing,
  });
  if (turnBudget.limit) {
    const reason =
      "The review reached its managed reservation before this file was reviewed.";
    return await closeItem(db, {
      job,
      item,
      state: "failed",
      failureClass: "budget",
      reason,
      error: reason,
    });
  }

  const semaphore = boundedSemaphore(DEEP_REVIEW_TOOL_SLOTS);
  let finished = false;
  const tools = agent.buildTools({
    execute: (invocation) =>
      semaphore.run(() => persistToolCall(db, job, turnIndex, invocation)),
    // Charged against the tree, not this child: the byte ceiling bounds how
    // much of the repository one review exposes, however many agents read it.
    sourceBytesRead: usage.sourceBytes,
    readPaths: await readDistinctPaths(db, job.id),
    reportedFindings: await countReportedFindings(db, item.id),
    onFinish: () => {
      finished = true;
    },
  });

  const result = await observeOperation(agent.operation, "ai.model", () =>
    generateText({
      model: resolved.model,
      system: agent.systemPrompt,
      messages,
      tools,
      stopWhen: stepCountIs(1),
      maxRetries: 0,
      maxOutputTokens: turnBudget.maxOutputTokens,
      timeout: Math.min(MAX_TURN_TIMEOUT_MS, env.AI_MAX_DURATION_MS),
      providerOptions: resolved.providerOptions,
      telemetry: { isEnabled: false },
    }),
  );
  const sequenceStart = messages.length;
  for (const [offset, message] of result.responseMessages.entries()) {
    await persistMessage(db, job, sequenceStart + offset, message);
  }
  await accumulateUsage(db, job.id, usageFromResult(result));

  // The callback fires only for a freshly executed tool body, so a replayed
  // step has to read the durable tool-call row to learn the agent is finished.
  if (finished || (await agent.isFinished())) {
    await agent.settle();
    return await closeItem(db, { job, item, state: "completed" });
  }
  if (turnIndex + 1 >= maxTurns) {
    // The item was reviewed for its whole budget and its findings are already
    // persisted, so this is covered rather than failed — but the run records
    // that the agent never declared itself done.
    await agent.settle();
    return await closeItem(db, {
      job,
      item,
      state: "completed",
      reason: TURN_LIMIT_REASON,
    });
  }
  return {
    done: false,
    state: "selected",
    itemId: item.id,
    path: item.path,
    failureClass: null,
    reason: null,
  };
}

/**
 * Describes the per-file scout: its prompt, its tools and its validation.
 *
 * Validation runs before the item closes rather than in a later pass, because
 * a finding left in `submitted` is never ranked and therefore never surfaced,
 * and because everything anchoring needs is already assembled here.
 */
function fileScoutAgent(db: Database, input: AgentTurnInput): DeepReviewAgent {
  const { job, item, repository } = input;
  return {
    systemPrompt: DEEP_REVIEW_SCOUT_SYSTEM_PROMPT,
    operation: "ai.deep-review-file-turn",
    buildPrompt: () => buildScoutPrompt(db, input),
    buildTools: (tools) =>
      deepReviewFileTools({
        db,
        job,
        item: { id: item.id, path: item.path },
        repository,
        execute: tools.execute,
        sourceBytesRead: tools.sourceBytesRead,
        readPaths: tools.readPaths,
        reportedFindings: tools.reportedFindings,
        onFinishFile: tools.onFinish,
      }),
    isFinished: () => deepReviewFileFinished(db, job.id),
    settle: () => validateReviewedFile(db, input),
  };
}

/** Describes the whole-pull-request survey agent and its distinct tool set. */
function surveyAgent(db: Database, input: AgentTurnInput): DeepReviewAgent {
  const { job, item, repository } = input;
  return {
    systemPrompt: DEEP_REVIEW_SURVEY_SYSTEM_PROMPT,
    operation: "ai.deep-review-survey-turn",
    buildPrompt: async () => ({
      role: "user",
      content: surveyUserPrompt(
        await deepReviewSurveyPromptInput(db, {
          job,
          parentJobId: input.parent.id,
          repository,
        }),
      ),
    }),
    buildTools: (tools) =>
      deepReviewSurveyTools({
        db,
        job,
        itemId: item.id,
        repository,
        execute: tools.execute,
        sourceBytesRead: tools.sourceBytesRead,
        readPaths: tools.readPaths,
        reportedFindings: tools.reportedFindings,
        onFinishSurvey: tools.onFinish,
      }),
    isFinished: () => deepReviewSurveyFinished(db, job.id),
    settle: async () => {
      await validateDeepReviewSurveyFindings(db, {
        job,
        itemId: item.id,
        repository,
      });
    },
  };
}

/**
 * Anchors, gates and refutes everything one file's scout reported.
 *
 * Failing here fails the file rather than the run, and that is the honest
 * outcome: an unvalidated finding has no position and no grounding, so the file
 * is not covered even though its scout finished.
 */
async function validateReviewedFile(db: Database, input: AgentTurnInput) {
  const { job, item, repository } = input;
  const changed = repository.changedFile(item.path);
  const current = await repository.readFile(item.path, MAX_PROMPT_SOURCE_BYTES);
  const previous = await repository.readPreviousSource(item.path);
  const currentSource = current?.source ?? null;
  const previousSource = previous ?? null;
  const evidence = await db
    .select({
      id: aiJobEvidence.id,
      sourceBlobId: aiJobEvidence.sourceBlobId,
      startLine: aiJobEvidence.startLine,
      endLine: aiJobEvidence.endLine,
    })
    .from(aiJobEvidence)
    .where(eq(aiJobEvidence.jobId, job.id));
  await validateFileFindings(db, {
    item: { id: item.id, path: item.path },
    job: { id: job.id, workspaceId: job.workspaceId },
    currentSource,
    previousSource,
    changedRanges: fileChangedRanges(
      item.changeType,
      currentSource,
      previousSource,
    ),
    units: (await repository.units())
      .filter((unit) => unit.path === item.path)
      .map((unit) => ({
        id: unit.id,
        path: unit.path,
        startLine: unit.startLine,
        endLine: unit.endLine,
      })),
    evidence,
    currentBlobId: changed?.currentBlob?.id ?? current?.blob.id ?? null,
    previousBlobId: changed?.previousBlob?.id ?? null,
    // A refutation must cite a path this pull request changed, so the changed
    // set — not the whole revision tree — is what makes a citation verifiable.
    snapshotPaths: repository.changedFiles().map((file) => file.path),
    model: deepReviewValidationModel(db, job),
  });
}

/** Builds the first reviewer message, planning first when the file is large. */
async function buildScoutPrompt(
  db: Database,
  input: AgentTurnInput,
): Promise<ModelMessage> {
  const { job, item, repository } = input;
  const pullRequest = await db.query.pullRequests.findFirst({
    where: eq(pullRequests.id, job.pullRequestId),
  });
  if (!pullRequest) throw new Error("Deep review pull request not found");
  const current = await repository.readFile(item.path, MAX_PROMPT_SOURCE_BYTES);
  const previous = await repository.readPreviousSource(item.path);
  const currentSource = current?.source ?? null;
  const previousSource = previous ?? null;
  const promptInput: ScoutPromptInput = {
    path: item.path,
    changeType: item.changeType,
    rulebookText: resolveRulebooks(item.path).text,
    currentSource,
    previousSource,
    changedRanges: fileChangedRanges(
      item.changeType,
      currentSource,
      previousSource,
    ),
    unitManifest: (await repository.units())
      .filter((unit) => unit.path === item.path)
      .map((unit) => ({
        name: unit.name,
        kind: unit.kind,
        startLine: unit.startLine,
        endLine: unit.endLine,
      })),
    pullRequest: {
      title: pullRequest.title,
      description: pullRequest.description,
      sourceBranch: pullRequest.sourceBranch,
      targetBranch: pullRequest.targetBranch,
    },
  };
  const planCheckpoints =
    item.changedLineCount >= DEEP_REVIEW_PLAN_LINE_THRESHOLD
      ? await resolvePlanCheckpoints(db, input, promptInput)
      : undefined;
  return {
    role: "user",
    content: scoutUserPrompt({ ...promptInput, planCheckpoints }),
  };
}

/**
 * Runs the stateless pre-scan plan, degrading to no plan on any failure.
 *
 * The plan ranks risk inside one file; it never bounds what the scout reviews.
 * Losing it therefore costs prioritization and nothing else, which is why every
 * failure path here returns the sentinel instead of failing the file.
 */
async function resolvePlanCheckpoints(
  db: Database,
  input: AgentTurnInput,
  promptInput: ScoutPromptInput,
): Promise<readonly DeepReviewPlanCheckpoint[] | undefined> {
  const { job, parent, usage } = input;
  try {
    const resolved = await resolveAiModel(db, {
      workspaceId: job.workspaceId,
      provider: job.provider ?? "",
      model: job.model ?? "",
    });
    const budget = boundedTurnOutput({
      pendingInputTokens: estimatePendingInputTokens(
        promptInput,
        DEEP_REVIEW_PLAN_SYSTEM_PROMPT,
      ),
      reservedTokens: parent.reservedInputTokens + parent.reservedOutputTokens,
      consumedTokens: usage.consumedTokens,
      reservedMicroUsd: parent.reservedMicroUsd,
      consumedMicroUsd: usage.consumedMicroUsd,
    });
    if (budget.limit) return undefined;
    const result = await observeOperation(
      "ai.deep-review-file-plan",
      "ai.model",
      () =>
        generateText({
          model: resolved.model,
          system: DEEP_REVIEW_PLAN_SYSTEM_PROMPT,
          prompt: planUserPrompt(promptInput),
          maxRetries: 0,
          maxOutputTokens: Math.min(
            PLAN_MAX_OUTPUT_TOKENS,
            budget.maxOutputTokens,
          ),
          timeout: Math.min(MAX_TURN_TIMEOUT_MS, env.AI_MAX_DURATION_MS),
          providerOptions: resolved.providerOptions,
          telemetry: { isEnabled: false },
        }),
    );
    await accumulateUsage(db, job.id, usageFromResult(result));
    return parsePlanCheckpoints(result.text);
  } catch {
    return undefined;
  }
}

/** Reads the plan response, tolerating a fence the contract does not ask for. */
export function parsePlanCheckpoints(
  text: string,
): readonly DeepReviewPlanCheckpoint[] | undefined {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const response = planResponseSchema.safeParse(parsed);
  if (!response.success) return undefined;
  const checkpoints = response.data.checkpoints.slice(
    0,
    DEEP_REVIEW_PLAN_MAX_CHECKPOINTS,
  );
  return checkpoints.length > 0 ? checkpoints : undefined;
}

/**
 * Derives the changed current-revision lines of a whole file.
 *
 * `explanationChangedLineRanges` takes a unit, so a file is expressed as the
 * pseudo-unit spanning it. A deleted file has no current revision to point at,
 * and the prompt's change-type guidance is what tells that scout to quote the
 * previous one instead.
 */
export function fileChangedRanges(
  changeType: string,
  currentSource: string | null,
  previousSource: string | null,
): DeepReviewLineRange[] {
  if (changeType === "deleted" || currentSource === null) return [];
  const lineCount = currentSource === "" ? 0 : currentSource.split("\n").length;
  if (lineCount === 0) return [];
  return explanationChangedLineRanges({
    changeType,
    startLine: 1,
    endLine: lineCount,
    source: currentSource,
    previousSource,
  });
}

/** Lists the paths this child has provable evidence of having read. */
async function readDistinctPaths(db: Database, jobId: string) {
  const rows = await db
    .selectDistinct({ path: aiJobEvidence.path })
    .from(aiJobEvidence)
    .where(eq(aiJobEvidence.jobId, jobId));
  return rows.map((row) => row.path);
}

/** Counts what this file already reported, so a resumed turn cannot re-fill. */
async function countReportedFindings(db: Database, itemId: string) {
  return await db.$count(aiReviewFindings, eq(aiReviewFindings.itemId, itemId));
}

/**
 * Moves one item and its child job to a terminal state, exactly once.
 *
 * Both updates are guarded on the state they expect to leave, so a replayed
 * step neither reopens a closed file nor overwrites the class a cancel sweep
 * already recorded.
 */
async function closeItem(
  db: Database,
  input: CloseItemInput,
): Promise<ReviewFileTurnResult> {
  const { job, item } = input;
  const failureClass =
    input.state === "failed" ? (input.failureClass ?? "unknown") : null;
  const reason = input.reason ?? null;
  await db
    .update(aiReviewItems)
    .set({ state: input.state, failureClass, reason })
    .where(
      and(eq(aiReviewItems.id, item.id), eq(aiReviewItems.state, "selected")),
    );
  await db
    .update(aiJobs)
    .set({
      status: input.state === "completed" ? "completed" : "failed",
      completionReason:
        input.state === "completed"
          ? "answered"
          : failureClass === "cancelled"
            ? "cancelled"
            : "provider_failure",
      error: input.error ?? null,
      progress: 100,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(aiJobs.id, job.id),
        sql`${aiJobs.status} not in ('completed', 'failed', 'cancelled')`,
      ),
    );
  if (job.parentJobId) await advanceParentProgress(db, job.parentJobId);
  return {
    done: true,
    state: input.state,
    itemId: item.id,
    path: item.path,
    failureClass,
    reason,
  };
}

/**
 * Advances the parent's progress as files close.
 *
 * Nothing else writes it on this path — the parent runs no turns of its own —
 * and the poll predicate the review UI uses is driven by it, so a fan-out that
 * never wrote progress would look frozen for its whole duration.
 */
async function advanceParentProgress(db: Database, parentJobId: string) {
  const [counts] = await db
    .select({
      total: sql<string>`count(*)`,
      settled: sql<string>`count(*) filter (where ${aiReviewItems.state} <> 'selected')`,
    })
    .from(aiReviewItems)
    .where(eq(aiReviewItems.parentJobId, parentJobId));
  const total = Number(counts?.total ?? 0);
  if (total === 0) return;
  const settled = Number(counts?.settled ?? 0);
  const progress = Math.min(
    95,
    Math.max(1, Math.floor((settled / total) * 95)),
  );
  await db
    .update(aiJobs)
    // Monotonic: a replayed step must never walk a progress bar backwards.
    .set({ progress: sql`greatest(${aiJobs.progress}, ${progress})` })
    .where(eq(aiJobs.id, parentJobId));
}
