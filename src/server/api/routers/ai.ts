import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  aiConfigurations,
  aiJobs,
  reviewSnapshots,
  workspaceMembers,
  workspaces,
} from "@/drizzle/schema";
import { env } from "~/env";
import {
  createAiConfigurationVerification,
  type VerifiedAiConfiguration,
  verifyAiConfiguration,
} from "~/server/ai/configuration-verification";
import {
  aiConnectionErrorMessage,
  testAiProviderConnection,
} from "~/server/ai/connection-test";
import {
  CURRENT_AI_AGENT_VERSION,
  createAiExplanationJobs,
  createAiJob,
  scheduleAiJob,
} from "~/server/ai/service";
import { decryptSecret, encryptSecret } from "~/server/security/encryption";
import { enforceRateLimit } from "~/server/security/rate-limit";
import {
  assertSafeRemoteUrl,
  withSafeRemoteFetch,
} from "~/server/security/remote-url";
import {
  ensurePersonalWorkspace,
  requireWorkspaceAdministrator,
} from "~/server/workspaces/service";
import {
  aiJobLookupSchema,
  saveAiConfigurationSchema,
  startAiJobSchema,
  startPendingExplanationsSchema,
  testAiConfigurationSchema,
} from "~/validators/ai";
import { createTRPCRouter, protectedProcedure } from "../trpc";

type AiConfiguration = typeof aiConfigurations.$inferSelect;
type ByokInput = typeof testAiConfigurationSchema._output;

/** Resolves and decrypts a user's active BYOK model configuration. */
function resolveByokConfiguration(
  input: ByokInput,
  existing: AiConfiguration | undefined,
): VerifiedAiConfiguration {
  const canReuse = existing?.provider === input.provider;
  const apiKey =
    input.apiKey ??
    (canReuse && existing.encryptedApiKey
      ? decryptSecret(existing.encryptedApiKey, env.ENCRYPTION_KEY)
      : undefined);
  const headers =
    Object.keys(input.headers).length > 0
      ? input.headers
      : canReuse && existing.encryptedHeaders
        ? (JSON.parse(
            decryptSecret(existing.encryptedHeaders, env.ENCRYPTION_KEY),
          ) as Record<string, string>)
        : {};

  if (!apiKey && Object.keys(headers).length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "An API key or custom authorization header is required for bring-your-own-model mode",
    });
  }

  return {
    provider: input.provider,
    model: input.model,
    apiProtocol: input.apiProtocol,
    apiKey,
    headers,
    baseUrl: input.baseUrl,
    contextWindow: input.contextWindow,
    maxTokens: input.maxTokens,
    storeResponses: input.storeResponses,
  };
}

/** Validates that a model provider URL is allowed by server policy. */
async function assertAllowedProviderUrl(baseUrl: string | undefined) {
  if (!baseUrl) return;
  try {
    await assertSafeRemoteUrl(baseUrl, env.ALLOW_PRIVATE_AI_HOSTS);
  } catch (cause) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        cause instanceof Error
          ? cause.message
          : "The AI provider URL is not allowed",
      cause,
    });
  }
}

const safeAiStartMessages = new Set([
  "Pull request not found",
  "AI assistance is turned off",
  "Configure an AI provider first",
  "The managed AI plan is required",
  "Synchronize the pull request first",
  "No review context found",
  "Some review units are unavailable",
  "Binary review units cannot be explained",
  "Daily managed AI request limit reached",
  "Weekly managed AI token limit reached",
  "Too many requests. Wait a moment and try again.",
]);

/** Returns only intentional, user-actionable AI startup failures. */
function aiStartErrorMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message : "";
  if (safeAiStartMessages.has(message)) return message;
  console.error("AI job creation failed", cause);
  return "Could not start the AI assistant. Try again.";
}

