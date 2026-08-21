import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  aiJobs,
  providerConnections,
  pullRequests,
  repositories,
  repositoryBranchMonitors,
  repositoryBranchSyncRuns,
  repositoryReviewRules,
  reviewSnapshots,
  reviewUnits,
  signOffs,
  snapshotFiles,
} from "@/drizzle/schema";
import { PAID_AI_FEATURE } from "~/server/ai/plan";
import { createAiJob, scheduleAiJob } from "~/server/ai/service";
import { providerConnectionErrorMessage } from "~/server/providers/connection-error";
import { providerForConnection } from "~/server/providers/credentials";
import type { ProviderName } from "~/server/providers/types";
import type { RepositoryBranch } from "~/server/providers/types";
import {
  REPOSITORY_RECONCILE_INTERVAL_MS,
  reconcileRepositoryBranchMonitors,
} from "~/server/repo-reviews/reconcile";
import {
  repositoryRuleDigest,
  type RepositoryReviewRuleSnapshot,
} from "~/server/repo-reviews/rules";
import { enforceRateLimit } from "~/server/security/rate-limit";
import { startRepositoryBranchSync } from "~/server/workflows/service";
import { ensurePersonalWorkspace } from "~/server/workspaces/service";
import { deepReviewRunPayload } from "./review";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const monitorIdSchema = z.object({ monitorId: z.uuid() });
const ruleScopeSchema = z.enum(["file", "repository"]);
const ruleSeveritySchema = z.enum(["critical", "high", "medium", "low"]);
const ruleFields = {
  title: z.string().trim().min(1).max(200),
  instruction: z.string().trim().min(1).max(8_000),
  pathGlob: z.string().trim().min(1).max(500),
  scope: ruleScopeSchema,
  severity: ruleSeveritySchema,
} as const;

/** Authorizes a repository monitor and loads its provider scope. */
async function monitorScope(
  db: Parameters<
    Parameters<typeof protectedProcedure.query>[0]
  >[0]["ctx"]["db"],
  userId: string,
  monitorId: string,
) {
  const workspace = await ensurePersonalWorkspace(db, userId);
  const [scope] = await db
    .select({
      monitor: repositoryBranchMonitors,
      repository: repositories,
      connection: providerConnections,
    })
    .from(repositoryBranchMonitors)
    .innerJoin(
      repositories,
      eq(repositoryBranchMonitors.repositoryId, repositories.id),
    )
    .innerJoin(
      providerConnections,
      eq(repositories.connectionId, providerConnections.id),
    )
    .where(
      and(
        eq(repositoryBranchMonitors.id, monitorId),
        eq(repositoryBranchMonitors.workspaceId, workspace.id),
      ),
    )
    .limit(1);
  if (!scope) throw new TRPCError({ code: "NOT_FOUND" });
  return { ...scope, workspace };
}

/** Converts a provider failure into bounded public API guidance. */
function publicProviderError(provider: ProviderName, cause: unknown) {
  return new TRPCError({
    code: "BAD_GATEWAY",
    message: providerConnectionErrorMessage(provider, cause),
    cause,
  });
}

