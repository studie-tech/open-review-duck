import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  providerConnections,
  pullRequests,
  repositories,
  webhookDeliveries,
} from "@/drizzle/schema";
import { env } from "~/env";
import { db } from "~/server/db";
import { providerForConnection } from "~/server/providers/credentials";
import {
  applyGitHubLifecycleEvent,
  isGitHubLifecycleEvent,
} from "~/server/providers/github-lifecycle";
import { supportsAssignedIntake } from "~/server/providers/intake-policy";
import { providerWebhookTarget } from "~/server/providers/webhook-registration";
import {
  boundedWebhookBody,
  verifyAzureWebhook,
  verifyGitHubWebhook,
  verifyGitLabWebhook,
} from "~/server/providers/webhook-security";
import { githubInstallationId } from "~/server/security/oauth-flow";
import { startPullRequestSync } from "~/server/workflows/service";

type HostedProvider = "github" | "gitlab" | "azure_devops";

/** Verifies the provider-specific signature before payload parsing. */
function verify(
  provider: HostedProvider,
  request: Request,
  body: Uint8Array,
  registeredSecret?: string,
) {
  if (provider === "github") {
    return Boolean(
      env.GITHUB_WEBHOOK_SECRET &&
        verifyGitHubWebhook(env.GITHUB_WEBHOOK_SECRET, request.headers, body),
    );
  }
  if (provider === "gitlab") {
    return Boolean(
      registeredSecret &&
        verifyGitLabWebhook(registeredSecret, request.headers, body),
    );
  }
  return Boolean(
    registeredSecret && verifyAzureWebhook(registeredSecret, request.headers),
  );
}

/** Returns the provider's immutable delivery identifier header. */
function deliveryIdentity(
  provider: HostedProvider,
  request: Request,
  payload: unknown,
) {
  if (provider === "github") return request.headers.get("x-github-delivery");
  if (provider === "gitlab") return request.headers.get("webhook-id");
  return azurePayload.parse(payload).id;
}

/** Returns the provider's event-kind header. */
function eventName(
  provider: HostedProvider,
  request: Request,
  payload: unknown,
) {
  if (provider === "github") return request.headers.get("x-github-event");
  if (provider === "gitlab") return request.headers.get("x-gitlab-event");
  return azurePayload.parse(payload).eventType;
}

const githubPayload = z.object({
  number: z.number().optional(),
  repository: z.object({ id: z.union([z.string(), z.number()]) }),
  pull_request: z
    .object({ number: z.number(), updated_at: z.string().datetime() })
    .optional(),
  installation: z.object({ id: z.union([z.string(), z.number()]) }),
});
const gitlabPayload = z.object({
  project: z.object({ id: z.union([z.string(), z.number()]) }),
  object_attributes: z.object({
    iid: z.number(),
    updated_at: z.string().datetime(),
  }),
});
const azurePayload = z.object({
  id: z.string().min(1).max(200),
  eventType: z.string().min(1).max(120),
  createdDate: z.string().datetime(),
  resource: z.object({
    pullRequestId: z.number(),
    repository: z.object({ id: z.string() }),
  }),
});

/** Restricts synchronization to pull-request event families. */
function supportedEvent(provider: HostedProvider, event: string) {
  if (provider === "github") return event === "pull_request";
  if (provider === "gitlab") return event === "Merge Request Hook";
  return [
    "git.pullrequest.created",
    "git.pullrequest.updated",
    "git.pullrequest.merged",
  ].includes(event);
}

/** Claims one delivery identity, allowing an explicitly failed attempt to retry. */
async function claimDelivery(
  provider: HostedProvider,
  deliveryId: string,
  event: string,
) {
  let [delivery] = await db
    .insert(webhookDeliveries)
    .values({
      provider,
      deliveryId,
      event,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    })
    .onConflictDoNothing({
      target: [webhookDeliveries.provider, webhookDeliveries.deliveryId],
    })
    .returning();
  if (delivery) return delivery;
  const failed = await db.query.webhookDeliveries.findFirst({
    where: and(
      eq(webhookDeliveries.provider, provider),
      eq(webhookDeliveries.deliveryId, deliveryId),
      eq(webhookDeliveries.status, "failed"),
    ),
  });
  if (!failed) return undefined;
  [delivery] = await db
    .update(webhookDeliveries)
    .set({ status: "received", error: null, processedAt: null })
    .where(
      and(
        eq(webhookDeliveries.id, failed.id),
        eq(webhookDeliveries.status, "failed"),
      ),
    )
    .returning();
  return delivery;
}

/** Extracts and validates provider event time for stale-delivery rejection. */
function eventTime(provider: HostedProvider, payload: unknown) {
  if (provider === "github") {
    return githubPayload.parse(payload).pull_request?.updated_at;
  }
  if (provider === "gitlab") {
    return gitlabPayload.parse(payload).object_attributes.updated_at;
  }
  return azurePayload.parse(payload).createdDate;
}

