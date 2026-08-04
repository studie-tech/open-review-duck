import "server-only";

import { isDeepStrictEqual } from "node:util";
import { and, eq, gte, isNull, lt, ne, or, sql, sum } from "drizzle-orm";
import {
  aiJobs,
  aiPreferences,
  aiUsage,
  aiUsageLedger,
  localAiConfigurations,
  managedAiModels,
  pullRequests,
  repositories,
  reviewSnapshots,
  reviewUnits,
  workspaceMembers,
  workspaces,
} from "@/drizzle/schema";
import { env } from "~/env";
import {
  constrainAnnotationToChangedLines,
  explanationChangedLineRanges,
} from "~/server/ai/change-scope";
import { paidReservationMicroUsd } from "~/server/ai/cost";
import {
  managedAiMonthlyTokenLimit,
  managedAiMonthWindow,
  managedSaasModel,
} from "~/server/ai/plan";
import type { db as database } from "~/server/db";
import { isLocalDeployment } from "~/server/deployment";
import { hydrateReviewUnits } from "~/server/storage/review-units";
import { managedInvestigationReservation } from "./turn-guards";
import { nonReducingAiUsage } from "./usage";

type Database = typeof database;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  microUsd?: number;
};

export const CURRENT_AI_AGENT_VERSION = 13;
/** Estimates a conservative token reservation for one investigation. */
function estimateAiReservation(
  units: Array<{
    source: string;
    previousSource: string | null;
    path: string;
    name: string;
    kind: string;
  }>,
  kind: "explain" | "review",
  monthlyTokenLimit: number,
) {
  const requestBytes = units.reduce(
    (total, unit) =>
      total +
      Buffer.byteLength(unit.source) +
      Buffer.byteLength(unit.previousSource ?? "") +
      Buffer.byteLength(unit.path) +
      Buffer.byteLength(unit.name) +
      Buffer.byteLength(unit.kind),
    0,
  );
  return managedInvestigationReservation({
    requestBytes,
    kind,
    monthlyTokenLimit,
  });
}

/** Authorizes and resolves the immutable workspace, revision, and model scope. */
async function jobScope(
  db: Database,
  input: {
    pullRequestId: string;
    userId: string;
    subscribed: boolean;
  },
) {
  const [scope] = await db
    .select({
      workspace: workspaces,
    })
    .from(pullRequests)
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .innerJoin(workspaces, eq(repositories.workspaceId, workspaces.id))
    .innerJoin(
      workspaceMembers,
      eq(workspaces.id, workspaceMembers.workspaceId),
    )
    .where(
      and(
        eq(pullRequests.id, input.pullRequestId),
        eq(workspaceMembers.userId, input.userId),
      ),
    )
    .limit(1);
  if (!scope) throw new Error("Pull request not found");
  const snapshot = await db.query.reviewSnapshots.findFirst({
    where: eq(reviewSnapshots.pullRequestId, input.pullRequestId),
    orderBy: (table, { desc }) => [desc(table.version)],
  });
  if (!snapshot) throw new Error("No review snapshot found");
  const preference = await db.query.aiPreferences.findFirst({
    where: eq(aiPreferences.workspaceId, scope.workspace.id),
  });
  const local = isLocalDeployment();
  const localConfiguration = local
    ? await db.query.localAiConfigurations.findFirst({
        where: eq(localAiConfigurations.workspaceId, scope.workspace.id),
      })
    : undefined;
  const subscribed = !local && input.subscribed;
  const selectedModel = local
    ? (preference?.selectedModel ?? "big-pickle")
    : managedSaasModel();
  let provider: string;
  if (local) {
    if (!localConfiguration || selectedModel !== localConfiguration.model) {
      throw new Error("Configure a local AI provider before using AI");
    }
    provider = localConfiguration.provider;
  } else {
    provider = "openrouter";
  }
  if (
    provider === "opencode" &&
    !preference?.freeProviderDisclosureAcceptedAt
  ) {
    throw new Error("Accept the Big Pickle data disclosure before using AI");
  }
  return {
    model: selectedModel,
    provider,
    snapshot,
    monthlyTokenLimit: managedAiMonthlyTokenLimit(subscribed),
    useManagedQuota: !local,
    workspaceId: scope.workspace.id,
  };
}

