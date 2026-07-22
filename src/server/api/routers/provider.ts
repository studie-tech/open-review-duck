import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { providerConnections, repositories } from "@/drizzle/schema";
import { env } from "~/env";
import { createProvider } from "~/server/providers";
import { providerConnectionErrorMessage } from "~/server/providers/connection-error";
import { exportRepositoryReviewData } from "~/server/providers/export";
import {
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
} from "~/server/security/encryption";
import { enforceRateLimit } from "~/server/security/rate-limit";
import { assertSafeRemoteUrl } from "~/server/security/remote-url";
import { pruneExpiredReviewSnapshots } from "~/server/sync/retention";
import {
  ensurePersonalWorkspace,
  requireWorkspaceAdministrator,
} from "~/server/workspaces/service";
import {
  connectionIdSchema,
  connectProviderSchema,
  importRepositorySchema,
  repositoryIdSchema,
  repositoryRetentionSchema,
} from "~/validators/provider";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const providerRouter = createTRPCRouter({
  listConnections: protectedProcedure.query(async ({ ctx }) => {
    const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
    return ctx.db
      .select({
        id: providerConnections.id,
        provider: providerConnections.provider,
        displayName: providerConnections.displayName,
        baseUrl: providerConnections.baseUrl,
        createdAt: providerConnections.createdAt,
      })
      .from(providerConnections)
      .where(eq(providerConnections.workspaceId, workspace.id));
  }),

  connect: protectedProcedure
    .input(connectProviderSchema)
    .mutation(async ({ ctx, input }) => {
      const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
      await requireWorkspaceAdministrator(
        ctx.db,
        workspace.id,
        ctx.auth.userId,
      );
      await enforceRateLimit(
        ctx.db,
        `provider-connect:${workspace.id}:${ctx.auth.userId}`,
        10,
        10 * 60_000,
      );
      if (input.baseUrl) {
        try {
          await assertSafeRemoteUrl(
            input.baseUrl,
            env.ALLOW_PRIVATE_PROVIDER_HOSTS,
          );
        } catch (cause) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              cause instanceof Error
                ? cause.message
                : "The provider URL is not allowed",
            cause,
          });
        }
      }
      const provider = createProvider(
        input.provider,
        input.accessToken,
        input.baseUrl,
      );
      let identity: Awaited<ReturnType<typeof provider.getConnectionIdentity>>;
      try {
        identity = await provider.getConnectionIdentity();
      } catch (cause) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: providerConnectionErrorMessage(input.provider, cause),
          cause,
        });
      }
      const credentialFingerprint = fingerprintSecret(
        input.accessToken,
        env.ENCRYPTION_KEY,
      );
      const displayName = input.displayName ?? identity.displayName;
      const encryptedAccessToken = encryptSecret(
        input.accessToken,
        env.ENCRYPTION_KEY,
      );
      const existingAccountConnections = await ctx.db
        .select({
          id: providerConnections.id,
          encryptedAccessToken: providerConnections.encryptedAccessToken,
        })
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.workspaceId, workspace.id),
            eq(providerConnections.provider, input.provider),
            eq(
              providerConnections.externalAccountId,
              identity.externalAccountId,
            ),
          ),
        );
      const existingConnection = existingAccountConnections.find(
        (candidate) => {
          try {
            return (
              fingerprintSecret(
                decryptSecret(
                  candidate.encryptedAccessToken,
                  env.ENCRYPTION_KEY,
                ),
                env.ENCRYPTION_KEY,
              ) === credentialFingerprint
            );
          } catch {
            return false;
          }
        },
      );
      const returning = {
        id: providerConnections.id,
        provider: providerConnections.provider,
        displayName: providerConnections.displayName,
      };
      const [connection] = existingConnection
        ? await ctx.db
            .update(providerConnections)
            .set({
              externalAccountId: identity.externalAccountId,
              credentialFingerprint,
              displayName,
              encryptedAccessToken,
              baseUrl: input.baseUrl,
            })
            .where(eq(providerConnections.id, existingConnection.id))
            .returning(returning)
        : await ctx.db
            .insert(providerConnections)
            .values({
              workspaceId: workspace.id,
              provider: input.provider,
              externalAccountId: identity.externalAccountId,
              credentialFingerprint,
              displayName,
              encryptedAccessToken,
              baseUrl: input.baseUrl,
            })
            .onConflictDoUpdate({
              target: [
                providerConnections.workspaceId,
                providerConnections.provider,
                providerConnections.credentialFingerprint,
              ],
              set: {
                externalAccountId: identity.externalAccountId,
                displayName,
                encryptedAccessToken,
                baseUrl: input.baseUrl,
              },
            })
            .returning(returning);
      return connection;
    }),

  disconnect: protectedProcedure
    .input(connectionIdSchema)
    .mutation(async ({ ctx, input }) => {
      const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
      await requireWorkspaceAdministrator(
        ctx.db,
        workspace.id,
        ctx.auth.userId,
      );
      const [removed] = await ctx.db
        .delete(providerConnections)
        .where(
          and(
            eq(providerConnections.id, input.connectionId),
            eq(providerConnections.workspaceId, workspace.id),
          ),
        )
        .returning({ id: providerConnections.id });
      if (!removed) throw new TRPCError({ code: "NOT_FOUND" });
      return removed;
    }),

  listAvailableRepositories: protectedProcedure
    .input(importRepositorySchema.pick({ connectionId: true }))
    .query(async ({ ctx, input }) => {
      const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
      await enforceRateLimit(
        ctx.db,
        `provider-repositories:${workspace.id}:${ctx.auth.userId}`,
        30,
        60_000,
      );
      const connection = await ctx.db.query.providerConnections.findFirst({
        where: and(
          eq(providerConnections.id, input.connectionId),
          eq(providerConnections.workspaceId, workspace.id),
        ),
      });
      if (!connection) throw new TRPCError({ code: "NOT_FOUND" });
      return createProvider(
        connection.provider,
        decryptSecret(connection.encryptedAccessToken, env.ENCRYPTION_KEY),
        connection.baseUrl ?? undefined,
      ).listRepositories();
    }),

  importRepository: protectedProcedure
    .input(importRepositorySchema)
    .mutation(async ({ ctx, input }) => {
      const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
      await requireWorkspaceAdministrator(
        ctx.db,
        workspace.id,
        ctx.auth.userId,
      );
      const connection = await ctx.db.query.providerConnections.findFirst({
        where: and(
          eq(providerConnections.id, input.connectionId),
          eq(providerConnections.workspaceId, workspace.id),
        ),
      });
      if (!connection) throw new TRPCError({ code: "NOT_FOUND" });
      const remote = (
        await createProvider(
          connection.provider,
          decryptSecret(connection.encryptedAccessToken, env.ENCRYPTION_KEY),
          connection.baseUrl ?? undefined,
        ).listRepositories()
      ).find((repository) => repository.externalId === input.externalId);
      if (!remote) throw new TRPCError({ code: "NOT_FOUND" });
      const [repository] = await ctx.db
        .insert(repositories)
        .values({
          connectionId: connection.id,
          sourceRetentionDays: env.SOURCE_RETENTION_DAYS,
          sourceRetentionSnapshots: env.SOURCE_RETENTION_SNAPSHOTS,
          ...remote,
        })
        .onConflictDoUpdate({
          target: [repositories.connectionId, repositories.externalId],
          set: {
            owner: remote.owner,
            name: remote.name,
            defaultBranch: remote.defaultBranch,
            webUrl: remote.webUrl,
            isPrivate: remote.isPrivate,
          },
        })
        .returning();
      return repository;
    }),

  listImportedRepositories: protectedProcedure.query(async ({ ctx }) => {
    const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
    return ctx.db
      .select({
        id: repositories.id,
        externalId: repositories.externalId,
        owner: repositories.owner,
        name: repositories.name,
        provider: providerConnections.provider,
        connectionId: providerConnections.id,
      })
      .from(repositories)
      .innerJoin(
        providerConnections,
        eq(repositories.connectionId, providerConnections.id),
      )
      .where(eq(providerConnections.workspaceId, workspace.id));
  }),

  listOpenPullRequests: protectedProcedure
    .input(repositoryIdSchema)
    .query(async ({ ctx, input }) => {
      const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
      await enforceRateLimit(
        ctx.db,
        `provider-pulls:${workspace.id}:${ctx.auth.userId}`,
        60,
        60_000,
      );
      const [repository] = await ctx.db
        .select({
          externalId: repositories.externalId,
          provider: providerConnections.provider,
          encryptedAccessToken: providerConnections.encryptedAccessToken,
          baseUrl: providerConnections.baseUrl,
        })
        .from(repositories)
        .innerJoin(
          providerConnections,
          eq(repositories.connectionId, providerConnections.id),
        )
        .where(
          and(
            eq(repositories.id, input.repositoryId),
            eq(providerConnections.workspaceId, workspace.id),
          ),
        )
        .limit(1);
      if (!repository) throw new TRPCError({ code: "NOT_FOUND" });
      return createProvider(
        repository.provider,
        decryptSecret(repository.encryptedAccessToken, env.ENCRYPTION_KEY),
        repository.baseUrl ?? undefined,
      ).listOpenPullRequests(repository.externalId);
    }),

  exportRepositoryData: protectedProcedure
    .input(repositoryIdSchema)
    .query(async ({ ctx, input }) => {
      const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
      await requireWorkspaceAdministrator(
        ctx.db,
        workspace.id,
        ctx.auth.userId,
      );
      const [access] = await ctx.db
        .select({ id: repositories.id })
        .from(repositories)
        .innerJoin(
          providerConnections,
          eq(repositories.connectionId, providerConnections.id),
        )
        .where(
          and(
            eq(repositories.id, input.repositoryId),
            eq(providerConnections.workspaceId, workspace.id),
          ),
        )
        .limit(1);
      if (!access) throw new TRPCError({ code: "NOT_FOUND" });
      const exported = await exportRepositoryReviewData(
        ctx.db,
        input.repositoryId,
      );
      if (!exported) throw new TRPCError({ code: "NOT_FOUND" });
      return exported;
    }),

  deleteRepositoryData: protectedProcedure
    .input(repositoryIdSchema)
    .mutation(async ({ ctx, input }) => {
      const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
      await requireWorkspaceAdministrator(
        ctx.db,
        workspace.id,
        ctx.auth.userId,
      );
      const [deleted] = await ctx.db
        .delete(repositories)
        .where(
          and(
            eq(repositories.id, input.repositoryId),
            sql`exists (
              select 1 from ${providerConnections}
              where ${providerConnections.id} = ${repositories.connectionId}
                and ${providerConnections.workspaceId} = ${workspace.id}
            )`,
          ),
        )
        .returning({ id: repositories.id });
      if (!deleted) throw new TRPCError({ code: "NOT_FOUND" });
      return { deleted: true as const };
    }),

  updateRepositoryRetention: protectedProcedure
    .input(repositoryRetentionSchema)
    .mutation(async ({ ctx, input }) => {
      const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
      await requireWorkspaceAdministrator(
        ctx.db,
        workspace.id,
        ctx.auth.userId,
      );
      const [updated] = await ctx.db
        .update(repositories)
        .set({
          sourceRetentionDays: input.days,
          sourceRetentionSnapshots: input.snapshots,
        })
        .where(
          and(
            eq(repositories.id, input.repositoryId),
            sql`exists (
              select 1 from ${providerConnections}
              where ${providerConnections.id} = ${repositories.connectionId}
                and ${providerConnections.workspaceId} = ${workspace.id}
            )`,
          ),
        )
        .returning({ id: repositories.id });
      if (!updated) throw new TRPCError({ code: "NOT_FOUND" });
      return {
        updated: true as const,
        prunedSnapshots: await pruneExpiredReviewSnapshots(
          ctx.db,
          input.repositoryId,
        ),
      };
    }),
});