/** Parses a verified payload into its repository and pull-request identity. */
function synchronizationTarget(provider: HostedProvider, payload: unknown) {
  if (provider === "github") {
    const value = githubPayload.parse(payload);
    return {
      repositoryExternalId: String(value.repository?.id ?? ""),
      pullRequestNumber: Number(value.pull_request?.number ?? value.number),
    };
  }
  if (provider === "gitlab") {
    const value = gitlabPayload.parse(payload);
    return {
      repositoryExternalId: String(value.project?.id ?? ""),
      pullRequestNumber: Number(value.object_attributes?.iid),
    };
  }
  const value = azurePayload.parse(payload);
  return {
    repositoryExternalId: String(value.resource?.repository?.id ?? ""),
    pullRequestNumber: Number(value.resource?.pullRequestId),
  };
}

/** Verifies, deduplicates, and durably enqueues one source-provider webhook. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider: rawProvider } = await params;
  if (!["github", "gitlab", "azure_devops"].includes(rawProvider)) {
    return new NextResponse(null, { status: 404 });
  }
  const provider = rawProvider as HostedProvider;
  const hookId = new URL(request.url).searchParams.get("hook");
  const registeredHookId =
    hookId && z.uuid().safeParse(hookId).success ? hookId : undefined;
  const registeredTarget =
    provider === "github" || !registeredHookId
      ? undefined
      : await providerWebhookTarget(db, provider, registeredHookId);
  if (provider !== "github" && !registeredTarget) {
    return new NextResponse(null, { status: 404 });
  }
  const bytes = await boundedWebhookBody(request, 2 * 1024 * 1024);
  if (!bytes) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  if (!verify(provider, request, bytes, registeredTarget?.secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  let deliveryId: string | null;
  let event: string | null;
  try {
    deliveryId = deliveryIdentity(provider, request, payload);
    event = eventName(provider, request, payload);
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  if (!deliveryId || deliveryId.length > 200 || !event || event.length > 120) {
    return NextResponse.json(
      { error: "Delivery identity is missing or invalid" },
      { status: 400 },
    );
  }
  if (
    provider === "azure_devops" &&
    request.headers.has("x-vss-event") &&
    request.headers.get("x-vss-event") !== event
  ) {
    return NextResponse.json(
      { error: "Event identity mismatch" },
      { status: 400 },
    );
  }
  const lifecycle = provider === "github" && isGitHubLifecycleEvent(event);
  if (!supportedEvent(provider, event) && !lifecycle) {
    return NextResponse.json({ ignored: true }, { status: 202 });
  }
  const scopedDeliveryId = registeredTarget
    ? `${registeredTarget.hook.id}:${deliveryId}`
    : deliveryId;
  const delivery = await claimDelivery(provider, scopedDeliveryId, event);
  if (!delivery) return NextResponse.json({ duplicate: true }, { status: 202 });
  if (lifecycle) {
    try {
      const applied = await applyGitHubLifecycleEvent(db, event, payload);
      await db
        .update(webhookDeliveries)
        .set({
          status: applied ? "processed" : "ignored",
          processedAt: new Date(),
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      return NextResponse.json(
        applied ? { processed: true } : { ignored: true },
        { status: 202 },
      );
    } catch (cause) {
      await db
        .update(webhookDeliveries)
        .set({
          status: "failed",
          error: cause instanceof Error ? cause.message : "Webhook failed",
          processedAt: new Date(),
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      throw cause;
    }
  }
  const parsedPayload =
    provider === "github"
      ? githubPayload.safeParse(payload)
      : provider === "gitlab"
        ? gitlabPayload.safeParse(payload)
        : azurePayload.safeParse(payload);
  if (!parsedPayload.success) {
    await db
      .update(webhookDeliveries)
      .set({
        status: "rejected",
        error: "Invalid payload",
        processedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  payload = parsedPayload.data;
  try {
    const occurredAt = new Date(eventTime(provider, payload) ?? Number.NaN);
    const age = Date.now() - occurredAt.getTime();
    if (
      !Number.isFinite(occurredAt.getTime()) ||
      age > 24 * 60 * 60_000 ||
      age < -5 * 60_000
    ) {
      await db
        .update(webhookDeliveries)
        .set({
          status: "rejected",
          error: "Webhook delivery is stale or future-dated",
          processedAt: new Date(),
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      return NextResponse.json({ error: "Stale delivery" }, { status: 400 });
    }
    const target = synchronizationTarget(provider, payload);
    if (
      !target.repositoryExternalId ||
      !Number.isSafeInteger(target.pullRequestNumber) ||
      target.pullRequestNumber <= 0
    ) {
      await db
        .update(webhookDeliveries)
        .set({ status: "ignored", processedAt: new Date() })
        .where(eq(webhookDeliveries.id, delivery.id));
      return NextResponse.json({ ignored: true }, { status: 202 });
    }
    if (
      registeredTarget &&
      registeredTarget.repository.externalId !== target.repositoryExternalId
    ) {
      await db
        .update(webhookDeliveries)
        .set({
          status: "rejected",
          error: "Webhook repository does not match its registered target",
          processedAt: new Date(),
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      return NextResponse.json(
        { error: "Repository mismatch" },
        { status: 400 },
      );
    }
    const matchingRepositories = registeredTarget
      ? [
          {
            id: registeredTarget.repository.id,
            workspaceId: registeredTarget.repository.workspaceId,
            connectionId: registeredTarget.repository.connectionId,
            externalId: registeredTarget.repository.externalId,
            reviewIntakeMode: registeredTarget.repository.reviewIntakeMode,
            intakeOwnerId: registeredTarget.repository.intakeOwnerId,
          },
        ]
      : await db
          .select({
            id: repositories.id,
            workspaceId: repositories.workspaceId,
            connectionId: repositories.connectionId,
            externalId: repositories.externalId,
            reviewIntakeMode: repositories.reviewIntakeMode,
            intakeOwnerId: repositories.intakeOwnerId,
          })
          .from(repositories)
          .innerJoin(
            providerConnections,
            eq(repositories.connectionId, providerConnections.id),
          )
          .where(
            and(
              eq(providerConnections.provider, "github"),
              eq(providerConnections.credentialKind, "github_app"),
              eq(providerConnections.credentialStatus, "active"),
              eq(
                providerConnections.installationId,
                githubInstallationId(
                  String(githubPayload.parse(payload).installation.id),
                ) ?? "invalid",
              ),
              eq(repositories.externalId, target.repositoryExternalId),
            ),
          );
    if (matchingRepositories.length === 0) {
      await db
        .update(webhookDeliveries)
        .set({ status: "ignored", processedAt: new Date() })
        .where(eq(webhookDeliveries.id, delivery.id));
      return NextResponse.json({ ignored: true }, { status: 202 });
    }
    /** Applies one delivery independently so every connected tenant is attempted. */
    const synchronizeRepository = async (
      repository: (typeof matchingRepositories)[number],
    ) => {
      const existing = await db.query.pullRequests.findFirst({
        where: and(
          eq(pullRequests.repositoryId, repository.id),
          eq(pullRequests.number, target.pullRequestNumber),
        ),
        columns: { id: true },
      });
      let shouldSynchronize =
        Boolean(existing) || repository.reviewIntakeMode === "all";
      if (!shouldSynchronize && repository.reviewIntakeMode === "assigned") {
        const connection = await db.query.providerConnections.findFirst({
          where: eq(providerConnections.id, repository.connectionId),
        });
        if (connection && supportsAssignedIntake(connection)) {
          const assigned = await (
            await providerForConnection(db, connection)
          ).listOpenPullRequests(repository.externalId, {
            reviewerExternalAccountId: connection.externalAccountId,
          });
          shouldSynchronize = assigned.some(
            (pullRequest) => pullRequest.number === target.pullRequestNumber,
          );
        }
      }
      if (!shouldSynchronize) return undefined;
      return startPullRequestSync(db, {
        workspaceId: repository.workspaceId,
        repositoryId: repository.id,
        pullRequestNumber: target.pullRequestNumber,
        queue:
          repository.reviewIntakeMode !== "manual" && repository.intakeOwnerId
            ? {
                userId: repository.intakeOwnerId,
                source: repository.reviewIntakeMode,
                explicit: false,
              }
            : undefined,
      });
    };
    const results = await Promise.allSettled(
      matchingRepositories.map(synchronizeRepository),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(({ reason }) => reason),
        `${failures.length} webhook synchronization target(s) failed`,
      );
    }
    const synchronizations = results.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : [],
    );
    if (synchronizations.length === 0) {
      await db
        .update(webhookDeliveries)
        .set({ status: "ignored", processedAt: new Date() })
        .where(eq(webhookDeliveries.id, delivery.id));
      return NextResponse.json({ ignored: true }, { status: 202 });
    }
    await db
      .update(webhookDeliveries)
      .set({ status: "enqueued", processedAt: new Date() })
      .where(eq(webhookDeliveries.id, delivery.id));
    return NextResponse.json(
      { synchronizations, count: synchronizations.length },
      { status: 202 },
    );
  } catch (cause) {
    await db
      .update(webhookDeliveries)
      .set({
        status: "failed",
        error: cause instanceof Error ? cause.message : "Webhook failed",
        processedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    throw cause;
  }
}
