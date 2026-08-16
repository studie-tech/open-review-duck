import "server-only";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { managedAiCredentials, workspaces } from "@/drizzle/schema";
import { env } from "~/env";
import type { db as database } from "~/server/db";
import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";

type Database = typeof database;

interface BillingPayerIdentity {
  organization_id?: string;
  user_id?: string;
}

interface BillingLifecycleEvent {
  data: unknown;
  type: string;
}

const terminalSubscriptionStatuses = new Set(["abandoned", "ended", "expired"]);

/** Selects billing identities whose managed credentials are no longer usable. */
export function billingPayerForManagedCredentialRevocation(
  event: BillingLifecycleEvent,
) {
  if (typeof event.data !== "object" || event.data === null) return undefined;
  const data = event.data as Record<string, unknown>;
  if (typeof data.payer !== "object" || data.payer === null) return undefined;
  const payerRecord = data.payer as Record<string, unknown>;
  const payer: BillingPayerIdentity = {};
  if (typeof payerRecord.organization_id === "string") {
    payer.organization_id = payerRecord.organization_id;
  }
  if (typeof payerRecord.user_id === "string") {
    payer.user_id = payerRecord.user_id;
  }
  if (!payer.organization_id && !payer.user_id) return undefined;
  if (
    event.type === "subscriptionItem.abandoned" ||
    event.type === "subscriptionItem.ended"
  ) {
    return payer;
  }
  if (
    event.type === "subscription.updated" &&
    typeof data.status === "string" &&
    terminalSubscriptionStatuses.has(data.status)
  ) {
    return payer;
  }
  return undefined;
}

const createKeyResponse = z.object({
  data: z.object({ hash: z.string().min(1) }),
  key: z.string().min(1),
});

/** Returns the workspace's service-owned, provider-limited OpenRouter key. */
export async function openRouterWorkspaceKey(
  db: Database,
  workspaceId: string,
) {
  let credential = await db.query.managedAiCredentials.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.workspaceId, workspaceId), eq(table.provider, "openrouter")),
  });
  if (!credential) {
    if (
      !env.OPENROUTER_MANAGEMENT_KEY ||
      !env.OPENROUTER_WORKSPACE_MONTHLY_LIMIT_USD
    ) {
      throw new Error("Managed OpenRouter credentials are not configured");
    }
    const limit = env.OPENROUTER_WORKSPACE_MONTHLY_LIMIT_USD;
    const response = await fetch("https://openrouter.ai/api/v1/keys", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENROUTER_MANAGEMENT_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: `reviewduck-${workspaceId}`,
        limit,
        limit_reset: "monthly",
        include_byok_in_limit: false,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`OpenRouter key creation failed (${response.status})`);
    }
    const created = createKeyResponse.parse(await response.json());
    const recordId = crypto.randomUUID();
    const encryptedCredential = await sealVaultSecret(
      { workspaceId, recordId, provider: "openrouter" },
      created.key,
    );
    const [inserted] = await db
      .insert(managedAiCredentials)
      .values({
        id: recordId,
        workspaceId,
        provider: "openrouter",
        providerKeyId: created.data.hash,
        encryptedCredential,
        monthlyLimitMicroUsd: Math.ceil(limit * 1_000_000),
      })
      .onConflictDoNothing({
        target: [
          managedAiCredentials.workspaceId,
          managedAiCredentials.provider,
        ],
      })
      .returning();
    credential =
      inserted ??
      (await db.query.managedAiCredentials.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.workspaceId, workspaceId),
            eq(table.provider, "openrouter"),
          ),
      }));
    if (!inserted) {
      // A concurrent request won. Revoke the unused provider key immediately.
      await fetch(
        `https://openrouter.ai/api/v1/keys/${encodeURIComponent(created.data.hash)}`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${env.OPENROUTER_MANAGEMENT_KEY}`,
          },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      );
    }
  }
  if (!credential) throw new Error("OpenRouter workspace key is unavailable");
  return openVaultSecret(
    {
      workspaceId,
      recordId: credential.id,
      provider: "openrouter",
    },
    credential.encryptedCredential,
  );
}

/** Deletes a managed workspace key at the provider before removing its record. */
async function revokeOpenRouterWorkspaceKey(db: Database, workspaceId: string) {
  const credential = await db.query.managedAiCredentials.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.workspaceId, workspaceId), eq(table.provider, "openrouter")),
  });
  if (!credential) return;
  if (!env.OPENROUTER_MANAGEMENT_KEY) {
    throw new Error("OpenRouter management key is required for revocation");
  }
  const response = await fetch(
    `https://openrouter.ai/api/v1/keys/${encodeURIComponent(credential.providerKeyId)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${env.OPENROUTER_MANAGEMENT_KEY}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`OpenRouter key revocation failed (${response.status})`);
  }
  await db
    .delete(managedAiCredentials)
    .where(eq(managedAiCredentials.id, credential.id));
}

/** Revokes managed OpenRouter keys owned by one terminal Clerk billing payer. */
export async function revokeOpenRouterWorkspaceKeysForBillingPayer(
  db: Database,
  payer: BillingPayerIdentity,
) {
  const workspaceIds = new Set<string>();
  if (payer.user_id) {
    const owned = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.ownerId, payer.user_id));
    for (const workspace of owned) workspaceIds.add(workspace.id);
  }
  if (payer.organization_id) {
    const organizations = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.clerkOrganizationId, payer.organization_id));
    for (const workspace of organizations) workspaceIds.add(workspace.id);
  }
  for (const workspaceId of workspaceIds) {
    await revokeOpenRouterWorkspaceKey(db, workspaceId);
  }
  return workspaceIds.size;
}
