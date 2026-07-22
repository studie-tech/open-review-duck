import { isDeepStrictEqual } from "node:util";
import { createFlueClient } from "@flue/sdk";
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  sum,
} from "drizzle-orm";
import { after } from "next/server";
import {
  aiConfigurations,
  aiDispatches,
  aiJobs,
  aiUsage,
  providerConnections,
  pullRequests,
  repositories,
  reviewSnapshots,
  reviewUnits,
  workspaceMembers,
  workspaces,
} from "@/drizzle/schema";
import { REVIEWDUCK_AGENT_RUN_PROMPT } from "~/config/prompts";
import { env } from "~/env";
import { explanationChangedLineRanges } from "~/server/ai/change-scope";
import {
  aiExecutionErrorMessage,
  isRetryableAiExecutionError,
} from "~/server/ai/execution-error";
import type { db as database } from "~/server/db";
import { decryptSecret } from "~/server/security/encryption";

type Database = typeof database;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

export const CURRENT_AI_AGENT_VERSION = 6;
const AI_DISPATCH_LEASE_MS = 12 * 60 * 1_000;
const MAX_AI_DISPATCH_ATTEMPTS = 3;
const AI_DISPATCH_CONCURRENCY = 1;
const AI_PROMPT_AND_TOOL_OVERHEAD_TOKENS = 1_500;
const activeAiDrains = new WeakMap<object, Promise<number>>();

interface AiJobScope {
  configuration: typeof aiConfigurations.$inferSelect;
  snapshot: typeof reviewSnapshots.$inferSelect;
  workspaceId: string;
}

/** Returns the canonical API root for a built-in model provider. */
export function defaultAiBaseUrl(provider: string) {
  if (provider === "anthropic") return "https://api.anthropic.com/v1";
  if (provider === "openai") return "https://api.openai.com/v1";
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  if (provider === "google") return "https://generativelanguage.googleapis.com";
  if (provider === "mistral") return "https://api.mistral.ai/v1";
  return undefined;
}

/** Estimates the complete request envelope reserved against a managed quota. */
export function estimateAiReservation(
  units: Array<{
    source: string;
    previousSource: string | null;
    path: string;
    name: string;
    kind: string;
  }>,
  kind: "explain" | "review",
) {
  const requestBytes = units.reduce(
    (total, unit) =>
      total +
      Buffer.byteLength(unit.source) +
      Buffer.byteLength(unit.previousSource ?? "") +
      Buffer.byteLength(unit.path) +
      Buffer.byteLength(unit.name) +
      Buffer.byteLength(unit.kind) +
      80,
    0,
  );
  return {
    // A tokenizer cannot emit more tokens than the UTF-8 bytes supplied. The
    // conservative byte bound keeps the advertised managed quota hard even
    // for adversarial Unicode or an unexpectedly inefficient tokenizer.
    input: requestBytes + AI_PROMPT_AND_TOOL_OVERHEAD_TOKENS,
    output: kind === "review" ? 8_000 : 2_000,
  };
}

/** Resolves and authorizes the shared workspace context for AI job creation. */
async function aiJobScope(
  db: Database,
  input: {
    pullRequestId: string;
    userId: string;
    hasManagedAi: boolean;
  },
): Promise<AiJobScope> {
  const [scope] = await db
    .select({
      workspaceId: providerConnections.workspaceId,
      aiMode: workspaces.aiMode,
    })
    .from(pullRequests)
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .innerJoin(
      providerConnections,
      eq(repositories.connectionId, providerConnections.id),
    )
    .innerJoin(
      workspaceMembers,
      eq(providerConnections.workspaceId, workspaceMembers.workspaceId),
    )
    .innerJoin(workspaces, eq(providerConnections.workspaceId, workspaces.id))
    .where(
      and(
        eq(pullRequests.id, input.pullRequestId),
        eq(workspaceMembers.userId, input.userId),
      ),
    )
    .limit(1);
  if (!scope) throw new Error("Pull request not found");
  if (scope.aiMode === "off") throw new Error("AI assistance is turned off");

  const configuration = await db.query.aiConfigurations.findFirst({
    where: eq(aiConfigurations.workspaceId, scope.workspaceId),
  });
  if (!configuration) throw new Error("Configure an AI provider first");
  if (configuration.useManagedModels && !input.hasManagedAi) {
    throw new Error("The managed AI plan is required");
  }
  const snapshot = await db.query.reviewSnapshots.findFirst({
    where: eq(reviewSnapshots.pullRequestId, input.pullRequestId),
    orderBy: (table, { desc }) => [desc(table.version)],
  });
  if (!snapshot) throw new Error("Synchronize the pull request first");
  return {
    configuration,
    snapshot,
    workspaceId: scope.workspaceId,
  };
}