/** Atomically reserves workspace request and token quota. */
async function reserveManagedQuota(
  tx: Transaction,
  input: {
    workspaceId: string;
    userId: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    reservedMicroUsd: number;
    monthlyTokenLimit: number;
  },
) {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { startsAt: monthStart, resetsAt: monthEnd } =
    managedAiMonthWindow(dayStart);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`ai-quota:workspace:${input.workspaceId}`}))`,
  );
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`ai-quota:user:${input.userId}`}))`,
  );
  if (input.reservedMicroUsd > 0) {
    const month = new Date().toISOString().slice(0, 7);
    const [monthly] = await tx
      .select({ microUsd: sum(aiUsageLedger.microUsd) })
      .from(aiUsageLedger)
      .where(
        and(
          eq(aiUsageLedger.workspaceId, input.workspaceId),
          eq(aiUsageLedger.month, month),
        ),
      );
    const monthlyLimit = Math.floor(
      (env.OPENROUTER_WORKSPACE_MONTHLY_LIMIT_USD ?? 0) * 1_000_000,
    );
    if (
      monthlyLimit <= 0 ||
      Number(monthly?.microUsd ?? 0) + input.reservedMicroUsd > monthlyLimit
    ) {
      throw new Error("Workspace monthly AI budget is exhausted");
    }
  }
  const [daily] = await tx
    .select({
      requests: sum(aiUsage.requests),
      reservedInput: sum(aiUsage.reservedInputTokens),
      reservedOutput: sum(aiUsage.reservedOutputTokens),
    })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.workspaceId, input.workspaceId),
        gte(aiUsage.day, dayStart),
      ),
    );
  if (
    Number(daily?.requests ?? 0) + input.requests >
    env.MANAGED_AI_DAILY_REQUEST_LIMIT
  ) {
    throw new Error("Daily managed AI request limit reached");
  }
  const [userDaily] = await tx
    .select({ requests: sum(aiUsage.requests) })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.workspaceId, input.workspaceId),
        eq(aiUsage.userId, input.userId),
        gte(aiUsage.day, dayStart),
      ),
    );
  if (
    Number(userDaily?.requests ?? 0) + input.requests >
    env.MANAGED_AI_USER_DAILY_REQUEST_LIMIT
  ) {
    throw new Error("Daily user AI request limit reached");
  }
  const [monthly] = await tx
    .select({
      input: sum(aiUsage.inputTokens),
      output: sum(aiUsage.outputTokens),
      reservedInput: sum(aiUsage.reservedInputTokens),
      reservedOutput: sum(aiUsage.reservedOutputTokens),
    })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.userId, input.userId),
        gte(aiUsage.day, monthStart),
        lt(aiUsage.day, monthEnd),
      ),
    );
  const monthlyTokens =
    Number(monthly?.input ?? 0) +
    Number(monthly?.output ?? 0) +
    Number(monthly?.reservedInput ?? 0) +
    Number(monthly?.reservedOutput ?? 0) +
    input.inputTokens +
    input.outputTokens;
  if (monthlyTokens > input.monthlyTokenLimit) {
    throw new Error("Monthly AI token limit reached");
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

/** Loads catalog pricing and rejects models that cannot run the investigation tools. */
async function estimatePaidCostReservation(
  db: Database,
  modelId: string,
  reservation: { input: number; output: number },
) {
  const model = await db.query.managedAiModels.findFirst({
    where: eq(managedAiModels.modelId, modelId),
  });
  if (!model?.supportsTools) {
    throw new Error(
      "The managed model is missing a current tool-capable catalog entry",
    );
  }
  return paidReservationMicroUsd(reservation, model);
}

/** Creates one deduplicated, quota-reserved AI job without dispatch polling. */
export async function createAiJob(
  db: Database,
  input: {
    pullRequestId: string;
    unitId?: string;
    kind: "explain" | "review";
    question?: string;
    focusLine?: number;
    threadId?: string;
    userId: string;
    subscribed: boolean;
  },
) {
  const scope = await jobScope(db, input);
  const units = await hydrateReviewUnits(
    db,
    await db.query.reviewUnits.findMany({
      where: input.unitId
        ? and(
            eq(reviewUnits.snapshotId, scope.snapshot.id),
            eq(reviewUnits.id, input.unitId),
          )
        : eq(reviewUnits.snapshotId, scope.snapshot.id),
    }),
  );
  if (units.length === 0) throw new Error("No review context found");
  const reservation = estimateAiReservation(
    units,
    input.kind,
    scope.monthlyTokenLimit,
  );
  const reservedMicroUsd = scope.useManagedQuota
    ? await estimatePaidCostReservation(db, scope.model, reservation)
    : 0;
  return db.transaction(async (tx) => {
    if (!input.question) {
      const dedupeKey = `${scope.snapshot.id}:${input.userId}:${input.kind}:automatic:${input.unitId ?? "pull-request"}`;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${dedupeKey}))`,
      );
      const existing = await tx.query.aiJobs.findFirst({
        where: and(
          eq(aiJobs.snapshotId, scope.snapshot.id),
          eq(aiJobs.userId, input.userId),
          eq(aiJobs.kind, input.kind),
          eq(aiJobs.agentVersion, CURRENT_AI_AGENT_VERSION),
          input.unitId
            ? eq(aiJobs.unitId, input.unitId)
            : isNull(aiJobs.unitId),
          isNull(aiJobs.question),
          or(
            eq(aiJobs.status, "queued"),
            eq(aiJobs.status, "running"),
            eq(aiJobs.status, "waiting_for_provider"),
            eq(aiJobs.status, "streaming"),
          ),
        ),
        orderBy: (table, { desc }) => [desc(table.createdAt)],
      });
      if (existing) return existing;
    }
    if (scope.useManagedQuota) {
      await reserveManagedQuota(tx, {
        workspaceId: scope.workspaceId,
        userId: input.userId,
        requests: 1,
        inputTokens: reservation.input,
        outputTokens: reservation.output,
        reservedMicroUsd,
        monthlyTokenLimit: scope.monthlyTokenLimit,
      });
    }
    const jobId = crypto.randomUUID();
    const [job] = await tx
      .insert(aiJobs)
      .values({
        id: jobId,
        workspaceId: scope.workspaceId,
        pullRequestId: input.pullRequestId,
        snapshotId: scope.snapshot.id,
        unitId: input.unitId,
        userId: input.userId,
        kind: input.kind,
        question: input.question,
        focusLine: input.focusLine,
        threadId: input.threadId,
        agentVersion: CURRENT_AI_AGENT_VERSION,
        status: "queued",
        model: scope.model,
        provider: scope.provider,
        reservedInputTokens: scope.useManagedQuota ? reservation.input : 0,
        reservedOutputTokens: scope.useManagedQuota ? reservation.output : 0,
        reservedMicroUsd,
      })
      .returning();
    if (!job) throw new Error("Could not create AI job");
    if (reservedMicroUsd > 0) {
      await tx.insert(aiUsageLedger).values({
        workspaceId: scope.workspaceId,
        jobId,
        month: new Date().toISOString().slice(0, 7),
        kind: "reservation",
        microUsd: reservedMicroUsd,
      });
    }
    return job;
  });
}

/** Atomically releases a quota reservation and records terminal usage. */
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
    const settled = nonReducingAiUsage(job, usage);
    await tx
      .update(aiJobs)
      .set({
        inputTokens: sql`greatest(${aiJobs.inputTokens}, ${settled.input})`,
        outputTokens: sql`greatest(${aiJobs.outputTokens}, ${settled.output})`,
        cacheReadTokens: sql`greatest(${aiJobs.cacheReadTokens}, ${settled.cacheRead})`,
        cacheWriteTokens: sql`greatest(${aiJobs.cacheWriteTokens}, ${settled.cacheWrite})`,
        totalTokens: sql`greatest(${aiJobs.totalTokens}, ${settled.totalTokens})`,
        actualMicroUsd: sql`greatest(${aiJobs.actualMicroUsd}, ${settled.microUsd})`,
        quotaSettledAt: new Date(),
      })
      .where(and(eq(aiJobs.id, job.id), isNull(aiJobs.quotaSettledAt)));
    if (job.reservedMicroUsd > 0) {
      await tx
        .insert(aiUsageLedger)
        .values({
          workspaceId: job.workspaceId,
          jobId: job.id,
          month: job.createdAt.toISOString().slice(0, 7),
          kind: "settlement",
          microUsd: (settled.microUsd ?? 0) - job.reservedMicroUsd,
          inputTokens: settled.input,
          outputTokens: settled.output,
        })
        .onConflictDoNothing({
          target: [aiUsageLedger.jobId, aiUsageLedger.kind],
        });
    }
    if (!job.reservedInputTokens && !job.reservedOutputTokens) return;
    const day = new Date(job.createdAt);
    day.setUTCHours(0, 0, 0, 0);
    await tx
      .update(aiUsage)
      .set({
        reservedInputTokens: sql`greatest(0, ${aiUsage.reservedInputTokens} - ${job.reservedInputTokens})`,
        reservedOutputTokens: sql`greatest(0, ${aiUsage.reservedOutputTokens} - ${job.reservedOutputTokens})`,
        inputTokens: sql`${aiUsage.inputTokens} + ${settled.input}`,
        outputTokens: sql`${aiUsage.outputTokens} + ${settled.output}`,
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

/** Accepts one structured final result as an idempotent terminal transition. */
export async function acceptAiJobResult(
  db: Database,
  jobId: string,
  result: NonNullable<typeof aiJobs.$inferInsert.result>,
  completionReason:
    | "answered"
    | "investigation_limit"
    | "quota_limit"
    | "cost_limit" = "answered",
) {
  const job = await db.query.aiJobs.findFirst({
    columns: { kind: true, unitId: true },
    where: eq(aiJobs.id, jobId),
  });
  let scopedResult = result;
  if (job?.kind === "explain" && job.unitId) {
    const [unit] = await hydrateReviewUnits(
      db,
      await db.query.reviewUnits.findMany({
        where: eq(reviewUnits.id, job.unitId),
        limit: 1,
      }),
    );
    if (!unit) throw new Error("AI explanation unit not found");
    const ranges = explanationChangedLineRanges(unit);
    scopedResult = {
      ...result,
      findings: [],
      annotations: result.annotations.flatMap((annotation) => {
        if (annotation.path !== unit.path) return [];
        const constrained = constrainAnnotationToChangedLines(
          annotation,
          ranges,
        );
        return constrained ? [constrained] : [];
      }),
      commentProposals: (result.commentProposals ?? []).filter(
        (proposal) =>
          proposal.path === unit.path &&
          ranges.some(
            ({ startLine, endLine }) =>
              proposal.line >= startLine && proposal.line <= endLine,
          ),
      ),
    };
  }
  const [updated] = await db
    .update(aiJobs)
    .set({
      result: scopedResult,
      completionReason,
      status: "completed",
      progress: 100,
      completedAt: new Date(),
      error: null,
    })
    .where(
      and(
        eq(aiJobs.id, jobId),
        isNull(aiJobs.result),
        ne(aiJobs.status, "cancelled"),
      ),
    )
    .returning({ id: aiJobs.id });
  if (updated) return true;
  const existing = await db.query.aiJobs.findFirst({
    where: eq(aiJobs.id, jobId),
  });
  return (
    existing?.status === "completed" &&
    isDeepStrictEqual(existing.result, scopedResult)
  );
}

/** Starts the durable AI workflow and returns its public run identity. */
export async function scheduleAiJob(db: Database, jobId: string) {
  const { startAiJob } = await import("~/server/workflows/service");
  return startAiJob(db, jobId);
}
