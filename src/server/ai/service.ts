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
import {
  type ManagedAiPlanTier,
  managedAiMonthlyTokenLimit,
  managedAiMonthWindow,
  managedSaasModel,
} from "~/server/ai/plan";
import type { db as database } from "~/server/db";
import { isLocalDeployment } from "~/server/deployment";
import { hydrateReviewUnits } from "~/server/storage/review-units";
import { reviewJobTokenReservation } from "./turn-guards";
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

export const CURRENT_AI_AGENT_VERSION = 14;

/** The refusal a caller without a deep-review entitlement is told verbatim. */
export const DEEP_REVIEW_UNENTITLED_MESSAGE =
  "Deep review requires a paid plan";

/**
 * Reports whether an account may run a deep review of a pull request.
 *
 * The disjunction is load-bearing rather than redundant. `jobScope` below
 * forces `subscribed` to false on a local deployment, because it is derived
 * from a Clerk entitlement and there is no Clerk on the appliance — so writing
 * this as `subscribed` alone would switch deep review permanently off for
 * every self-hosted operator. Nor is there anything to protect there:
 * `useManagedQuota` is likewise `!local`, so a local operator configures and
 * pays for their own provider. The paid gate is a rule about hosted economics,
 * and the appliance has none.
 */
export function deepReviewAvailable(subscribed: boolean) {
  return subscribed || isLocalDeployment();
}

/** Authorizes and resolves the immutable workspace, revision, and model scope. */
async function jobScope(
  db: Database,
  input: {
    pullRequestId: string;
    userId: string;
    subscribed: boolean;
    planTier?: ManagedAiPlanTier;
    reviewScope?: "pull_request" | "repository_snapshot";
    reviewPurpose?: "code" | "compliance";
    ruleConfigDigest?: string;
    reviewRules?: NonNullable<typeof aiJobs.$inferInsert.reviewRules>;
  },
) {
  const local = isLocalDeployment();
  const [scopes, snapshot] = await Promise.all([
    db
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
      .limit(1),
    db.query.reviewSnapshots.findFirst({
      where: eq(reviewSnapshots.pullRequestId, input.pullRequestId),
      orderBy: (table, { desc }) => [desc(table.version)],
    }),
  ]);
  const [scope] = scopes;
  // Authorization decides the error the caller sees, so it is checked before
  // the snapshot even though both rows are already loaded.
  if (!scope) throw new Error("Pull request not found");
  if (!snapshot) throw new Error("No review snapshot found");
  const [preference, localConfiguration] = await Promise.all([
    db.query.aiPreferences.findFirst({
      where: eq(aiPreferences.workspaceId, scope.workspace.id),
    }),
    local
      ? db.query.localAiConfigurations.findFirst({
          where: eq(localAiConfigurations.workspaceId, scope.workspace.id),
        })
      : undefined,
  ]);
  const subscribed = !local && input.subscribed;
  const planTier: ManagedAiPlanTier = local
    ? "free"
    : (input.planTier ?? (subscribed ? "pro" : "free"));
  const selectedModel = local
    ? (preference?.selectedModel ?? "")
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
  return {
    model: selectedModel,
    provider,
    snapshot,
    monthlyTokenLimit: managedAiMonthlyTokenLimit(planTier),
    maxReviewTokens: preference?.maxReviewTokens ?? null,
    useManagedQuota: !local,
    workspaceId: scope.workspace.id,
  };
}

/** Records a start against daily request caps and the settled monthly token ceiling. */
async function reserveManagedQuota(
  tx: Transaction,
  input: {
    workspaceId: string;
    userId: string;
    requests: number;
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
  const [daily] = await tx
    .select({
      requests: sum(aiUsage.requests),
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
    })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.userId, input.userId),
        gte(aiUsage.day, monthStart),
        lt(aiUsage.day, monthEnd),
      ),
    );
  const usedMonthlyTokens =
    Number(monthly?.input ?? 0) + Number(monthly?.output ?? 0);
  if (usedMonthlyTokens >= input.monthlyTokenLimit) {
    throw new Error("Monthly AI token limit reached");
  }
  await tx
    .insert(aiUsage)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      day: dayStart,
      requests: input.requests,
    })
    .onConflictDoUpdate({
      target: [aiUsage.workspaceId, aiUsage.userId, aiUsage.day],
      set: {
        requests: sql`${aiUsage.requests} + ${input.requests}`,
      },
    });
}

/** Loads catalog pricing and rejects models that cannot run the investigation tools. */
async function managedReservationPricing(db: Database, modelId: string) {
  const model = await db.query.managedAiModels.findFirst({
    where: eq(managedAiModels.modelId, modelId),
  });
  if (!model?.supportsTools) {
    throw new Error(
      "The managed model is missing a current tool-capable catalog entry",
    );
  }
  return model;
}