/** Repository-monitor cockpit, rule management, and repository-scoped runs. */
export const repoReviewsRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
    const rows = await ctx.db
      .select({
        id: repositoryBranchMonitors.id,
        branch: repositoryBranchMonitors.branch,
        currentHeadSha: repositoryBranchMonitors.currentHeadSha,
        lastCheckedAt: repositoryBranchMonitors.lastCheckedAt,
        lastSyncedAt: repositoryBranchMonitors.lastSyncedAt,
        lastError: repositoryBranchMonitors.lastError,
        createdAt: repositoryBranchMonitors.createdAt,
        pullRequestId: repositoryBranchMonitors.pullRequestId,
        repositoryId: repositories.id,
        repositoryOwner: repositories.owner,
        repositoryName: repositories.name,
        repositoryWebUrl: repositories.webUrl,
        provider: providerConnections.provider,
      })
      .from(repositoryBranchMonitors)
      .innerJoin(
        repositories,
        eq(repositoryBranchMonitors.repositoryId, repositories.id),
      )
      .innerJoin(
        providerConnections,
        eq(repositories.connectionId, providerConnections.id),
      )
      .where(eq(repositoryBranchMonitors.workspaceId, workspace.id))
      .orderBy(desc(repositoryBranchMonitors.updatedAt));

    return Promise.all(
      rows.map(async (row) => {
        const snapshot = await ctx.db.query.reviewSnapshots.findFirst({
          where: eq(reviewSnapshots.pullRequestId, row.pullRequestId),
          orderBy: [desc(reviewSnapshots.version)],
        });
        const [units, files] = snapshot
          ? await Promise.all([
              ctx.db.query.reviewUnits.findMany({
                columns: {
                  id: true,
                  snapshotFileId: true,
                  requiresReReview: true,
                },
                where: and(
                  eq(reviewUnits.snapshotId, snapshot.id),
                  ne(reviewUnits.kind, "file"),
                ),
              }),
              ctx.db.query.snapshotFiles.findMany({
                columns: { id: true },
                where: eq(snapshotFiles.snapshotId, snapshot.id),
              }),
            ])
          : [[], []];
        const signed = units.length
          ? await ctx.db
              .select({ unitId: signOffs.unitId })
              .from(signOffs)
              .where(
                and(
                  eq(signOffs.userId, ctx.auth.userId),
                  inArray(
                    signOffs.unitId,
                    units.map(({ id }) => id),
                  ),
                  isNull(signOffs.invalidatedAt),
                ),
              )
          : [];
        const activeSync =
          await ctx.db.query.repositoryBranchSyncRuns.findFirst({
            where: and(
              eq(repositoryBranchSyncRuns.monitorId, row.id),
              inArray(repositoryBranchSyncRuns.status, ["queued", "running"]),
            ),
            orderBy: [desc(repositoryBranchSyncRuns.createdAt)],
          });
        const jobs = snapshot
          ? await ctx.db.query.aiJobs.findMany({
              columns: {
                id: true,
                status: true,
                progress: true,
                reviewPurpose: true,
                createdAt: true,
                completedAt: true,
              },
              where: and(
                eq(aiJobs.pullRequestId, row.pullRequestId),
                eq(aiJobs.snapshotId, snapshot.id),
                eq(aiJobs.userId, ctx.auth.userId),
                eq(aiJobs.kind, "review"),
                eq(aiJobs.reviewScope, "repository_snapshot"),
                isNull(aiJobs.parentJobId),
              ),
              orderBy: [desc(aiJobs.createdAt)],
              limit: 12,
            })
          : [];
        const signedIds = new Set(signed.map(({ unitId }) => unitId));
        const reviewableFileCount = new Set(
          units.flatMap(({ snapshotFileId }) =>
            snapshotFileId ? [snapshotFileId] : [],
          ),
        ).size;
        return {
          ...row,
          snapshot: snapshot
            ? {
                id: snapshot.id,
                version: snapshot.version,
                headSha: snapshot.headSha,
                createdAt: snapshot.createdAt,
              }
            : null,
          progress: {
            total: units.length,
            signed: units.filter(({ id }) => signedIds.has(id)).length,
            unseen: units.filter(({ id }) => !signedIds.has(id)).length,
            changed: units.filter(({ requiresReReview }) => requiresReReview)
              .length,
          },
          coverage: {
            files: files.length,
            reviewableFiles: reviewableFileCount,
            nonReviewableFiles: files.length - reviewableFileCount,
          },
          activeSync: activeSync
            ? {
                id: activeSync.id,
                status: activeSync.status,
                progress: activeSync.progress,
                error: activeSync.error,
              }
            : null,
          latestCodeRun:
            jobs.find(({ reviewPurpose }) => reviewPurpose === "code") ?? null,
          latestComplianceRun:
            jobs.find(({ reviewPurpose }) => reviewPurpose === "compliance") ??
            null,
        };
      }),
    );
  }),

  listBranches: protectedProcedure
    .input(z.object({ repositoryId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
      const [scope] = await ctx.db
        .select({ repository: repositories, connection: providerConnections })
        .from(repositories)
        .innerJoin(
          providerConnections,
          eq(repositories.connectionId, providerConnections.id),
        )
        .where(
          and(
            eq(repositories.id, input.repositoryId),
            eq(repositories.workspaceId, workspace.id),
          ),
        )
        .limit(1);
      if (!scope) throw new TRPCError({ code: "NOT_FOUND" });
      try {
        const branches = await (
          await providerForConnection(ctx.db, scope.connection)
        ).listBranches(scope.repository.externalId);
        return branches.sort((left, right) => {
          if (left.isDefault !== right.isDefault)
            return left.isDefault ? -1 : 1;
          return left.name.localeCompare(right.name);
        });
      } catch (cause) {
        throw publicProviderError(scope.connection.provider, cause);
      }
    }),

  add: protectedProcedure
    .input(
      z.object({
        repositoryId: z.uuid(),
        branch: z.string().trim().min(1).max(255),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
      await enforceRateLimit(
        ctx.db,
        `repository-monitor-add:${workspace.id}:${ctx.auth.userId}`,
        20,
        10 * 60_000,
      );
      const [scope] = await ctx.db
        .select({ repository: repositories, connection: providerConnections })
        .from(repositories)
        .innerJoin(
          providerConnections,
          eq(repositories.connectionId, providerConnections.id),
        )
        .where(
          and(
            eq(repositories.id, input.repositoryId),
            eq(repositories.workspaceId, workspace.id),
          ),
        )
        .limit(1);
      if (!scope) throw new TRPCError({ code: "NOT_FOUND" });
      let branch: RepositoryBranch;
      try {
        branch = await (
          await providerForConnection(ctx.db, scope.connection)
        ).getBranch(scope.repository.externalId, input.branch);
      } catch (cause) {
        throw publicProviderError(scope.connection.provider, cause);
      }
      const monitorId = randomUUID();
      const pullRequestId = randomUUID();
      const monitor = await ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`repository-monitor:${input.repositoryId}:${branch.name}`}))`,
        );
        const existing = await tx.query.repositoryBranchMonitors.findFirst({
          where: and(
            eq(repositoryBranchMonitors.repositoryId, input.repositoryId),
            eq(repositoryBranchMonitors.branch, branch.name),
          ),
        });
        if (existing) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "That repository branch is already monitored.",
          });
        }
        await tx.insert(pullRequests).values({
          id: pullRequestId,
          repositoryId: scope.repository.id,
          externalId: `repository-branch:${monitorId}`,
          number: 0,
          title: `${scope.repository.owner}/${scope.repository.name} · ${branch.name}`,
          description: `Monitored repository branch ${branch.name}`,
          authorLogin: "Repository branch",
          sourceBranch: branch.name,
          targetBranch: branch.name,
          headSha: branch.sha,
          baseSha: branch.sha,
          state: "open",
          webUrl: branch.webUrl,
        });
        const [created] = await tx
          .insert(repositoryBranchMonitors)
          .values({
            id: monitorId,
            workspaceId: workspace.id,
            repositoryId: scope.repository.id,
            pullRequestId,
            branch: branch.name,
            createdBy: ctx.auth.userId,
          })
          .returning();
        if (!created) throw new Error("Could not create repository monitor");
        return created;
      });
      const sync = await startRepositoryBranchSync(ctx.db, {
        workspaceId: workspace.id,
        monitorId: monitor.id,
        force: true,
      });
      return { monitor, sync };
    }),

  sync: protectedProcedure
    .input(monitorIdSchema)
    .mutation(async ({ ctx, input }) => {
      const scope = await monitorScope(
        ctx.db,
        ctx.auth.userId,
        input.monitorId,
      );
      await enforceRateLimit(
        ctx.db,
        `repository-monitor-sync:${scope.workspace.id}:${ctx.auth.userId}`,
        30,
        10 * 60_000,
      );
      return startRepositoryBranchSync(ctx.db, {
        workspaceId: scope.workspace.id,
        monitorId: input.monitorId,
        force: true,
      });
    }),

  reconcile: protectedProcedure.mutation(async ({ ctx }) => {
    const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
    await enforceRateLimit(
      ctx.db,
      `repository-monitor-reconcile:${workspace.id}:${ctx.auth.userId}`,
      30,
      10 * 60_000,
    );
    return reconcileRepositoryBranchMonitors(ctx.db, {
      workspaceId: workspace.id,
      staleBefore: new Date(Date.now() - REPOSITORY_RECONCILE_INTERVAL_MS),
      limit: 100,
    });
  }),

  remove: protectedProcedure
    .input(monitorIdSchema)
    .mutation(async ({ ctx, input }) => {
      const scope = await monitorScope(
        ctx.db,
        ctx.auth.userId,
        input.monitorId,
      );
      await ctx.db
        .delete(pullRequests)
        .where(eq(pullRequests.id, scope.monitor.pullRequestId));
      return { removed: true };
    }),

  rules: protectedProcedure
    .input(monitorIdSchema)
    .query(async ({ ctx, input }) => {
      await monitorScope(ctx.db, ctx.auth.userId, input.monitorId);
      return ctx.db.query.repositoryReviewRules.findMany({
        where: and(
          eq(repositoryReviewRules.monitorId, input.monitorId),
          isNull(repositoryReviewRules.archivedAt),
        ),
        orderBy: [desc(repositoryReviewRules.updatedAt)],
      });
    }),

  addRule: protectedProcedure
    .input(z.object({ monitorId: z.uuid(), ...ruleFields }))
    .mutation(async ({ ctx, input }) => {
      const scope = await monitorScope(
        ctx.db,
        ctx.auth.userId,
        input.monitorId,
      );
      const [rule] = await ctx.db
        .insert(repositoryReviewRules)
        .values({
          workspaceId: scope.workspace.id,
          monitorId: input.monitorId,
          title: input.title,
          instruction: input.instruction,
          pathGlob: input.pathGlob,
          scope: input.scope,
          severity: input.severity,
          createdBy: ctx.auth.userId,
        })
        .returning();
      if (!rule) throw new Error("Could not create repository rule");
      return rule;
    }),

  updateRule: protectedProcedure
    .input(
      z
        .object({
          monitorId: z.uuid(),
          ruleId: z.uuid(),
          enabled: z.boolean().optional(),
          title: ruleFields.title.optional(),
          instruction: ruleFields.instruction.optional(),
          pathGlob: ruleFields.pathGlob.optional(),
          scope: ruleFields.scope.optional(),
          severity: ruleFields.severity.optional(),
        })
        .refine(
          ({ monitorId: _monitorId, ruleId: _ruleId, ...updates }) =>
            Object.values(updates).some((value) => value !== undefined),
          "Supply at least one rule change",
        ),
    )
    .mutation(async ({ ctx, input }) => {
      await monitorScope(ctx.db, ctx.auth.userId, input.monitorId);
      const [updated] = await ctx.db
        .update(repositoryReviewRules)
        .set({
          title: input.title,
          instruction: input.instruction,
          pathGlob: input.pathGlob,
          scope: input.scope,
          severity: input.severity,
          enabled: input.enabled,
          version: sql`${repositoryReviewRules.version} + 1`,
        })
        .where(
          and(
            eq(repositoryReviewRules.id, input.ruleId),
            eq(repositoryReviewRules.monitorId, input.monitorId),
            isNull(repositoryReviewRules.archivedAt),
          ),
        )
        .returning();
      if (!updated) throw new TRPCError({ code: "NOT_FOUND" });
      return updated;
    }),

  archiveRule: protectedProcedure
    .input(z.object({ monitorId: z.uuid(), ruleId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await monitorScope(ctx.db, ctx.auth.userId, input.monitorId);
      const [archived] = await ctx.db
        .update(repositoryReviewRules)
        .set({ archivedAt: new Date(), enabled: false })
        .where(
          and(
            eq(repositoryReviewRules.id, input.ruleId),
            eq(repositoryReviewRules.monitorId, input.monitorId),
            isNull(repositoryReviewRules.archivedAt),
          ),
        )
        .returning({ id: repositoryReviewRules.id });
      if (!archived) throw new TRPCError({ code: "NOT_FOUND" });
      return archived;
    }),

  startRun: protectedProcedure
    .input(
      z.object({
        monitorId: z.uuid(),
        purpose: z.enum(["code", "compliance"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await monitorScope(
        ctx.db,
        ctx.auth.userId,
        input.monitorId,
      );
      await enforceRateLimit(
        ctx.db,
        `repository-review-start:${scope.workspace.id}:${ctx.auth.userId}`,
        10,
        10 * 60_000,
      );
      const snapshot = await ctx.db.query.reviewSnapshots.findFirst({
        where: eq(reviewSnapshots.pullRequestId, scope.monitor.pullRequestId),
        orderBy: [desc(reviewSnapshots.version)],
      });
      if (!snapshot) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Wait for the repository's first synchronization to finish.",
        });
      }
      const rules: RepositoryReviewRuleSnapshot[] =
        input.purpose === "compliance"
          ? await ctx.db.query.repositoryReviewRules
              .findMany({
                columns: {
                  id: true,
                  version: true,
                  title: true,
                  instruction: true,
                  pathGlob: true,
                  scope: true,
                  severity: true,
                },
                where: and(
                  eq(repositoryReviewRules.monitorId, input.monitorId),
                  eq(repositoryReviewRules.enabled, true),
                  isNull(repositoryReviewRules.archivedAt),
                ),
              })
              .then((rows) =>
                rows.map((row) => ({
                  ...row,
                  scope: ruleScopeSchema.parse(row.scope),
                })),
              )
          : [];
      if (input.purpose === "compliance" && rules.length === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Add and enable at least one compliance rule first.",
        });
      }
      try {
        const job = await createAiJob(ctx.db, {
          pullRequestId: scope.monitor.pullRequestId,
          kind: "review",
          userId: ctx.auth.userId,
          subscribed: ctx.auth.has({ feature: PAID_AI_FEATURE }),
          reviewScope: "repository_snapshot",
          reviewPurpose: input.purpose,
          ruleConfigDigest:
            input.purpose === "compliance"
              ? repositoryRuleDigest(rules)
              : undefined,
          reviewRules: input.purpose === "compliance" ? rules : undefined,
        });
        const run = await scheduleAiJob(ctx.db, job.id);
        return { job, run };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "";
        const safe = new Set([
          "Deep review requires a paid plan",
          "Accept the Big Pickle data disclosure before using AI",
          "Monthly AI token limit reached",
          "Workspace monthly AI budget is exhausted",
          "Configure a local AI provider before using AI",
          "Too many requests. Wait a moment and try again.",
        ]);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: safe.has(message)
            ? message
            : "Could not start the repository review. Try again.",
          cause,
        });
      }
    }),

  history: protectedProcedure
    .input(monitorIdSchema)
    .query(async ({ ctx, input }) => {
      const scope = await monitorScope(
        ctx.db,
        ctx.auth.userId,
        input.monitorId,
      );
      return ctx.db.query.aiJobs.findMany({
        columns: {
          id: true,
          status: true,
          progress: true,
          reviewPurpose: true,
          ruleConfigDigest: true,
          createdAt: true,
          completedAt: true,
          error: true,
        },
        where: and(
          eq(aiJobs.pullRequestId, scope.monitor.pullRequestId),
          eq(aiJobs.userId, ctx.auth.userId),
          eq(aiJobs.kind, "review"),
          eq(aiJobs.reviewScope, "repository_snapshot"),
          isNull(aiJobs.parentJobId),
        ),
        orderBy: [desc(aiJobs.createdAt)],
        limit: 30,
      });
    }),

  findings: protectedProcedure
    .input(z.object({ monitorId: z.uuid(), jobId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const scope = await monitorScope(
        ctx.db,
        ctx.auth.userId,
        input.monitorId,
      );
      const job = await ctx.db.query.aiJobs.findFirst({
        where: and(
          eq(aiJobs.id, input.jobId),
          eq(aiJobs.pullRequestId, scope.monitor.pullRequestId),
          eq(aiJobs.userId, ctx.auth.userId),
          eq(aiJobs.kind, "review"),
          eq(aiJobs.reviewScope, "repository_snapshot"),
          isNull(aiJobs.parentJobId),
        ),
      });
      if (!job) throw new TRPCError({ code: "NOT_FOUND" });
      return deepReviewRunPayload(ctx.db, job);
    }),
});
