import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  providerConnections,
  providerWebhooks,
  repositories,
} from "@/drizzle/schema";
import { env } from "~/env";
import type { db as database } from "~/server/db";
import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";
import { providerForConnection } from "./credentials";
import type { ProviderName } from "./types";

type Database = typeof database;
type Connection = typeof providerConnections.$inferSelect;
type Repository = typeof repositories.$inferSelect;

/** Creates a provider-specific 256-bit webhook authenticator. */
function webhookSecret(provider: ProviderName) {
  const key = randomBytes(32);
  return provider === "gitlab"
    ? `whsec_${key.toString("base64")}`
    : key.toString("base64url");
}

/** Builds the opaque callback URL for one tenant-owned provider hook. */
function callbackUrl(provider: ProviderName, hookId: string) {
  if (!env.APP_URL) throw new Error("Application URL is not configured");
  const callback = new URL(`/api/webhooks/${provider}`, env.APP_URL);
  callback.searchParams.set("hook", hookId);
  return callback.toString();
}

/** Creates or repairs the exact remote hook owned by one imported repository. */
export async function ensureProviderWebhook(
  db: Database,
  input: { connection: Connection; repository: Repository },
) {
  if (input.connection.provider === "github") return undefined;
  const provider = await providerForConnection(db, input.connection);
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`provider-webhook:${input.repository.id}`}, 0))`,
    );
    const existing = await tx.query.providerWebhooks.findFirst({
      where: eq(providerWebhooks.repositoryId, input.repository.id),
    });
    if (existing && existing.provider !== input.connection.provider) {
      throw new Error("Provider webhook ownership is inconsistent");
    }
    if (existing) return;
    const id = randomUUID();
    const secret = webhookSecret(input.connection.provider);
    await tx.insert(providerWebhooks).values({
      id,
      repositoryId: input.repository.id,
      provider: input.connection.provider,
      encryptedSecret: await sealVaultSecret(
        {
          workspaceId: input.repository.workspaceId,
          recordId: id,
          provider: `${input.connection.provider}-webhook`,
        },
        secret,
      ),
    });
  });
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`provider-webhook:${input.repository.id}`}, 0))`,
    );
    const hook = await tx.query.providerWebhooks.findFirst({
      where: eq(providerWebhooks.repositoryId, input.repository.id),
    });
    if (!hook || hook.provider !== input.connection.provider) {
      throw new Error("Provider webhook ownership is inconsistent");
    }
    const secret = await openVaultSecret(
      {
        workspaceId: input.repository.workspaceId,
        recordId: hook.id,
        provider: `${input.connection.provider}-webhook`,
      },
      hook.encryptedSecret,
    );
    const remoteHookIds = await provider.ensureRepositoryWebhook({
      repositoryExternalId: input.repository.externalId,
      callbackUrl: callbackUrl(input.connection.provider, hook.id),
      secret,
    });
    const [updated] = await tx
      .update(providerWebhooks)
      .set({ remoteHookIds })
      .where(
        and(
          eq(providerWebhooks.id, hook.id),
          eq(providerWebhooks.repositoryId, input.repository.id),
        ),
      )
      .returning();
    if (!updated) throw new Error("Could not persist provider webhook");
    return updated;
  });
}

/** Removes only the exact remote hooks owned by one imported repository. */
export async function removeProviderWebhook(
  db: Database,
  input: { connection: Connection; repository: Repository },
) {
  if (input.connection.provider === "github") return;
  const registered = await db.query.providerWebhooks.findFirst({
    where: eq(providerWebhooks.repositoryId, input.repository.id),
    columns: { id: true },
  });
  if (!registered) return;
  const provider = await providerForConnection(db, input.connection);
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`provider-webhook:${input.repository.id}`}, 0))`,
    );
    const hook = await tx.query.providerWebhooks.findFirst({
      where: eq(providerWebhooks.repositoryId, input.repository.id),
    });
    if (!hook) return;
    if (hook.provider !== input.connection.provider) {
      throw new Error("Provider webhook ownership is inconsistent");
    }
    await provider.removeRepositoryWebhook({
      repositoryExternalId: input.repository.externalId,
      callbackUrl: callbackUrl(input.connection.provider, hook.id),
      remoteHookIds: hook.remoteHookIds,
    });
    await tx
      .delete(providerWebhooks)
      .where(
        and(
          eq(providerWebhooks.id, hook.id),
          eq(providerWebhooks.repositoryId, input.repository.id),
        ),
      );
  });
}

/** Resolves and decrypts one opaque tenant-owned webhook target. */
export async function providerWebhookTarget(
  db: Database,
  provider: Exclude<ProviderName, "github">,
  hookId: string,
) {
  const [target] = await db
    .select({
      hook: providerWebhooks,
      repository: repositories,
      connection: providerConnections,
    })
    .from(providerWebhooks)
    .innerJoin(repositories, eq(providerWebhooks.repositoryId, repositories.id))
    .innerJoin(
      providerConnections,
      eq(repositories.connectionId, providerConnections.id),
    )
    .where(
      and(
        eq(providerWebhooks.id, hookId),
        eq(providerWebhooks.provider, provider),
        eq(providerConnections.provider, provider),
        eq(providerConnections.credentialStatus, "active"),
      ),
    )
    .limit(1);
  if (!target) return undefined;
  return {
    ...target,
    secret: await openVaultSecret(
      {
        workspaceId: target.repository.workspaceId,
        recordId: target.hook.id,
        provider: `${provider}-webhook`,
      },
      target.hook.encryptedSecret,
    ),
  };
}