export const aiRouter = createTRPCRouter({
  configuration: protectedProcedure.query(async ({ ctx }) => {
    const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
    const configuration = await ctx.db.query.aiConfigurations.findFirst({
      where: eq(aiConfigurations.workspaceId, workspace.id),
    });
    return {
      mode: workspace.aiMode,
      reviewPullRequests: workspace.aiReviewEnabled,
      managedModel: env.MANAGED_AI_MODEL,
      configuration: configuration
        ? {
            provider: configuration.provider,
            model: configuration.model,
            apiProtocol: configuration.apiProtocol,
            baseUrl: configuration.baseUrl,
            contextWindow: configuration.contextWindow,
            maxTokens: configuration.maxTokens,
            storeResponses: configuration.storeResponses,
            useManagedModels: configuration.useManagedModels,
            hasApiKey: Boolean(configuration.encryptedApiKey),
            hasHeaders: Boolean(configuration.encryptedHeaders),
          }
        : null,
    };
  }),

  testConfiguration: protectedProcedure
    .input(testAiConfigurationSchema)
    .mutation(async ({ ctx, input }) => {
      const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
      await requireWorkspaceAdministrator(
        ctx.db,
        workspace.id,
        ctx.auth.userId,
      );
      await enforceRateLimit(
        ctx.db,
        `ai-test:${workspace.id}:${ctx.auth.userId}`,
        10,
        10 * 60_000,
      );
      let secrets = [input.apiKey, ...Object.values(input.headers)];
      try {
        await assertAllowedProviderUrl(input.baseUrl);
        const existing = await ctx.db.query.aiConfigurations.findFirst({
          where: eq(aiConfigurations.workspaceId, workspace.id),
        });
        const configuration = resolveByokConfiguration(input, existing);
        secrets = [
          configuration.apiKey,
          ...Object.values(configuration.headers),
        ];
        const result = await withSafeRemoteFetch(
          env.ALLOW_PRIVATE_AI_HOSTS,
          () => testAiProviderConnection(configuration),
        );
        return {
          ok: true as const,
          ...result,
          verificationToken: createAiConfigurationVerification(
            configuration,
            { workspaceId: workspace.id, userId: ctx.auth.userId },
            env.ENCRYPTION_KEY,
          ),
        };
      } catch (cause) {
        return {
          ok: false as const,
          error: aiConnectionErrorMessage(cause, secrets),
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
      if (input.useManagedModels && !ctx.auth.has({ feature: "managed_ai" })) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Managed models are not enabled for this workspace",
        });
      }
      if (!input.useManagedModels)
        await assertAllowedProviderUrl(input.baseUrl);
      const existing = await ctx.db.query.aiConfigurations.findFirst({
        where: eq(aiConfigurations.workspaceId, workspace.id),
      });
      const byokConfiguration = input.useManagedModels
        ? undefined
        : resolveByokConfiguration(input as ByokInput, existing);
      if (
        byokConfiguration &&
        (!input.verificationToken ||
          !verifyAiConfiguration(
            input.verificationToken,
            byokConfiguration,
            { workspaceId: workspace.id, userId: ctx.auth.userId },
            env.ENCRYPTION_KEY,
          ))
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Test this exact provider configuration before selecting the model",
        });
      }
      const provider = input.useManagedModels ? "openai" : input.provider;
      const model = input.useManagedModels ? env.MANAGED_AI_MODEL : input.model;
      const encryptedApiKey = input.useManagedModels
        ? null
        : byokConfiguration?.apiKey
          ? encryptSecret(byokConfiguration.apiKey, env.ENCRYPTION_KEY)
          : null;
      const encryptedHeaders = input.useManagedModels
        ? null
        : byokConfiguration && Object.keys(byokConfiguration.headers).length > 0
          ? encryptSecret(
              JSON.stringify(byokConfiguration.headers),
              env.ENCRYPTION_KEY,
            )
          : null;
      await ctx.db
        .update(workspaces)
        .set({
          aiMode: input.mode,
          aiReviewEnabled: input.reviewPullRequests,
        })
        .where(eq(workspaces.id, workspace.id));
      await ctx.db
        .insert(aiConfigurations)
        .values({
          workspaceId: workspace.id,
          provider,
          model,
          apiProtocol: input.apiProtocol,
          encryptedApiKey,
          encryptedHeaders,
          baseUrl: input.baseUrl,
          contextWindow: input.contextWindow,
          maxTokens: input.maxTokens,
          storeResponses: input.storeResponses,
          useManagedModels: input.useManagedModels,
        })
        .onConflictDoUpdate({
          target: aiConfigurations.workspaceId,
          set: {
            provider,
            model,
            apiProtocol: input.apiProtocol,
            encryptedApiKey,
            encryptedHeaders,
            baseUrl: input.baseUrl,
            contextWindow: input.contextWindow,
            maxTokens: input.maxTokens,
            storeResponses: input.storeResponses,
            useManagedModels: input.useManagedModels,
          },
        });
      return { ok: true as const };
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
          hasManagedAi: ctx.auth.has({ feature: "managed_ai" }),
        });
        scheduleAiJob(ctx.db, job.id);
        return job;
      } catch (cause) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: aiStartErrorMessage(cause),
          cause,
        });
      }
    }),

  startPendingExplanations: protectedProcedure
    .input(startPendingExplanationsSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        await enforceRateLimit(
          ctx.db,
          `ai-start-pending:${ctx.auth.userId}`,
          5,
          60_000,
        );
        const result = await createAiExplanationJobs(ctx.db, {
          ...input,
          userId: ctx.auth.userId,
          hasManagedAi: ctx.auth.has({ feature: "managed_ai" }),
        });
        if (result.jobs.length > 0) scheduleAiJob(ctx.db);
        return {
          created: result.created,
          alreadyRunning: result.alreadyRunning,
        };
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
          ),
        orderBy: (table, { desc }) => [desc(table.createdAt)],
      });
      if (job?.status === "queued" || job?.status === "running") {
        scheduleAiJob(ctx.db, job.id);
      }
      return job ?? null;
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
      const job = await ctx.db.query.aiJobs.findFirst({
        where: and(
          eq(aiJobs.pullRequestId, input.pullRequestId),
          eq(aiJobs.snapshotId, snapshot.id),
          eq(aiJobs.userId, ctx.auth.userId),
          eq(aiJobs.agentVersion, CURRENT_AI_AGENT_VERSION),
          eq(aiJobs.kind, "review"),
          isNull(aiJobs.unitId),
        ),
        orderBy: (table, { desc }) => [desc(table.createdAt)],
      });
      if (job?.status === "queued" || job?.status === "running") {
        scheduleAiJob(ctx.db, job.id);
      }
      return job ?? null;
    }),
});
