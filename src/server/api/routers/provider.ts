import { createHash, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  credentialAuditEvents,
  localCredentials,
  oauthCredentials,
  providerConnections,
  providerPatCredentials,
  pullRequests,
  repositories,
  reviewQueueItems,
} from "@/drizzle/schema";
import { env } from "~/env";
import { supportsTokenReplacement } from "~/lib/provider-credential-recovery";
import { isLocalDeployment } from "~/server/deployment";
import { createProvider } from "~/server/providers";
import { providerConnectionErrorMessage } from "~/server/providers/connection-error";
import {
  providerForConnection,
  revokeGitHubInstallation,
  revokeProviderOAuth,
} from "~/server/providers/credentials";
import { exportRepositoryReviewData } from "~/server/providers/export";
import {
  reconcileRepositoryIntake,
  reconcileWorkspaceIntake,
} from "~/server/providers/intake";
import { supportsAssignedIntake } from "~/server/providers/intake-policy";
import {
  hostedPatBaseUrl,
  sealProviderPat,
} from "~/server/providers/pat-credential";
import { ProviderError } from "~/server/providers/types";
import {
  ensureProviderWebhook,
  removeProviderWebhook,
} from "~/server/providers/webhook-registration";
import { shouldActivateQueueItem } from "~/server/review/queue-policy";
import { enforceRateLimit } from "~/server/security/rate-limit";
import { assertSafeRemoteUrl } from "~/server/security/remote-url";
import { sealVaultSecret } from "~/server/security/vault";
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
  repositoryIntakeSchema,
  repositoryRetentionSchema,
} from "~/validators/provider";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const PROVIDER_WEBHOOK_REGISTRATION_ERROR =
  "Automatic provider notifications could not be enabled with this account. Reviews still work; use Check now to fetch updates.";

