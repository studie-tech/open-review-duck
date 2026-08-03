import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  aiJobs,
  aiPreferences,
  localAiConfigurations,
  reviewSnapshots,
  workflowRuns,
  workspaceMembers,
} from "@/drizzle/schema";
import { env } from "~/env";
import {
  readLocalAiSecret,
  resolveLocalAiCredentials,
} from "~/server/ai/local-configuration";
import { withAiQuestionConversationIds } from "~/server/ai/question-threads";
import {
  CURRENT_AI_AGENT_VERSION,
  createAiJob,
  scheduleAiJob,
  settleAiJobQuota,
} from "~/server/ai/service";
import { isLocalDeployment } from "~/server/deployment";
import { enforceRateLimit } from "~/server/security/rate-limit";
import {
  assertSafeRemoteUrl,
  safeRemoteFetch,
} from "~/server/security/remote-url";
import { sealVaultSecret } from "~/server/security/vault";
import { cancelWorkflowRun } from "~/server/workflows/service";
import {
  ensurePersonalWorkspace,
  requireWorkspaceAdministrator,
} from "~/server/workspaces/service";
import {
  aiJobLookupSchema,
  deleteAiQuestionThreadSchema,
  saveAiConfigurationSchema,
  startAiJobSchema,
  testAiConfigurationSchema,
} from "~/validators/ai";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const terminalStatuses = ["completed", "failed", "cancelled"] as const;

const providerModelsSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});

/** Returns the immutable intersection exposed by deployment configuration. */
function allowedManagedModels() {
  return new Set([
    "big-pickle",
    ...(env.OPENROUTER_MODEL_ALLOWLIST ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ]);
}

/** Projects a stored preference without returning any encrypted credentials. */
function publicConfiguration(
  preference: typeof aiPreferences.$inferSelect | undefined,
) {
  return {
    provider:
      preference?.selectedModel === "big-pickle" ? "opencode" : "openrouter",
    model: preference?.selectedModel ?? "big-pickle",
    baseUrl: null,
    useManagedModels: true,
    hasApiKey: false,
    hasHeaders: false,
  };
}

const safeAiStartMessages = new Set([
  "Pull request not found",
  "Accept the Big Pickle data disclosure before using AI",
  "Free AI is available only for provider-verified public repositories",
  "The selected paid model is not in the deployment allowlist",
  "No review snapshot found",
  "No review context found",
  "Daily managed AI request limit reached",
  "Daily user AI request limit reached",
  "Weekly managed AI token limit reached",
  "Workspace monthly AI budget is exhausted",
  "The selected paid model is missing a current tool-capable catalog entry",
  "Configure a local AI provider before using AI",
  "Too many requests. Wait a moment and try again.",
]);

/** Converts expected policy failures into safe user-facing messages. */
function aiStartErrorMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message : "";
  if (safeAiStartMessages.has(message)) return message;
  console.error("AI job creation failed", cause);
  return "Could not start the AI assistant. Try again.";
}