/** Atomically reserves managed-model request and token quota. */
async function reserveManagedAiQuota(
  tx: Transaction,
  input: {
    workspaceId: string;
    userId: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
  },
) {
  const quotaKey = `managed-ai-quota:${input.workspaceId}:${input.userId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${quotaKey}))`);
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(dayStart);
  weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
  const [daily] = await tx
    .select({ requests: sum(aiUsage.requests) })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.workspaceId, input.workspaceId),
        eq(aiUsage.userId, input.userId),
        gte(aiUsage.day, dayStart),
      ),
    );
  const [weekly] = await tx
    .select({
      tokens: sql<number>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens} + ${aiUsage.reservedInputTokens} + ${aiUsage.reservedOutputTokens}), 0)`,
    })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.workspaceId, input.workspaceId),
        eq(aiUsage.userId, input.userId),
        gte(aiUsage.day, weekStart),
      ),
    );
  if (
    Number(daily?.requests ?? 0) + input.requests >
    env.MANAGED_AI_DAILY_REQUEST_LIMIT
  ) {
    throw new Error("Daily managed AI request limit reached");
  }
  if (
    Number(weekly?.tokens ?? 0) + input.inputTokens + input.outputTokens >
    env.MANAGED_AI_WEEKLY_TOKEN_LIMIT
  ) {
    throw new Error("Weekly managed AI token limit reached");
  }
  await tx
    .insert(aiUsage)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      day: dayStart,
      requests: input.requests,
      reservedInputTokens: input.inputTokens,
      reservedOutputTokens: input.outputTokens,
    })
    .onConflictDoUpdate({
      target: [aiUsage.workspaceId, aiUsage.userId, aiUsage.day],
      set: {
        requests: sql`${aiUsage.requests} + ${input.requests}`,
        reservedInputTokens: sql`${aiUsage.reservedInputTokens} + ${input.inputTokens}`,
        reservedOutputTokens: sql`${aiUsage.reservedOutputTokens} + ${input.outputTokens}`,
      },
    });
}

/** Creates one deduplicated AI job and its durable dispatch outbox record. */
export async function createAiJob(
  db: Database,
  input: {
    pullRequestId: string;
    unitId?: string;
    kind: "explain" | "review";
    userId: string;
    hasManagedAi: boolean;
  },
) {
  const scope = await aiJobScope(db, input);
  const units = await db.query.reviewUnits.findMany({
    where: input.unitId
      ? and(
          eq(reviewUnits.snapshotId, scope.snapshot.id),
          eq(reviewUnits.id, input.unitId),
        )
      : eq(reviewUnits.snapshotId, scope.snapshot.id),
  });
  if (units.length === 0) throw new Error("No review context found");
  const estimatedUnits = input.unitId
    ? units
    : (() => {
        const files = units.filter((unit) => unit.kind === "file");
        const filePaths = new Set(files.map(({ path }) => path));
        const modules = units.filter(
          (unit) => unit.kind === "module" && !filePaths.has(unit.path),
        );
        const aggregate = [...files, ...modules];
        return aggregate.length > 0 ? aggregate : units;
      })();
  const reservation = estimateAiReservation(estimatedUnits, input.kind);

  return db.transaction(async (tx) => {
    if (input.kind === "explain") {
      const explanationKey = `${scope.snapshot.id}:${input.userId}:explain-batch`;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${explanationKey}))`,
      );
    }
    const dedupeKey = `${scope.snapshot.id}:${input.userId}:${input.kind}:${input.unitId ?? "pull-request"}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${dedupeKey}))`);
    const existing = await tx.query.aiJobs.findFirst({
      where: and(
        eq(aiJobs.snapshotId, scope.snapshot.id),
        eq(aiJobs.userId, input.userId),
        eq(aiJobs.kind, input.kind),
        eq(aiJobs.agentVersion, CURRENT_AI_AGENT_VERSION),
        input.unitId ? eq(aiJobs.unitId, input.unitId) : isNull(aiJobs.unitId),
        or(eq(aiJobs.status, "queued"), eq(aiJobs.status, "running")),
      ),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    });
    if (existing) return existing;

    if (scope.configuration.useManagedModels) {
      await reserveManagedAiQuota(tx, {
        workspaceId: scope.workspaceId,
        userId: input.userId,
        requests: 1,
        inputTokens: reservation.input,
        outputTokens: reservation.output,
      });
    }

    const [job] = await tx
      .insert(aiJobs)
      .values({
        workspaceId: scope.workspaceId,
        pullRequestId: input.pullRequestId,
        snapshotId: scope.snapshot.id,
        unitId: input.unitId,
        userId: input.userId,
        kind: input.kind,
        agentVersion: CURRENT_AI_AGENT_VERSION,
        status: "queued",
        reservedInputTokens: scope.configuration.useManagedModels
          ? reservation.input
          : 0,
        reservedOutputTokens: scope.configuration.useManagedModels
          ? reservation.output
          : 0,
      })
      .returning();
    if (!job) throw new Error("Could not create AI job");
    await tx.insert(aiDispatches).values({ jobId: job.id });
    return job;
  });
}