export const providerRouter = createTRPCRouter({
  listConnections: protectedProcedure.query(async ({ ctx }) => {
    const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
    return ctx.db
      .select({
        id: providerConnections.id,
        provider: providerConnections.provider,
        displayName: providerConnections.displayName,
        baseUrl: providerConnections.baseUrl,
        credentialKind: providerConnections.credentialKind,
        credentialStatus: providerConnections.credentialStatus,
        createdAt: providerConnections.createdAt,
      })
      .from(providerConnections)
      .where(eq(providerConnections.workspaceId, workspace.id));
  }),

  connect: protectedProcedure
    .input(connectProviderSchema)
    .mutation(async ({ ctx, input }) => {
      const localMode = isLocalDeployment();
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
      const existingConnection = input.connectionId
        ? await ctx.db.query.providerConnections.findFirst({
            where: and(
              eq(providerConnections.id, input.connectionId),
              eq(providerConnections.workspaceId, workspace.id),
            ),
          })
        : undefined;
      if (input.connectionId && !existingConnection) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      if (
        existingConnection &&
        (existingConnection.provider !== input.provider ||
          !supportsTokenReplacement(
            localMode,
            existingConnection.credentialKind,
          ))
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This connection must be reauthorized with its original method.",
        });
      }
      let baseUrl = input.baseUrl;
      if (!localMode) {
        try {
          baseUrl = hostedPatBaseUrl(input.provider, baseUrl);
        } catch (cause) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              cause instanceof Error
                ? cause.message
                : "Provider PAT settings are invalid",
            cause,
          });
        }
      }
      if (baseUrl) {
        await assertSafeRemoteUrl(
          baseUrl,
          localMode && env.ALLOW_PRIVATE_PROVIDER_HOSTS,
        );
      }
      const fingerprint = createHash("sha256")
        .update(
          `${workspace.id}\0${input.provider}\0${baseUrl ?? ""}\0${input.accessToken}`,
        )
        .digest("hex");
      if (existingConnection) {
        // The create path merges duplicates through onConflictDoUpdate, but
        // recovery updates one row by id. Reject a token already bound to a
        // sibling connection instead of failing on the unique index.
        const conflicting = await ctx.db.query.providerConnections.findFirst({
          where: and(
            eq(providerConnections.workspaceId, workspace.id),
            eq(providerConnections.provider, input.provider),
            eq(providerConnections.credentialFingerprint, fingerprint),
            ne(providerConnections.id, existingConnection.id),
          ),
        });
        if (conflicting) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Another connection in this workspace already uses this token. Remove that connection first, or supply a different token.",
          });
        }
      }
      const provider = createProvider(
        input.provider,
        input.accessToken,
        baseUrl,
        localMode ? "local_pat" : "pat",
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
      if (!localMode) {
        const connectionId = existingConnection?.id ?? randomUUID();
        return ctx.db.transaction(async (tx) => {
          const connectionValues = {
            externalAccountId: identity.externalAccountId,
            credentialKind: "pat",
            credentialStatus: "active",
            credentialFingerprint: fingerprint,
            displayName: input.displayName ?? identity.displayName,
            installationId: null,
            localCredentialId: null,
            baseUrl,
          } as const;
          const [connection] = existingConnection
            ? await tx
                .update(providerConnections)
                .set(connectionValues)
                .where(eq(providerConnections.id, existingConnection.id))
                .returning()
            : await tx
                .insert(providerConnections)
                .values({
                  id: connectionId,
                  workspaceId: workspace.id,
                  provider: input.provider,
                  ...connectionValues,
                })
                .onConflictDoUpdate({
                  target: [
                    providerConnections.workspaceId,
                    providerConnections.provider,
                    providerConnections.credentialFingerprint,
                  ],
                  set: connectionValues,
                })
                .returning();
          if (!connection) throw new Error("Could not persist PAT connection");
          const encryptedToken = await sealProviderPat(
            {
              workspaceId: workspace.id,
              connectionId: connection.id,
              provider: input.provider,
            },
            input.accessToken,
          );
          await tx
            .insert(providerPatCredentials)
            .values({ connectionId: connection.id, encryptedToken })
            .onConflictDoUpdate({
              target: providerPatCredentials.connectionId,
              set: { encryptedToken },
            });
          await tx.insert(credentialAuditEvents).values({
            workspaceId: workspace.id,
            actorId: ctx.auth.userId,
            credentialId: connection.id,
            action: existingConnection ? "rotated" : "created",
            provider: input.provider,
            metadata: { credentialKind: "pat" },
          });
          if (
            existingConnection?.localCredentialId &&
            existingConnection.localCredentialId !==
              connection.localCredentialId
          ) {
            await tx
              .delete(localCredentials)
              .where(
                eq(localCredentials.id, existingConnection.localCredentialId),
              );
          }
          return {
            id: connection.id,
            provider: connection.provider,
            displayName: connection.displayName,
            baseUrl: connection.baseUrl,
            credentialKind: connection.credentialKind,
            credentialStatus: connection.credentialStatus,
            createdAt: connection.createdAt,
          };
        });
      }
      const credentialId =
        existingConnection?.localCredentialId ?? randomUUID();
      const initialEncryptedPayload = await sealVaultSecret(
        {
          workspaceId: workspace.id,
          recordId: credentialId,
          provider: input.provider,
        },
        JSON.stringify({ token: input.accessToken }),
      );
      return ctx.db.transaction(async (tx) => {
        const credentialValues = {
          kind: `${input.provider}_pat`,
          label: input.displayName ?? identity.displayName,
          encryptedPayload: initialEncryptedPayload,
          fingerprint,
        };
        const [credential] = existingConnection?.localCredentialId
          ? await tx
              .update(localCredentials)
              .set(credentialValues)
              .where(
                eq(localCredentials.id, existingConnection.localCredentialId),
              )
              .returning()
          : await tx
              .insert(localCredentials)
              .values({
                id: credentialId,
                workspaceId: workspace.id,
                ...credentialValues,
              })
              .onConflictDoUpdate({
                target: [
                  localCredentials.workspaceId,
                  localCredentials.kind,
                  localCredentials.fingerprint,
                ],
                set: {
                  label: input.displayName ?? identity.displayName,
                },
              })
              .returning();
        if (!credential) throw new Error("Could not persist local credential");
        const encryptedPayload = await sealVaultSecret(
          {
            workspaceId: workspace.id,
            recordId: credential.id,
            provider: input.provider,
          },
          JSON.stringify({ token: input.accessToken }),
        );
        await tx
          .update(localCredentials)
          .set({ encryptedPayload })
          .where(eq(localCredentials.id, credential.id));
        const connectionValues = {
          externalAccountId: identity.externalAccountId,
          credentialKind: "local_pat",
          credentialStatus: "active",
          credentialFingerprint: fingerprint,
          displayName: input.displayName ?? identity.displayName,
          localCredentialId: credential.id,
          installationId: null,
          baseUrl,
        } as const;
        const returningConnection = {
          id: providerConnections.id,
          provider: providerConnections.provider,
          displayName: providerConnections.displayName,
          baseUrl: providerConnections.baseUrl,
          credentialKind: providerConnections.credentialKind,
          credentialStatus: providerConnections.credentialStatus,
          createdAt: providerConnections.createdAt,
        };
        const [connection] = existingConnection
          ? await tx
              .update(providerConnections)
              .set(connectionValues)
              .where(eq(providerConnections.id, existingConnection.id))
              .returning(returningConnection)
          : await tx
              .insert(providerConnections)
              .values({
                workspaceId: workspace.id,
                provider: input.provider,
                ...connectionValues,
              })
              .onConflictDoUpdate({
                target: [
                  providerConnections.workspaceId,
                  providerConnections.provider,
                  providerConnections.credentialFingerprint,
                ],
                set: connectionValues,
              })
              .returning(returningConnection);
        if (!connection)
          throw new Error("Could not persist provider connection");
        if (existingConnection) {
          await tx
            .delete(providerPatCredentials)
            .where(
              eq(providerPatCredentials.connectionId, existingConnection.id),
            );
          await tx
            .delete(oauthCredentials)
            .where(eq(oauthCredentials.connectionId, existingConnection.id));
        }
        await tx.insert(credentialAuditEvents).values({
          workspaceId: workspace.id,
          actorId: ctx.auth.userId,
          credentialId: credential.id,
          action: existingConnection ? "rotated" : "created",
          provider: input.provider,
          metadata: { credentialKind: "local_pat" },
        });
        return connection;
      });
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
      const connection = await ctx.db.query.providerConnections.findFirst({
        where: and(
          eq(providerConnections.id, input.connectionId),
          eq(providerConnections.workspaceId, workspace.id),
        ),
      });
      if (!connection) throw new TRPCError({ code: "NOT_FOUND" });
      let remoteCleanupFailures = 0;
      /** Records one provider-side cleanup failure without retaining credentials. */
      const recordRemoteCleanupFailure = (
        operation: string,
        cause: unknown,
        repositoryId?: string,
      ) => {
        remoteCleanupFailures += 1;
        console.error("Provider disconnect cleanup failed", {
          provider: connection.provider,
          connectionId: connection.id,
          operation,
          repositoryId,
          cause,
        });
      };
      if (!isLocalDeployment() && connection.provider !== "github") {
        const imported = await ctx.db.query.repositories.findMany({
          where: eq(repositories.connectionId, connection.id),
        });
        for (const repository of imported) {
          try {
            await removeProviderWebhook(ctx.db, { connection, repository });
          } catch (cause) {
            recordRemoteCleanupFailure(
              "remove_repository_webhook",
              cause,
              repository.id,
            );
          }
        }
      }
      if (!isLocalDeployment()) {
        if (
          connection.provider === "github" &&
          connection.credentialKind === "github_app" &&
          connection.installationId
        ) {
          try {
            await revokeGitHubInstallation(connection.installationId);
          } catch (cause) {
            recordRemoteCleanupFailure("revoke_github_installation", cause);
          }
        }
        try {
          await revokeProviderOAuth(ctx.db, connection);
        } catch (cause) {
          recordRemoteCleanupFailure("revoke_oauth_token", cause);
        }
      }
      const removed = await ctx.db.transaction(async (tx) => {
        await tx.insert(credentialAuditEvents).values({
          workspaceId: workspace.id,
          actorId: ctx.auth.userId,
          credentialId: connection.id,
          action: "disconnected",
          provider: connection.provider,
          metadata: {
            credentialKind: connection.credentialKind,
            remoteCleanupComplete: remoteCleanupFailures === 0,
            remoteCleanupFailures,
          },
        });
        const [deleted] = await tx
          .delete(providerConnections)
          .where(
            and(
              eq(providerConnections.id, input.connectionId),
              eq(providerConnections.workspaceId, workspace.id),
            ),
          )
          .returning({ id: providerConnections.id });
        return deleted;
      });
      if (!removed) throw new TRPCError({ code: "NOT_FOUND" });
      return {
        ...removed,
        remoteCleanupComplete: remoteCleanupFailures === 0,
      };
    }),

  listAvailableRepositories: protectedProcedure
    .input(importRepositorySchema.pick({ connectionId: true }))
    .query(async ({ ctx, input }) => {
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
      try {
        return await (
          await providerForConnection(ctx.db, connection)
        ).listRepositories();
      } catch (cause) {
        const rateLimited =
          cause instanceof ProviderError &&
          (cause.status === 403 || cause.status === 429) &&
          cause.message.toLowerCase().includes("rate limit");
        throw new TRPCError({
          code: rateLimited ? "TOO_MANY_REQUESTS" : "BAD_GATEWAY",
          message: providerConnectionErrorMessage(connection.provider, cause),
          cause,
        });
      }
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
        await (
          await providerForConnection(ctx.db, connection)
        ).listRepositories()
      ).find((repository) => repository.externalId === input.externalId);
      if (!remote) throw new TRPCError({ code: "NOT_FOUND" });
      const [repository] = await ctx.db
        .insert(repositories)
        .values({
          workspaceId: workspace.id,
          connectionId: connection.id,
          sourceRetentionDays: env.SOURCE_RETENTION_DAYS,
          sourceRetentionSnapshots: env.SOURCE_RETENTION_SNAPSHOTS,
          ...remote,
        })
        .onConflictDoUpdate({
          target: [
            repositories.workspaceId,
            repositories.connectionId,
            repositories.externalId,
          ],
          set: {
            owner: remote.owner,
            name: remote.name,
            defaultBranch: remote.defaultBranch,
            webUrl: remote.webUrl,
            isPrivate: remote.isPrivate,
            connectionId: connection.id,
          },
        })
        .returning();
      let importedRepository = repository;
      if (
        repository &&
        !isLocalDeployment() &&
        connection.provider !== "github"
      ) {
        try {
          await ensureProviderWebhook(ctx.db, { connection, repository });
          const [updated] = await ctx.db
            .update(repositories)
            .set({ intakeLastError: null })
            .where(
              and(
                eq(repositories.id, repository.id),
                eq(
                  repositories.intakeLastError,
                  PROVIDER_WEBHOOK_REGISTRATION_ERROR,
                ),
              ),
            )
            .returning();
          importedRepository = updated ?? repository;
        } catch (cause) {
          console.error("Provider webhook registration failed", {
            provider: connection.provider,
            repositoryId: repository.id,
            cause,
          });
          const [updated] = await ctx.db
            .update(repositories)
            .set({
              intakeLastError: PROVIDER_WEBHOOK_REGISTRATION_ERROR,
            })
            .where(eq(repositories.id, repository.id))
            .returning();
          importedRepository = updated ?? repository;
        }
      }
      return importedRepository;
    }),

  listImportedRepositories: protectedProcedure.query(async ({ ctx }) => {
    const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
    const rows = await ctx.db
      .select({
        id: repositories.id,
        externalId: repositories.externalId,
        owner: repositories.owner,
        name: repositories.name,
        provider: providerConnections.provider,
        connectionName: providerConnections.displayName,
        credentialKind: providerConnections.credentialKind,
        connectionId: repositories.connectionId,
        webUrl: repositories.webUrl,
        reviewIntakeMode: repositories.reviewIntakeMode,
        intakeLastAttemptAt: repositories.intakeLastAttemptAt,
        intakeLastReconciledAt: repositories.intakeLastReconciledAt,
        intakeLastError: repositories.intakeLastError,
      })
      .from(repositories)
      .innerJoin(
        providerConnections,
        eq(repositories.connectionId, providerConnections.id),
      )
      .where(eq(repositories.workspaceId, workspace.id));
    return rows;
  }),

  listOpenPullRequests: protectedProcedure
    .input(repositoryIdSchema)
    .query(async ({ ctx, input }) => {
      const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
      const repository = await ctx.db.query.repositories.findFirst({
        where: and(
          eq(repositories.id, input.repositoryId),
          eq(repositories.workspaceId, workspace.id),
        ),
      });
      if (!repository) throw new TRPCError({ code: "NOT_FOUND" });
      if (!repository.connectionId) return [];
      const connection = await ctx.db.query.providerConnections.findFirst({
        where: eq(providerConnections.id, repository.connectionId),
      });
      if (!connection) throw new TRPCError({ code: "NOT_FOUND" });
      try {
        return await (
          await providerForConnection(ctx.db, connection)
        ).listOpenPullRequests(repository.externalId);
      } catch (cause) {
        const rateLimited =
          cause instanceof ProviderError &&
          (cause.status === 403 || cause.status === 429) &&
          cause.message.toLowerCase().includes("rate limit");
        throw new TRPCError({
          code: rateLimited ? "TOO_MANY_REQUESTS" : "BAD_GATEWAY",
          message: providerConnectionErrorMessage(connection.provider, cause),
          cause,
        });
      }
    }),

  previewRepositoryIntake: protectedProcedure
    .input(repositoryIntakeSchema)
    .query(async ({ ctx, input }) => {
      const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
      const repository = await ctx.db.query.repositories.findFirst({
        where: and(
          eq(repositories.id, input.repositoryId),
          eq(repositories.workspaceId, workspace.id),
        ),
      });
      if (!repository) throw new TRPCError({ code: "NOT_FOUND" });
      if (input.mode === "manual") {
        return {
          matched: 0,
          alreadyPrepared: 0,
          keptRemoved: 0,
          newReviews: 0,
        };
      }
      const connection = await ctx.db.query.providerConnections.findFirst({
        where: eq(providerConnections.id, repository.connectionId),
      });
      if (!connection) throw new TRPCError({ code: "NOT_FOUND" });
      if (connection.credentialStatus !== "active") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Reconnect this provider before enabling automatic pull-request intake.",
        });
      }
      if (input.mode === "assigned" && !supportsAssignedIntake(connection)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "GitHub App installations cannot identify one human reviewer.",
        });
      }
      await enforceRateLimit(
        ctx.db,
        `repository-intake-preview:${workspace.id}:${input.repositoryId}`,
        12,
        5 * 60_000,
      );
      try {
        const candidates = await (
          await providerForConnection(ctx.db, connection)
        ).listOpenPullRequests(
          repository.externalId,
          input.mode === "assigned"
            ? { reviewerExternalAccountId: connection.externalAccountId }
            : undefined,
        );
        if (candidates.length === 0) {
          return {
            matched: 0,
            alreadyPrepared: 0,
            keptRemoved: 0,
            newReviews: 0,
          };
        }
        const existing = await ctx.db
          .select({
            number: pullRequests.number,
            queueState: reviewQueueItems.state,
            removedHeadSha: reviewQueueItems.removedHeadSha,
          })
          .from(pullRequests)
          .innerJoin(
            reviewQueueItems,
            and(
              eq(reviewQueueItems.pullRequestId, pullRequests.id),
              eq(reviewQueueItems.userId, ctx.auth.userId),
            ),
          )
          .where(
            and(
              eq(pullRequests.repositoryId, repository.id),
              inArray(
                pullRequests.number,
                candidates.map((candidate) => candidate.number),
              ),
            ),
          );
        const existingByNumber = new Map(
          existing.map((pullRequest) => [pullRequest.number, pullRequest]),
        );
        let alreadyPrepared = 0;
        let keptRemoved = 0;
        for (const candidate of candidates) {
          const queueItem = existingByNumber.get(candidate.number);
          if (queueItem?.queueState === "active") {
            alreadyPrepared += 1;
          } else if (
            queueItem?.queueState === "removed" &&
            !shouldActivateQueueItem({
              existingState: queueItem.queueState,
              removedHeadSha: queueItem.removedHeadSha,
              incomingHeadSha: candidate.headSha,
              explicit: false,
            })
          ) {
            keptRemoved += 1;
          }
        }
        return {
          matched: candidates.length,
          alreadyPrepared,
          keptRemoved,
          newReviews: candidates.length - alreadyPrepared - keptRemoved,
        };
      } catch (cause) {
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: providerConnectionErrorMessage(connection.provider, cause),
          cause,
        });
      }
    }),

  updateRepositoryIntake: protectedProcedure
    .input(repositoryIntakeSchema)
    .mutation(async ({ ctx, input }) => {
      const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
      await requireWorkspaceAdministrator(
        ctx.db,
        workspace.id,
        ctx.auth.userId,
      );
      const repository = await ctx.db.query.repositories.findFirst({
        where: and(
          eq(repositories.id, input.repositoryId),
          eq(repositories.workspaceId, workspace.id),
        ),
      });
      if (!repository) throw new TRPCError({ code: "NOT_FOUND" });
      const connection = await ctx.db.query.providerConnections.findFirst({
        where: eq(providerConnections.id, repository.connectionId),
      });
      if (!connection) throw new TRPCError({ code: "NOT_FOUND" });
      if (input.mode !== "manual" && connection.credentialStatus !== "active") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Reconnect this provider before enabling automatic pull-request intake.",
        });
      }
      if (input.mode === "assigned" && !supportsAssignedIntake(connection)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "GitHub App installations cannot identify one human reviewer. Choose manual or every open pull request.",
        });
      }
      const [updated] = await ctx.db
        .update(repositories)
        .set({
          reviewIntakeMode: input.mode,
          intakeOwnerId: input.mode === "manual" ? null : ctx.auth.userId,
          intakeLastAttemptAt: null,
          intakeLastError: null,
        })
        .where(
          and(
            eq(repositories.id, input.repositoryId),
            eq(repositories.workspaceId, workspace.id),
          ),
        )
        .returning({
          id: repositories.id,
          reviewIntakeMode: repositories.reviewIntakeMode,
        });
      if (!updated) throw new TRPCError({ code: "NOT_FOUND" });
      return updated;
    }),

  reconcileRepositoryIntake: protectedProcedure
    .input(repositoryIdSchema)
    .mutation(async ({ ctx, input }) => {
      const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
      await enforceRateLimit(
        ctx.db,
        `repository-intake:${workspace.id}:${input.repositoryId}`,
        6,
        5 * 60_000,
      );
      try {
        return await reconcileRepositoryIntake(ctx.db, {
          workspaceId: workspace.id,
          repositoryId: input.repositoryId,
          force: true,
        });
      } catch (cause) {
        const repository = await ctx.db.query.repositories.findFirst({
          where: and(
            eq(repositories.id, input.repositoryId),
            eq(repositories.workspaceId, workspace.id),
          ),
        });
        if (!repository) throw new TRPCError({ code: "NOT_FOUND" });
        const connection = await ctx.db.query.providerConnections.findFirst({
          where: eq(providerConnections.id, repository.connectionId),
        });
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: connection
            ? providerConnectionErrorMessage(connection.provider, cause)
            : "The provider connection is no longer available.",
          cause,
        });
      }
    }),

  reconcileWorkspaceIntake: protectedProcedure.mutation(async ({ ctx }) => {
    const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
    return reconcileWorkspaceIntake(
      ctx.db,
      workspace.id,
      isLocalDeployment() ? { intakeOwnerId: ctx.auth.userId } : undefined,
    );
  }),

  exportRepositoryData: protectedProcedure
    .input(repositoryIdSchema)
    .query(async ({ ctx, input }) => {
      const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
      const repository = await ctx.db.query.repositories.findFirst({
        where: and(
          eq(repositories.id, input.repositoryId),
          eq(repositories.workspaceId, workspace.id),
        ),
      });
      if (!repository) throw new TRPCError({ code: "NOT_FOUND" });
      const exported = await exportRepositoryReviewData(ctx.db, repository.id);
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
      const repository = await ctx.db.query.repositories.findFirst({
        where: and(
          eq(repositories.id, input.repositoryId),
          eq(repositories.workspaceId, workspace.id),
        ),
      });
      if (!repository) throw new TRPCError({ code: "NOT_FOUND" });
      if (repository.connectionId && !isLocalDeployment()) {
        const connection = await ctx.db.query.providerConnections.findFirst({
          where: eq(providerConnections.id, repository.connectionId),
        });
        if (connection && connection.provider !== "github") {
          try {
            await removeProviderWebhook(ctx.db, { connection, repository });
          } catch (cause) {
            console.error("Provider webhook cleanup failed during deletion", {
              provider: connection.provider,
              repositoryId: repository.id,
              cause,
            });
          }
        }
      }
      const [deleted] = await ctx.db
        .delete(repositories)
        .where(
          and(
            eq(repositories.id, input.repositoryId),
            eq(repositories.workspaceId, workspace.id),
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
            eq(repositories.workspaceId, workspace.id),
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