/** Creates one deduplicated, quota-reserved AI job without dispatch polling. */
export async function createAiJob(
  db: Database,
  input: {
    pullRequestId: string;
    unitId?: string;
    /**
     * `review` is the deep-review parent, and the only review row created
     * here: the fan-out's `review_file` and `review_survey` children are
     * inserted by `createReviewChildJob` inside the seal-plan transaction.
     */
    kind: "explain" | "review" | "semantic_cluster";
    question?: string;
    layoutKey?: string;
    focusLine?: number;
    threadId?: string;
    userId: string;
    subscribed: boolean;
    planTier?: ManagedAiPlanTier;
    reviewScope?: "pull_request" | "repository_snapshot";
    reviewPurpose?: "code" | "compliance";
    ruleConfigDigest?: string;
    reviewRules?: NonNullable<typeof aiJobs.$inferInsert.reviewRules>;
  },
) {
  // Entitlement is read once, here, and never again: a job that exists is a
  // job that runs, so a subscription lapsing mid-review cannot strand a sealed
  // plan with no reviewer willing to execute it. Refusing before `jobScope`
  // also keeps an unentitled caller off the snapshot hydration entirely.
  if (input.kind === "review" && !deepReviewAvailable(input.subscribed)) {
    throw new Error(DEEP_REVIEW_UNENTITLED_MESSAGE);
  }
  const scope = await jobScope(db, input);
  const storedUnits = await db.query.reviewUnits.findMany({
    where: input.unitId
      ? and(
          eq(reviewUnits.snapshotId, scope.snapshot.id),
          eq(reviewUnits.id, input.unitId),
        )
      : eq(reviewUnits.snapshotId, scope.snapshot.id),
    columns: { id: true },
  });
  if (storedUnits.length === 0) throw new Error("No review context found");
  if (scope.useManagedQuota) {
    await managedReservationPricing(db, scope.model);
  }
  return db.transaction(async (tx) => {
    if (!input.question) {
      // A clustering run is identified by the layout revision it proposes
      // for, so two of them collide only when they would produce the same
      // answer. Anything else keys on the unit it reads.
      const reviewScope = input.reviewScope ?? "pull_request";
      const reviewPurpose = input.reviewPurpose ?? "code";
      const dedupeKey = `${scope.snapshot.id}:${input.userId}:${input.kind}:automatic:${input.layoutKey ?? input.unitId ?? "pull-request"}:${reviewScope}:${reviewPurpose}:${input.ruleConfigDigest ?? "default-rules"}`;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${dedupeKey}))`,
      );
      const existing = await tx.query.aiJobs.findFirst({
        where: and(
          eq(aiJobs.snapshotId, scope.snapshot.id),
          eq(aiJobs.userId, input.userId),
          eq(aiJobs.kind, input.kind),
          eq(aiJobs.agentVersion, CURRENT_AI_AGENT_VERSION),
          eq(aiJobs.reviewScope, reviewScope),
          eq(aiJobs.reviewPurpose, reviewPurpose),
          input.ruleConfigDigest
            ? eq(aiJobs.ruleConfigDigest, input.ruleConfigDigest)
            : input.kind === "review"
              ? undefined
              : isNull(aiJobs.ruleConfigDigest),
          input.unitId
            ? eq(aiJobs.unitId, input.unitId)
            : isNull(aiJobs.unitId),
          isNull(aiJobs.question),
          input.layoutKey
            ? eq(aiJobs.layoutKey, input.layoutKey)
            : isNull(aiJobs.layoutKey),
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
        monthlyTokenLimit: scope.monthlyTokenLimit,
      });
    }
    const reservation =
      input.kind === "review"
        ? reviewJobTokenReservation(scope.maxReviewTokens)
        : { input: 0, output: 0 };
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
        layoutKey: input.layoutKey,
        reviewScope: input.reviewScope ?? "pull_request",
        reviewPurpose: input.reviewPurpose ?? "code",
        ruleConfigDigest: input.ruleConfigDigest,
        reviewRules: input.reviewRules,
        agentVersion: CURRENT_AI_AGENT_VERSION,
        status: "queued",
        model: scope.model,
        provider: scope.provider,
        reservedInputTokens: reservation.input,
        reservedOutputTokens: reservation.output,
        reservedMicroUsd: 0,
      })
      .returning();
    if (!job) throw new Error("Could not create AI job");
    return job;
  });
}

/**
 * Atomically releases a quota reservation and records terminal usage.
 *
 * A transaction handle is admitted so a caller that already holds a lock can
 * settle without leaving it; on that handle the block below is a savepoint,
 * which is as atomic as the top-level transaction it nests in.
 */
export async function settleAiJobQuota(
  db: Database | Transaction,
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
    if (settled.microUsd > 0 || job.reservedMicroUsd > 0) {
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
    const day = new Date(job.createdAt);
    day.setUTCHours(0, 0, 0, 0);
    await tx
      .insert(aiUsage)
      .values({
        workspaceId: job.workspaceId,
        userId: job.userId,
        day,
        requests: 0,
        reservedInputTokens: 0,
        reservedOutputTokens: 0,
        inputTokens: settled.input,
        outputTokens: settled.output,
      })
      .onConflictDoUpdate({
        target: [aiUsage.workspaceId, aiUsage.userId, aiUsage.day],
        set: {
          reservedInputTokens: sql`greatest(0, ${aiUsage.reservedInputTokens} - ${job.reservedInputTokens})`,
          reservedOutputTokens: sql`greatest(0, ${aiUsage.reservedOutputTokens} - ${job.reservedOutputTokens})`,
          inputTokens: sql`${aiUsage.inputTokens} + ${settled.input}`,
          outputTokens: sql`${aiUsage.outputTokens} + ${settled.output}`,
        },
      });
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