/** Creates deduplicated explanation jobs for a set of pending review units. */
export async function createAiExplanationJobs(
  db: Database,
  input: {
    pullRequestId: string;
    unitIds: string[];
    userId: string;
    hasManagedAi: boolean;
  },
) {
  const scope = await aiJobScope(db, input);
  const requestedUnitIds = [...new Set(input.unitIds)].sort();
  if (requestedUnitIds.length === 0) throw new Error("No review context found");
  const units = await db.query.reviewUnits.findMany({
    where: and(
      eq(reviewUnits.snapshotId, scope.snapshot.id),
      inArray(reviewUnits.id, requestedUnitIds),
    ),
  });
  if (units.length !== requestedUnitIds.length) {
    throw new Error("Some review units are unavailable");
  }
  if (units.some(({ kind }) => kind === "binary")) {
    throw new Error("Binary review units cannot be explained");
  }
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));

  return db.transaction(async (tx) => {
    const explanationKey = `${scope.snapshot.id}:${input.userId}:explain-batch`;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${explanationKey}))`,
    );
    const existing = await tx.query.aiJobs.findMany({
      where: and(
        eq(aiJobs.snapshotId, scope.snapshot.id),
        eq(aiJobs.userId, input.userId),
        eq(aiJobs.kind, "explain"),
        eq(aiJobs.agentVersion, CURRENT_AI_AGENT_VERSION),
        inArray(aiJobs.unitId, requestedUnitIds),
        or(eq(aiJobs.status, "queued"), eq(aiJobs.status, "running")),
      ),
    });
    const existingUnitIds = new Set(existing.map(({ unitId }) => unitId));
    const pendingUnits = requestedUnitIds
      .filter((unitId) => !existingUnitIds.has(unitId))
      .map((unitId) => unitsById.get(unitId))
      .filter((unit): unit is typeof reviewUnits.$inferSelect => Boolean(unit));
    if (pendingUnits.length === 0) {
      return { jobs: existing, created: 0, alreadyRunning: existing.length };
    }

    const reservations = pendingUnits.map((unit) => ({
      unit,
      reservation: estimateAiReservation([unit], "explain"),
    }));
    const inputTokens = reservations.reduce(
      (total, { reservation }) => total + reservation.input,
      0,
    );
    const outputTokens = reservations.reduce(
      (total, { reservation }) => total + reservation.output,
      0,
    );
    if (scope.configuration.useManagedModels) {
      await reserveManagedAiQuota(tx, {
        workspaceId: scope.workspaceId,
        userId: input.userId,
        requests: reservations.length,
        inputTokens,
        outputTokens,
      });
    }

    const created = await tx
      .insert(aiJobs)
      .values(
        reservations.map(({ unit, reservation }) => ({
          workspaceId: scope.workspaceId,
          pullRequestId: input.pullRequestId,
          snapshotId: scope.snapshot.id,
          unitId: unit.id,
          userId: input.userId,
          kind: "explain" as const,
          agentVersion: CURRENT_AI_AGENT_VERSION,
          status: "queued" as const,
          reservedInputTokens: scope.configuration.useManagedModels
            ? reservation.input
            : 0,
          reservedOutputTokens: scope.configuration.useManagedModels
            ? reservation.output
            : 0,
        })),
      )
      .returning();
    await tx
      .insert(aiDispatches)
      .values(created.map(({ id }) => ({ jobId: id })));
    return {
      jobs: [...existing, ...created],
      created: created.length,
      alreadyRunning: existing.length,
    };
  });
}

/** Atomically releases a reservation and records the actual terminal usage. */
export async function settleAiJobQuota(
  db: Database,
  jobId: string,
  usage?: TokenUsage,
) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${jobId}))`);
    const job = await tx.query.aiJobs.findFirst({
      where: eq(aiJobs.id, jobId),
    });
    if (!job || job.quotaSettledAt) return;
    const settledUsage =
      usage ??
      (job.result
        ? {
            input: job.reservedInputTokens,
            output: job.reservedOutputTokens,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: job.reservedInputTokens + job.reservedOutputTokens,
          }
        : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
    const settledAt = new Date();
    await tx
      .update(aiJobs)
      .set({
        inputTokens: settledUsage.input,
        outputTokens: settledUsage.output,
        cacheReadTokens: settledUsage.cacheRead,
        cacheWriteTokens: settledUsage.cacheWrite,
        totalTokens: settledUsage.totalTokens,
        quotaSettledAt: settledAt,
      })
      .where(and(eq(aiJobs.id, job.id), isNull(aiJobs.quotaSettledAt)));
    if (job.reservedInputTokens === 0 && job.reservedOutputTokens === 0) return;
    const day = new Date(job.createdAt);
    day.setUTCHours(0, 0, 0, 0);
    await tx
      .update(aiUsage)
      .set({
        reservedInputTokens: sql`greatest(0, ${aiUsage.reservedInputTokens} - ${job.reservedInputTokens})`,
        reservedOutputTokens: sql`greatest(0, ${aiUsage.reservedOutputTokens} - ${job.reservedOutputTokens})`,
        inputTokens: sql`${aiUsage.inputTokens} + ${settledUsage.input}`,
        outputTokens: sql`${aiUsage.outputTokens} + ${settledUsage.output}`,
      })
      .where(
        and(
          eq(aiUsage.workspaceId, job.workspaceId),
          eq(aiUsage.userId, job.userId),
          eq(aiUsage.day, day),
        ),
      );
  });
}

