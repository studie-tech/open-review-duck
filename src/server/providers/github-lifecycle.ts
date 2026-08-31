import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  credentialAuditEvents,
  providerConnections,
  repositories,
} from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { invalidateGitHubInstallationToken } from "~/server/providers/credentials";
import { githubInstallationId } from "~/server/security/oauth-flow";

type Database = typeof database;

const installationEvent = z.object({
  action: z.string().min(1).max(64),
  installation: z.object({ id: z.union([z.string(), z.number()]) }),
});

const repositorySelectionEvent = z.object({
  action: z.string().min(1).max(64),
  installation: z.object({ id: z.union([z.string(), z.number()]) }),
  repositories_removed: z
    .array(z.object({ id: z.union([z.string(), z.number()]) }))
    .max(10_000)
    .optional()
    .default([]),
});

export const GITHUB_INSTALLATION_UNAVAILABLE =
  "GitHub App access was suspended or removed. Reauthorize the connection before enabling automatic intake.";
export const GITHUB_REPOSITORY_UNAVAILABLE =
  "This repository is no longer included in the GitHub App installation. Add it to the installation before enabling automatic intake.";

/** Identifies GitHub App lifecycle events that must update local authorization state. */
export function isGitHubLifecycleEvent(event: string) {
  return event === "installation" || event === "installation_repositories";
}

/** Applies a verified GitHub App lifecycle event to the exact installation. */
export async function applyGitHubLifecycleEvent(
  db: Database,
  event: string,
  payload: unknown,
) {
  if (event === "installation") {
    const value = installationEvent.parse(payload);
    const installationId = githubInstallationId(String(value.installation.id));
    if (!installationId)
      throw new Error("Invalid GitHub installation identity");
    if (value.action === "new_permissions_accepted") {
      invalidateGitHubInstallationToken(installationId);
      return true;
    }
    if (!["deleted", "suspend", "unsuspend"].includes(value.action)) {
      return false;
    }
    const status =
      value.action === "deleted"
        ? "revoked"
        : value.action === "suspend"
          ? "suspended"
          : "active";
    return db.transaction(async (tx) => {
      const connection = await tx.query.providerConnections.findFirst({
        where: and(
          eq(providerConnections.provider, "github"),
          eq(providerConnections.credentialKind, "github_app"),
          eq(providerConnections.installationId, installationId),
        ),
      });
      if (!connection) return false;
      await tx
        .update(providerConnections)
        .set({ credentialStatus: status })
        .where(eq(providerConnections.id, connection.id));
      if (status === "active") {
        await tx
          .update(repositories)
          .set({ intakeLastError: null })
          .where(
            and(
              eq(repositories.connectionId, connection.id),
              eq(repositories.intakeLastError, GITHUB_INSTALLATION_UNAVAILABLE),
            ),
          );
      } else {
        await tx
          .update(repositories)
          .set({
            reviewIntakeMode: "manual",
            intakeOwnerId: null,
            intakeLastError: GITHUB_INSTALLATION_UNAVAILABLE,
          })
          .where(eq(repositories.connectionId, connection.id));
      }
      await tx.insert(credentialAuditEvents).values({
        workspaceId: connection.workspaceId,
        credentialId: connection.id,
        action:
          status === "active"
            ? "restored"
            : status === "suspended"
              ? "suspended"
              : "revoked",
        provider: "github",
        metadata: { credentialKind: "github_app", installationId },
      });
      return true;
    });
  }

  if (event !== "installation_repositories") return false;
  const value = repositorySelectionEvent.parse(payload);
  if (value.action !== "removed" || value.repositories_removed.length === 0) {
    return false;
  }
  const installationId = githubInstallationId(String(value.installation.id));
  if (!installationId) throw new Error("Invalid GitHub installation identity");
  const repositoryIds = value.repositories_removed.map(({ id }) => String(id));
  return db.transaction(async (tx) => {
    const connection = await tx.query.providerConnections.findFirst({
      where: and(
        eq(providerConnections.provider, "github"),
        eq(providerConnections.credentialKind, "github_app"),
        eq(providerConnections.installationId, installationId),
      ),
    });
    if (!connection) return false;
    const affected = await tx
      .update(repositories)
      .set({
        reviewIntakeMode: "manual",
        intakeOwnerId: null,
        intakeLastError: GITHUB_REPOSITORY_UNAVAILABLE,
      })
      .where(
        and(
          eq(repositories.connectionId, connection.id),
          inArray(repositories.externalId, repositoryIds),
        ),
      )
      .returning({ id: repositories.id });
    await tx.insert(credentialAuditEvents).values({
      workspaceId: connection.workspaceId,
      credentialId: connection.id,
      action: "repository_access_removed",
      provider: "github",
      metadata: {
        credentialKind: "github_app",
        installationId,
        repositoryCount: affected.length,
      },
    });
    return affected.length > 0;
  });
}