export const aiRouter = createTRPCRouter({
  configuration: protectedProcedure.query(async ({ ctx }) => {
    const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
    const preference = await ctx.db.query.aiPreferences.findFirst({
      where: eq(aiPreferences.workspaceId, workspace.id),
    });
    const localConfiguration = isLocalDeployment()
      ? await ctx.db.query.localAiConfigurations.findFirst({
          where: eq(localAiConfigurations.workspaceId, workspace.id),
        })
      : undefined;
    const localSecret = localConfiguration
      ? await readLocalAiSecret(workspace.id, localConfiguration)
      : undefined;
    return {
      mode: preference?.mode ?? workspace.aiMode,
      reviewPullRequests:
        preference?.reviewPullRequests ?? workspace.aiReviewEnabled,
      managedModel: preference?.selectedModel ?? "big-pickle",
      managedModels: ctx.auth.has({ feature: "paid_ai_models" })
        ? [...allowedManagedModels()]
        : ["big-pickle"],
      disclosure: {
        accepted: Boolean(preference?.freeProviderDisclosureAcceptedAt),
        version: env.BIG_PICKLE_DISCLOSURE_VERSION,
      },
      configuration: isLocalDeployment()
        ? localConfiguration && localSecret
          ? {
              provider: localConfiguration.provider,
              model: localConfiguration.model,
              baseUrl: localSecret.baseUrl,
              useManagedModels: false,
              hasApiKey: Boolean(localSecret.apiKey),
              hasHeaders: Object.keys(localSecret.headers).length > 0,
            }
          : null
        : publicConfiguration(preference),
    };
  }),

  testConfiguration: protectedProcedure
    .input(testAiConfigurationSchema)
    .mutation(async ({ ctx, input }) => {
      if (!isLocalDeployment()) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Bring-your-own-provider configuration is local-only",
        });
      }
      if (!input.baseUrl) {
        return {
          ok: false as const,
          error: "A local provider URL is required",
        };
      }
      try {
        const workspace = await ensurePersonalWorkspace(
          ctx.db,
          ctx.auth.userId,
        );
        await requireWorkspaceAdministrator(
          ctx.db,
          workspace.id,
          ctx.auth.userId,
        );
        const existing = await ctx.db.query.localAiConfigurations.findFirst({
          where: eq(localAiConfigurations.workspaceId, workspace.id),
        });
        const previousSecret =
          existing?.provider === input.provider
            ? await readLocalAiSecret(workspace.id, existing)
            : undefined;
        const { apiKey, headers } = resolveLocalAiCredentials(
          {
            apiKey: input.apiKey,
            baseUrl: input.baseUrl,
            clearApiKey: input.clearApiKey,
            clearHeaders: input.clearHeaders,
            headers: input.headers,
          },
          previousSecret,
        );
        if (input.provider === "opencode" && !apiKey) {
          return {
            ok: false as const,
            error: "OpenCode Zen requires your own API key",
          };
        }
        await assertSafeRemoteUrl(input.baseUrl, env.ALLOW_PRIVATE_AI_HOSTS);
        const startedAt = performance.now();
        const response = await safeRemoteFetch(
          new URL(
            "models",
            input.baseUrl.endsWith("/") ? input.baseUrl : `${input.baseUrl}/`,
          ).toString(),
          {
            headers: apiKey
              ? { ...headers, authorization: `Bearer ${apiKey}` }
              : headers,
            signal: AbortSignal.timeout(10_000),
          },
          env.ALLOW_PRIVATE_AI_HOSTS,
        );
        if (!response.ok) {
          return {
            ok: false as const,
            error: `Provider returned HTTP ${response.status}`,
          };
        }
        const availableModels = providerModelsSchema.parse(
          await response.json(),
        ).data;
        if (!availableModels.some(({ id }) => id === input.model)) {
          return {
            ok: false as const,
            error: `Provider does not list model ${input.model}`,
          };
        }
        return {
          ok: true as const,
          model: input.model,
          latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
        };
      } catch (cause) {
        return {
          ok: false as const,
          error:
            cause instanceof Error ? cause.message : "Provider test failed",
        };
      }
    }),

  saveConfiguration: protectedProcedure
    .input(saveAiConfigurationSchema)
    .mutation(async ({ ctx, input }) => {
      const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
      await requireWorkspaceAdministrator(
        ctx.db,
        workspace.id,
        ctx.auth.userId,
      );
      const local = isLocalDeployment();
      const paid = !local && ctx.auth.has({ feature: "paid_ai_models" });
      const selectedModel = input.useManagedModels
        ? paid
          ? input.model
          : "big-pickle"
        : input.model;
      if (!local && !input.useManagedModels) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "SaaS uses service-owned managed models only",
        });
      }
      if (local && input.useManagedModels) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Local AI requires your own model or provider credential",
        });
      }
      if (!local && !allowedManagedModels().has(selectedModel)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The selected model is not in the deployment allowlist",
        });
      }
      if (local && !input.useManagedModels) {
        if (!input.baseUrl) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "A local provider URL is required",
          });
        }
        await assertSafeRemoteUrl(input.baseUrl, env.ALLOW_PRIVATE_AI_HOSTS);
        const existing = await ctx.db.query.localAiConfigurations.findFirst({
          where: eq(localAiConfigurations.workspaceId, workspace.id),
        });
        const id = existing?.id ?? randomUUID();
        const previousSecret =
          existing?.provider === input.provider
            ? await readLocalAiSecret(workspace.id, existing)
            : undefined;
        const credentials = resolveLocalAiCredentials(
          {
            apiKey: input.apiKey,
            baseUrl: input.baseUrl,
            clearApiKey: input.clearApiKey,
            clearHeaders: input.clearHeaders,
            headers: input.headers,
          },
          previousSecret,
        );
        if (input.provider === "opencode" && !credentials.apiKey) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "OpenCode Zen requires your own API key",
          });
        }
        const encryptedConfiguration = await sealVaultSecret(
          {
            workspaceId: workspace.id,
            recordId: id,
            provider: input.provider,
          },
          JSON.stringify({
            apiKey: credentials.apiKey,
            baseUrl: input.baseUrl,
            headers: credentials.headers,
          }),
        );
        await ctx.db
          .insert(localAiConfigurations)
          .values({
            id,
            workspaceId: workspace.id,
            provider: input.provider,
            model: input.model,
            encryptedConfiguration,
          })
          .onConflictDoUpdate({
            target: localAiConfigurations.workspaceId,
            set: {
              provider: input.provider,
              model: input.model,
              encryptedConfiguration,
            },
          });
      }
      await ctx.db
        .insert(aiPreferences)
        .values({
          workspaceId: workspace.id,
          selectedModel,
          mode: input.mode,
          reviewPullRequests: input.reviewPullRequests,
        })
        .onConflictDoUpdate({
          target: aiPreferences.workspaceId,
          set: {
            selectedModel,
            mode: input.mode,
            reviewPullRequests: input.reviewPullRequests,
          },
        });
      return { ok: true as const };
    }),

  acceptBigPickleDisclosure: protectedProcedure.mutation(async ({ ctx }) => {
    const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
    await ctx.db
      .insert(aiPreferences)
      .values({
        workspaceId: workspace.id,
        freeProviderDisclosureVersion: env.BIG_PICKLE_DISCLOSURE_VERSION,
        freeProviderDisclosureAcceptedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: aiPreferences.workspaceId,
        set: {
          freeProviderDisclosureVersion: env.BIG_PICKLE_DISCLOSURE_VERSION,
          freeProviderDisclosureAcceptedAt: new Date(),
        },
      });
    return { accepted: true };
  }),

  revokeBigPickleDisclosure: protectedProcedure.mutation(async ({ ctx }) => {
    const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
    const activeJobs = await ctx.db.query.aiJobs.findMany({
      columns: { id: true, workflowRunId: true },
      where: and(
        eq(aiJobs.workspaceId, workspace.id),
        eq(aiJobs.provider, "opencode"),
        inArray(aiJobs.status, [
          "queued",
          "running",
          "waiting_for_provider",
          "streaming",
        ]),
      ),
    });
    await ctx.db
      .update(aiPreferences)
      .set({
        freeProviderDisclosureAcceptedAt: null,
        freeProviderDisclosureVersion: null,
      })
      .where(eq(aiPreferences.workspaceId, workspace.id));
    await ctx.db
      .update(aiJobs)
      .set({
        status: "cancelled",
        completionReason: "cancelled",
        cancelledAt: new Date(),
        completedAt: new Date(),
      })
      .where(
        and(
          eq(aiJobs.workspaceId, workspace.id),
          eq(aiJobs.provider, "opencode"),
          inArray(aiJobs.status, [
            "queued",
            "running",
            "waiting_for_provider",
            "streaming",
          ]),
        ),
      );
    for (const job of activeJobs) {
      if (job.workflowRunId) {
        const workflow = await ctx.db.query.workflowRuns.findFirst({
          where: eq(workflowRuns.id, job.workflowRunId),
        });
        if (workflow) {
          await cancelWorkflowRun(ctx.db, workflow.providerRunId);
        }
      }
      await settleAiJobQuota(ctx.db, job.id);
    }
    return { accepted: false };
  }),

  start: protectedProcedure
    .input(startAiJobSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        await enforceRateLimit(
          ctx.db,
          `ai-start:${ctx.auth.userId}`,
          20,
          60_000,
        );
        const job = await createAiJob(ctx.db, {
          ...input,
          userId: ctx.auth.userId,
          hasManagedAi: ctx.auth.has({ feature: "paid_ai_models" }),
        });
        const run = await scheduleAiJob(ctx.db, job.id);
        return { ...job, workflowRunId: run.workflowRunId };
      } catch (cause) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: aiStartErrorMessage(cause),
          cause,
        });
      }
    }),

  status: protectedProcedure
    .input(aiJobLookupSchema)
    .query(async ({ ctx, input }) => {
      const job = await ctx.db.query.aiJobs.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.pullRequestId, input.pullRequestId),
            eq(table.userId, ctx.auth.userId),
            eq(table.agentVersion, CURRENT_AI_AGENT_VERSION),
            input.unitId ? eq(table.unitId, input.unitId) : undefined,
            isNull(table.question),
          ),
        orderBy: (table, { desc }) => [desc(table.createdAt)],
      });
      return job ?? null;
    }),

  questions: protectedProcedure
    .input(aiJobLookupSchema.required({ unitId: true }))
    .query(async ({ ctx, input }) => {
      const jobs = await ctx.db.query.aiJobs.findMany({
        columns: {
          id: true,
          question: true,
          focusLine: true,
          threadId: true,
          status: true,
          result: true,
          error: true,
          createdAt: true,
        },
        where: (table, { and, eq }) =>
          and(
            eq(table.pullRequestId, input.pullRequestId),
            eq(table.unitId, input.unitId),
            eq(table.userId, ctx.auth.userId),
            eq(table.kind, "explain"),
            isNotNull(table.question),
            ne(table.question, ""),
          ),
        orderBy: (table, { desc }) => [desc(table.createdAt), desc(table.id)],
        limit: 50,
      });
      return withAiQuestionConversationIds(jobs);
    }),

  deleteQuestionThread: protectedProcedure
    .input(deleteAiQuestionThreadSchema)
    .mutation(async ({ ctx, input }) => {
      const scope = and(
        eq(aiJobs.pullRequestId, input.pullRequestId),
        eq(aiJobs.unitId, input.unitId),
        eq(aiJobs.userId, ctx.auth.userId),
        eq(aiJobs.kind, "explain"),
        inArray(aiJobs.id, input.jobIds),
        isNotNull(aiJobs.question),
      );
      const selected = await ctx.db.query.aiJobs.findMany({
        columns: { id: true, status: true },
        where: scope,
      });
      if (selected.length !== input.jobIds.length) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "AI conversation not found",
        });
      }
      if (
        selected.some(
          ({ status }) =>
            !terminalStatuses.includes(
              status as (typeof terminalStatuses)[number],
            ),
        )
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Cancel the active AI answer before deleting it",
        });
      }
      const deleted = await ctx.db
        .delete(aiJobs)
        .where(scope)
        .returning({ id: aiJobs.id });
      return { deleted: deleted.length };
    }),

  cancel: protectedProcedure
    .input(z.object({ jobId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const job = await ctx.db.query.aiJobs.findFirst({
        where: and(
          eq(aiJobs.id, input.jobId),
          eq(aiJobs.userId, ctx.auth.userId),
        ),
      });
      if (!job) throw new TRPCError({ code: "NOT_FOUND" });
      if (job.workflowRunId) {
        const workflow = await ctx.db.query.workflowRuns.findFirst({
          where: eq(workflowRuns.id, job.workflowRunId),
        });
        if (workflow) await cancelWorkflowRun(ctx.db, workflow.providerRunId);
      }
      await ctx.db
        .update(aiJobs)
        .set({
          status: "cancelled",
          completionReason: "cancelled",
          cancelledAt: new Date(),
          completedAt: new Date(),
        })
        .where(eq(aiJobs.id, job.id));
      await settleAiJobQuota(ctx.db, job.id);
      return { status: "cancelled" as const };
    }),

  usage: protectedProcedure
    .input(aiJobLookupSchema.pick({ pullRequestId: true }))
    .query(async ({ ctx, input }) => {
      const [usage] = await ctx.db
        .select({
          runs: sql<number>`count(${aiJobs.id})`,
          inputTokens: sql<number>`coalesce(sum(${aiJobs.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${aiJobs.outputTokens}), 0)`,
          cacheReadTokens: sql<number>`coalesce(sum(${aiJobs.cacheReadTokens}), 0)`,
          cacheWriteTokens: sql<number>`coalesce(sum(${aiJobs.cacheWriteTokens}), 0)`,
          totalTokens: sql<number>`coalesce(sum(${aiJobs.totalTokens}), 0)`,
        })
        .from(aiJobs)
        .innerJoin(
          workspaceMembers,
          and(
            eq(aiJobs.workspaceId, workspaceMembers.workspaceId),
            eq(workspaceMembers.userId, ctx.auth.userId),
          ),
        )
        .where(eq(aiJobs.pullRequestId, input.pullRequestId));
      return {
        runs: Number(usage?.runs ?? 0),
        inputTokens: Number(usage?.inputTokens ?? 0),
        outputTokens: Number(usage?.outputTokens ?? 0),
        cacheReadTokens: Number(usage?.cacheReadTokens ?? 0),
        cacheWriteTokens: Number(usage?.cacheWriteTokens ?? 0),
        totalTokens: Number(usage?.totalTokens ?? 0),
      };
    }),

  reviewStatus: protectedProcedure
    .input(aiJobLookupSchema.pick({ pullRequestId: true }))
    .query(async ({ ctx, input }) => {
      const snapshot = await ctx.db.query.reviewSnapshots.findFirst({
        where: eq(reviewSnapshots.pullRequestId, input.pullRequestId),
        orderBy: (table, { desc }) => [desc(table.version)],
      });
      if (!snapshot) return null;
      return (
        (await ctx.db.query.aiJobs.findFirst({
          where: and(
            eq(aiJobs.pullRequestId, input.pullRequestId),
            eq(aiJobs.snapshotId, snapshot.id),
            eq(aiJobs.userId, ctx.auth.userId),
            eq(aiJobs.agentVersion, CURRENT_AI_AGENT_VERSION),
            eq(aiJobs.kind, "review"),
            isNull(aiJobs.unitId),
          ),
          orderBy: (table, { desc }) => [desc(table.createdAt)],
        })) ?? null
      );
    }),
});