/** Accepts a structured agent result as an idempotent terminal transition. */
export async function acceptAiJobResult(
  db: Database,
  jobId: string,
  result: NonNullable<typeof aiJobs.$inferInsert.result>,
) {
  const [updated] = await db
    .update(aiJobs)
    .set({
      result,
      status: "completed",
      completedAt: new Date(),
      error: null,
    })
    .where(
      and(
        eq(aiJobs.id, jobId),
        eq(aiJobs.status, "running"),
        isNull(aiJobs.result),
      ),
    )
    .returning({ id: aiJobs.id });
  if (updated) return true;
  const existing = await db.query.aiJobs.findFirst({
    where: eq(aiJobs.id, jobId),
  });
  return (
    existing?.status === "completed" &&
    isDeepStrictEqual(existing.result, result)
  );
}

/** Runs one leased Flue dispatch and performs an idempotent terminal update. */
async function dispatchAiJob(db: Database, jobId: string) {
  const claimed = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${jobId}))`);
    const dispatch = await tx.query.aiDispatches.findFirst({
      where: eq(aiDispatches.jobId, jobId),
    });
    const job = await tx.query.aiJobs.findFirst({
      where: eq(aiJobs.id, jobId),
    });
    if (!dispatch || !job || dispatch.status === "completed") return null;
    if (job.status === "completed" && job.result) {
      await tx
        .update(aiDispatches)
        .set({ status: "completed", leaseExpiresAt: null })
        .where(eq(aiDispatches.jobId, jobId));
      return { alreadyCompleted: true as const, job };
    }
    const now = new Date();
    if (
      dispatch.availableAt > now ||
      (dispatch.status === "leased" &&
        dispatch.leaseExpiresAt &&
        dispatch.leaseExpiresAt > now)
    ) {
      return null;
    }
    const [leased] = await tx
      .update(aiDispatches)
      .set({
        status: "leased",
        attempts: dispatch.attempts + 1,
        leaseExpiresAt: new Date(now.getTime() + AI_DISPATCH_LEASE_MS),
        lastError: null,
      })
      .where(eq(aiDispatches.jobId, jobId))
      .returning();
    await tx
      .update(aiJobs)
      .set({ status: "running", error: null })
      .where(
        and(
          eq(aiJobs.id, jobId),
          or(eq(aiJobs.status, "queued"), eq(aiJobs.status, "running")),
        ),
      );
    return leased ? { alreadyCompleted: false as const, job } : null;
  });
  if (!claimed) return;
  if (claimed.alreadyCompleted) {
    await settleAiJobQuota(db, jobId);
    return;
  }

  try {
    const client = createFlueClient({
      baseUrl: env.FLUE_BASE_URL,
      token: env.FLUE_INTERNAL_SECRET,
    });
    const response = await client.agents.prompt("code-reviewer", jobId, {
      message: REVIEWDUCK_AGENT_RUN_PROMPT,
      signal: AbortSignal.timeout(650_000),
    });
    const [completed] = await db
      .update(aiJobs)
      .set({ status: "completed", completedAt: new Date(), error: null })
      .where(
        and(
          eq(aiJobs.id, jobId),
          isNotNull(aiJobs.result),
          isNull(aiJobs.completedAt),
        ),
      )
      .returning({ id: aiJobs.id });
    const hasResult =
      completed ??
      (await db.query.aiJobs.findFirst({
        where: and(eq(aiJobs.id, jobId), isNotNull(aiJobs.result)),
      }));
    if (!hasResult) throw new Error("The AI agent did not submit a result");
    await settleAiJobQuota(db, jobId, response.result.usage);
    await db
      .update(aiDispatches)
      .set({ status: "completed", leaseExpiresAt: null, lastError: null })
      .where(eq(aiDispatches.jobId, jobId));
  } catch (cause) {
    const dispatch = await db.query.aiDispatches.findFirst({
      where: eq(aiDispatches.jobId, jobId),
    });
    const job = await db.query.aiJobs.findFirst({
      where: eq(aiJobs.id, jobId),
    });
    let error = "AI service temporarily unavailable";
    try {
      const configuration = await getAiJobConfiguration(db, jobId);
      error = aiExecutionErrorMessage(cause, [
        configuration?.apiKey,
        ...Object.values(configuration?.headers ?? {}),
        env.FLUE_INTERNAL_SECRET,
      ]);
    } catch {
      // Keep the availability fallback if configuration lookup or redaction fails.
    }
    if (job?.result) {
      await db
        .update(aiJobs)
        .set({
          status: "completed",
          completedAt: job.completedAt ?? new Date(),
        })
        .where(eq(aiJobs.id, jobId));
      await settleAiJobQuota(db, jobId);
      await db
        .update(aiDispatches)
        .set({ status: "completed", leaseExpiresAt: null })
        .where(eq(aiDispatches.jobId, jobId));
      return;
    }
    if (
      isRetryableAiExecutionError(cause) &&
      (dispatch?.attempts ?? MAX_AI_DISPATCH_ATTEMPTS) <
        MAX_AI_DISPATCH_ATTEMPTS
    ) {
      const delay = 2 ** (dispatch?.attempts ?? 1) * 1_000;
      await db
        .update(aiDispatches)
        .set({
          status: "queued",
          availableAt: new Date(Date.now() + delay),
          leaseExpiresAt: null,
          lastError: error,
        })
        .where(eq(aiDispatches.jobId, jobId));
      await db
        .update(aiJobs)
        .set({ status: "queued", error: null })
        .where(eq(aiJobs.id, jobId));
      return;
    }
    await db
      .update(aiJobs)
      .set({
        status: "failed",
        error,
        completedAt: new Date(),
      })
      .where(and(eq(aiJobs.id, jobId), isNull(aiJobs.result)));
    await settleAiJobQuota(db, jobId);
    await db
      .update(aiDispatches)
      .set({ status: "completed", leaseExpiresAt: null, lastError: error })
      .where(eq(aiDispatches.jobId, jobId));
  }
}

/** Drains ready or expired durable AI dispatch records in bounded batches. */
async function drainReadyAiDispatches(db: Database, maximum: number) {
  let dispatched = 0;
  while (true) {
    const now = new Date();
    const ready = await db.query.aiDispatches.findMany({
      where: and(
        lte(aiDispatches.availableAt, now),
        or(
          eq(aiDispatches.status, "queued"),
          and(
            eq(aiDispatches.status, "leased"),
            lte(aiDispatches.leaseExpiresAt, now),
          ),
        ),
      ),
      orderBy: [aiDispatches.availableAt],
      limit: maximum,
    });
    if (ready.length === 0) return dispatched;
    await Promise.all(ready.map(({ jobId }) => dispatchAiJob(db, jobId)));
    dispatched += ready.length;
  }
}

/**
 * Coalesces dispatcher wake-ups and serializes local agent execution by
 * default. Flue's local runtime accepts one active agent run, so parallel
 * dispatch adds contention without increasing throughput.
 */
export function drainAiDispatches(
  db: Database,
  maximum = AI_DISPATCH_CONCURRENCY,
) {
  const active = activeAiDrains.get(db);
  if (active) return active;
  const drain = drainReadyAiDispatches(db, Math.max(1, maximum)).finally(() => {
    if (activeAiDrains.get(db) === drain) activeAiDrains.delete(db);
  });
  activeAiDrains.set(db, drain);
  return drain;
}

/** Kicks the durable dispatcher after the current request has completed. */
export function scheduleAiJob(db: Database, _jobId?: string) {
  after(() => drainAiDispatches(db));
}

/** Loads and decrypts the model configuration for an AI job. */
export async function getAiJobConfiguration(db: Database, jobId: string) {
  const job = await db.query.aiJobs.findFirst({ where: eq(aiJobs.id, jobId) });
  if (!job) return null;
  const configuration = await db.query.aiConfigurations.findFirst({
    where: eq(aiConfigurations.workspaceId, job.workspaceId),
  });
  const pullRequest = await db.query.pullRequests.findFirst({
    where: eq(pullRequests.id, job.pullRequestId),
  });
  const selectedUnit = job.unitId
    ? await db.query.reviewUnits.findFirst({
        where: and(
          eq(reviewUnits.id, job.unitId),
          eq(reviewUnits.snapshotId, job.snapshotId),
        ),
      })
    : undefined;
  if (!configuration || !pullRequest) return null;
  return {
    provider: configuration.provider,
    model: configuration.model,
    apiProtocol: configuration.apiProtocol,
    apiKey:
      !configuration.useManagedModels && configuration.encryptedApiKey
        ? decryptSecret(configuration.encryptedApiKey, env.ENCRYPTION_KEY)
        : undefined,
    headers:
      !configuration.useManagedModels && configuration.encryptedHeaders
        ? (JSON.parse(
            decryptSecret(configuration.encryptedHeaders, env.ENCRYPTION_KEY),
          ) as Record<string, string>)
        : undefined,
    baseUrl: configuration.baseUrl ?? defaultAiBaseUrl(configuration.provider),
    contextWindow: configuration.contextWindow,
    maxTokens: configuration.maxTokens,
    storeResponses: configuration.storeResponses,
    useManagedModels: configuration.useManagedModels,
    jobKind: job.kind,
    selectedUnit: selectedUnit
      ? {
          path: selectedUnit.path,
          name: selectedUnit.name,
          kind: selectedUnit.kind,
          startLine: selectedUnit.startLine,
          endLine: selectedUnit.endLine,
          changedLineRanges: explanationChangedLineRanges(selectedUnit),
        }
      : undefined,
    pullRequest: {
      title: pullRequest.title,
      description: pullRequest.description ?? undefined,
      sourceBranch: pullRequest.sourceBranch,
      targetBranch: pullRequest.targetBranch,
    },
  };
}
