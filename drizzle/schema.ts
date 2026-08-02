import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTableCreator,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const createTable = pgTableCreator((name) => `open_review_duck_${name}`);

export const providerEnum = pgEnum("provider", [
  "github",
  "gitlab",
  "azure_devops",
]);
export const sourceBlobStateEnum = pgEnum("source_blob_state", [
  "uploading",
  "ready",
  "failed",
  "deleting",
]);
export const sourceStorageEnum = pgEnum("source_storage", [
  "uploadthing",
  "local",
]);
export const workflowRunStatusEnum = pgEnum("workflow_run_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export const semanticArtifactStatusEnum = pgEnum("semantic_artifact_status", [
  "uploading",
  "validating",
  "ready",
  "rejected",
  "deleting",
]);
export const pullRequestStateEnum = pgEnum("pull_request_state", [
  "open",
  "merged",
  "closed",
  "draft",
]);
export const repositoryIntakeModeEnum = pgEnum("repository_intake_mode", [
  "manual",
  "assigned",
  "all",
]);
export const reviewQueueStateEnum = pgEnum("review_queue_state", [
  "active",
  "removed",
]);
export const reviewQueueSourceEnum = pgEnum("review_queue_source", [
  "manual",
  "assigned",
  "all",
]);
export const symbolKindEnum = pgEnum("symbol_kind", [
  "constant",
  "variable",
  "function",
  "method",
  "class",
  "module",
  "test",
  "test_suite",
  "test_hook",
  "binary",
  "file",
]);
export const sourceChangeTypeEnum = pgEnum("source_change_type", [
  "added",
  "modified",
  "deleted",
  "renamed",
]);
export const aiModeEnum = pgEnum("ai_mode", ["off", "on_demand", "automatic"]);
export const aiJobKindEnum = pgEnum("ai_job_kind", ["explain", "review"]);
export const aiJobStatusEnum = pgEnum("ai_job_status", [
  "queued",
  "running",
  "waiting_for_provider",
  "streaming",
  "completed",
  "failed",
  "cancelled",
]);
export const aiCompletionReasonEnum = pgEnum("ai_completion_reason", [
  "answered",
  "investigation_limit",
  "quota_limit",
  "cost_limit",
  "cancelled",
  "provider_failure",
]);
export const reviewCommentSourceEnum = pgEnum("review_comment_source", [
  "user",
  "ai",
]);
export const reviewCommentStatusEnum = pgEnum("review_comment_status", [
  "publishing",
  "published",
  "failed",
]);

export const users = createTable("user", {
  id: text().primaryKey(),
  email: varchar({ length: 320 }),
  displayName: varchar({ length: 120 }),
  imageUrl: text(),
  currentStreak: integer().notNull().default(0),
  longestStreak: integer().notNull().default(0),
  experiencePoints: integer().notNull().default(0),
  lastReviewDate: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const workspaces = createTable("workspace", {
  id: uuid().primaryKey().defaultRandom(),
  clerkOrganizationId: text().unique(),
  ownerId: text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: varchar({ length: 120 }).notNull(),
  slug: varchar({ length: 80 }).notNull().unique(),
  aiMode: aiModeEnum().notNull().default("on_demand"),
  aiReviewEnabled: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const workspaceMembers = createTable(
  "workspace_member",
  {
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar({ length: 24 }).notNull().default("member"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("workspace_member_user_idx").on(t.userId),
  ],
);

export const localSessions = createTable(
  "local_session",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar({ length: 64 }).notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    lastUsedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("local_session_user_idx").on(t.userId, t.expiresAt)],
);

export const localBootstrapTokens = createTable("local_bootstrap_token", {
  id: uuid().primaryKey().defaultRandom(),
  tokenHash: varchar({ length: 64 }).notNull().unique(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  consumedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const localCredentials = createTable(
  "local_credential",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: varchar({ length: 32 }).notNull(),
    label: varchar({ length: 160 }).notNull(),
    encryptedPayload: text().notNull(),
    fingerprint: varchar({ length: 64 }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("local_credential_fingerprint_idx").on(
      t.workspaceId,
      t.kind,
      t.fingerprint,
    ),
  ],
);

export const credentialAuditEvents = createTable(
  "credential_audit_event",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorId: text().references(() => users.id, { onDelete: "set null" }),
    credentialId: uuid(),
    action: varchar({ length: 48 }).notNull(),
    provider: varchar({ length: 32 }),
    metadata: jsonb().$type<Record<string, string | number | boolean>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("credential_audit_workspace_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const providerConnections = createTable(
  "provider_connection",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: providerEnum().notNull(),
    externalAccountId: text().notNull(),
    credentialKind: varchar({ length: 32 }).notNull().default("local_pat"),
    credentialFingerprint: varchar({ length: 64 }),
    displayName: varchar({ length: 160 }).notNull(),
    installationId: text(),
    localCredentialId: uuid().references(() => localCredentials.id, {
      onDelete: "set null",
    }),
    baseUrl: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("connection_credential_idx").on(
      t.workspaceId,
      t.provider,
      t.credentialFingerprint,
    ),
  ],
);

export const oauthCredentials = createTable(
  "oauth_credential",
  {
    id: uuid().primaryKey().defaultRandom(),
    connectionId: uuid()
      .notNull()
      .references(() => providerConnections.id, { onDelete: "cascade" })
      .unique(),
    encryptedAccessToken: text().notNull(),
    encryptedRefreshToken: text(),
    expiresAt: timestamp({ withTimezone: true }),
    refreshVersion: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("oauth_expiry_idx").on(t.expiresAt)],
);

export const providerPatCredentials = createTable("provider_pat_credential", {
  connectionId: uuid()
    .primaryKey()
    .references(() => providerConnections.id, { onDelete: "cascade" }),
  encryptedToken: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const oauthStates = createTable("oauth_state", {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid()
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  provider: providerEnum().notNull(),
  stateHash: varchar({ length: 64 }).notNull().unique(),
  encryptedVerifier: text(),
  redirectPath: text(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  consumedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const webhookDeliveries = createTable(
  "webhook_delivery",
  {
    id: uuid().primaryKey().defaultRandom(),
    provider: providerEnum().notNull(),
    deliveryId: varchar({ length: 255 }).notNull(),
    event: varchar({ length: 120 }).notNull(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    status: varchar({ length: 24 }).notNull().default("received"),
    error: text(),
  },
  (t) => [
    uniqueIndex("webhook_delivery_provider_idx").on(t.provider, t.deliveryId),
    index("webhook_delivery_expiry_idx").on(t.expiresAt),
  ],
);

export const repositories = createTable(
  "repository",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: uuid()
      .notNull()
      .references(() => providerConnections.id, {
        onDelete: "cascade",
      }),
    externalId: text().notNull(),
    owner: varchar({ length: 255 }).notNull(),
    name: varchar({ length: 255 }).notNull(),
    defaultBranch: varchar({ length: 255 }).notNull(),
    webUrl: text().notNull(),
    isPrivate: boolean().notNull().default(true),
    reviewIntakeMode: repositoryIntakeModeEnum().notNull().default("manual"),
    intakeLastAttemptAt: timestamp({ withTimezone: true }),
    intakeLastReconciledAt: timestamp({ withTimezone: true }),
    intakeLastError: text(),
    intakeOwnerId: text().references(() => users.id, {
      onDelete: "set null",
    }),
    pullRequestStateLastCheckedAt: timestamp({ withTimezone: true }),
    pullRequestStateLastError: text(),
    sourceRetentionDays: integer().notNull().default(30),
    sourceRetentionSnapshots: integer().notNull().default(5),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("repository_external_idx").on(
      t.workspaceId,
      t.connectionId,
      t.externalId,
    ),
  ],
);

export const pullRequests = createTable(
  "pull_request",
  {
    id: uuid().primaryKey().defaultRandom(),
    repositoryId: uuid()
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    externalId: text().notNull(),
    number: integer().notNull(),
    title: text().notNull(),
    description: text(),
    authorLogin: varchar({ length: 255 }).notNull(),
    authorAvatarUrl: text(),
    sourceBranch: varchar({ length: 255 }).notNull(),
    targetBranch: varchar({ length: 255 }).notNull(),
    headSha: varchar({ length: 64 }).notNull(),
    baseSha: varchar({ length: 64 }).notNull(),
    state: pullRequestStateEnum().notNull().default("open"),
    webUrl: text().notNull(),
    additions: integer().notNull().default(0),
    deletions: integer().notNull().default(0),
    changedFiles: integer().notNull().default(0),
    lastSyncedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("pull_request_external_idx").on(t.repositoryId, t.externalId),
    index("pull_request_state_idx").on(t.repositoryId, t.state),
  ],
);

export const reviewQueueItems = createTable(
  "review_queue_item",
  {
    pullRequestId: uuid()
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    state: reviewQueueStateEnum().notNull().default("active"),
    source: reviewQueueSourceEnum().notNull().default("manual"),
    removedAt: timestamp({ withTimezone: true }),
    removedHeadSha: varchar({ length: 64 }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.pullRequestId, t.userId] }),
    index("review_queue_user_state_idx").on(t.userId, t.state, t.updatedAt),
  ],
);

export const reviewSnapshots = createTable(
  "review_snapshot",
  {
    id: uuid().primaryKey().defaultRandom(),
    pullRequestId: uuid()
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    headSha: varchar({ length: 64 }).notNull(),
    baseSha: varchar({ length: 64 }).notNull(),
    version: integer().notNull(),
    analysisVersion: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("snapshot_version_idx").on(t.pullRequestId, t.version)],
);

export const sourceBlobs = createTable(
  "source_blob",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    digest: varchar({ length: 64 }).notNull(),
    storage: sourceStorageEnum().notNull(),
    state: sourceBlobStateEnum().notNull().default("uploading"),
    objectKey: text(),
    customId: text(),
    byteLength: integer().notNull(),
    mediaType: varchar({ length: 160 })
      .notNull()
      .default("application/octet-stream"),
    encoding: varchar({ length: 32 }).notNull().default("utf-8"),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("source_blob_digest_idx").on(t.workspaceId, t.digest),
    index("source_blob_state_idx").on(t.state, t.updatedAt),
  ],
);

export const snapshotFiles = createTable(
  "snapshot_file",
  {
    id: uuid().primaryKey().defaultRandom(),
    snapshotId: uuid()
      .notNull()
      .references(() => reviewSnapshots.id, { onDelete: "cascade" }),
    path: text().notNull(),
    previousPath: text(),
    language: varchar({ length: 32 }).notNull(),
    changeType: sourceChangeTypeEnum().notNull(),
    currentBlobId: uuid().references(() => sourceBlobs.id, {
      onDelete: "restrict",
    }),
    previousBlobId: uuid().references(() => sourceBlobs.id, {
      onDelete: "restrict",
    }),
    additions: integer().notNull().default(0),
    deletions: integer().notNull().default(0),
    isBinary: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("snapshot_file_path_idx").on(t.snapshotId, t.path),
    index("snapshot_file_current_blob_idx").on(t.currentBlobId),
    index("snapshot_file_previous_blob_idx").on(t.previousBlobId),
  ],
);

export const reviewUnits = createTable(
  "review_unit",
  {
    id: uuid().primaryKey().defaultRandom(),
    snapshotId: uuid()
      .notNull()
      .references(() => reviewSnapshots.id, { onDelete: "cascade" }),
    snapshotFileId: uuid().references(() => snapshotFiles.id, {
      onDelete: "cascade",
    }),
    currentBlobId: uuid().references(() => sourceBlobs.id, {
      onDelete: "restrict",
    }),
    previousBlobId: uuid().references(() => sourceBlobs.id, {
      onDelete: "restrict",
    }),
    stableKey: text().notNull(),
    path: text().notNull(),
    language: varchar({ length: 32 }).notNull(),
    kind: symbolKindEnum().notNull(),
    name: text().notNull(),
    signature: text(),
    startLine: integer().notNull(),
    endLine: integer().notNull(),
    startByte: integer().notNull().default(0),
    endByte: integer().notNull().default(0),
    previousStartByte: integer(),
    previousEndByte: integer(),
    relatedRanges:
      jsonb().$type<
        Array<{
          startLine?: number;
          endLine?: number;
          previousStartLine?: number;
          previousEndLine?: number;
        }>
      >(),
    contentHash: varchar({ length: 64 }).notNull(),
    semanticHash: varchar({ length: 64 }).notNull(),
    changeType: sourceChangeTypeEnum().notNull().default("modified"),
    depth: integer().notNull().default(0),
    reviewOrder: integer().notNull(),
    complexity: integer().notNull().default(1),
    requiresReReview: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("review_unit_key_idx").on(t.snapshotId, t.stableKey),
    index("review_order_idx").on(t.snapshotId, t.reviewOrder),
  ],
);

export const reviewUnitDependencies = createTable(
  "review_unit_dependency",
  {
    unitId: uuid()
      .notNull()
      .references(() => reviewUnits.id, { onDelete: "cascade" }),
    dependencyId: uuid()
      .notNull()
      .references(() => reviewUnits.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.unitId, t.dependencyId] })],
);

export const signOffs = createTable(
  "sign_off",
  {
    id: uuid().primaryKey().defaultRandom(),
    unitId: uuid()
      .notNull()
      .references(() => reviewUnits.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    semanticHash: varchar({ length: 64 }).notNull(),
    note: text(),
    durationSeconds: integer().notNull().default(0),
    signedOffAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    invalidatedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("sign_off_unit_user_idx").on(t.unitId, t.userId),
    index("sign_off_user_date_idx").on(t.userId, t.signedOffAt),
  ],
);

export const aiPreferences = createTable("ai_preference", {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid()
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" })
    .unique(),
  selectedModel: varchar({ length: 255 }).notNull().default("big-pickle"),
  mode: aiModeEnum().notNull().default("on_demand"),
  reviewPullRequests: boolean().notNull().default(false),
  freeProviderDisclosureVersion: varchar({ length: 64 }),
  freeProviderDisclosureAcceptedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const localAiConfigurations = createTable("local_ai_configuration", {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid()
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" })
    .unique(),
  provider: varchar({ length: 48 }).notNull(),
  model: varchar({ length: 160 }).notNull(),
  encryptedConfiguration: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const managedAiCredentials = createTable(
  "managed_ai_credential",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: varchar({ length: 48 }).notNull(),
    providerKeyId: text().notNull(),
    encryptedCredential: text().notNull(),
    monthlyLimitMicroUsd: bigint({ mode: "number" }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("managed_ai_credential_workspace_provider_idx").on(
      t.workspaceId,
      t.provider,
    ),
  ],
);

export const managedAiModels = createTable("managed_ai_model", {
  modelId: varchar({ length: 255 }).primaryKey(),
  name: varchar({ length: 255 }).notNull(),
  contextLength: integer().notNull(),
  promptNanoUsdPerToken: bigint({ mode: "number" }).notNull(),
  completionNanoUsdPerToken: bigint({ mode: "number" }).notNull(),
  supportsTools: boolean().notNull(),
  synchronizedAt: timestamp({ withTimezone: true }).notNull(),
});

export const workflowRuns = createTable(
  "workflow_run",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    providerRunId: text().notNull().unique(),
    kind: varchar({ length: 48 }).notNull(),
    status: workflowRunStatusEnum().notNull().default("queued"),
    targetId: uuid(),
    deploymentId: text(),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index("workflow_run_target_idx").on(t.kind, t.targetId, t.createdAt)],
);

export const syncRuns = createTable(
  "sync_run",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repositoryId: uuid()
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    pullRequestNumber: integer().notNull(),
    workflowRunId: uuid().references(() => workflowRuns.id, {
      onDelete: "set null",
    }),
    status: workflowRunStatusEnum().notNull().default("queued"),
    progress: integer().notNull().default(0),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("sync_run_repository_idx").on(
      t.repositoryId,
      t.pullRequestNumber,
      t.createdAt,
    ),
  ],
);

export const syncQueueRequests = createTable(
  "sync_queue_request",
  {
    syncRunId: uuid()
      .notNull()
      .references(() => syncRuns.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: reviewQueueSourceEnum().notNull(),
    explicit: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.syncRunId, t.userId] })],
);

export const aiJobs = createTable(
  "ai_job",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    pullRequestId: uuid()
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    snapshotId: uuid()
      .notNull()
      .references(() => reviewSnapshots.id, { onDelete: "cascade" }),
    unitId: uuid().references(() => reviewUnits.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: aiJobKindEnum().notNull(),
    question: text(),
    focusLine: integer(),
    threadId: uuid(),
    agentVersion: integer().notNull().default(1),
    status: aiJobStatusEnum().notNull().default("queued"),
    workflowRunId: uuid().references(() => workflowRuns.id, {
      onDelete: "set null",
    }),
    progress: integer().notNull().default(0),
    completionReason: aiCompletionReasonEnum(),
    model: varchar({ length: 255 }),
    provider: varchar({ length: 64 }),
    result: jsonb().$type<{
      summary: string;
      commentProposals?: Array<{
        body: string;
        path: string;
        line: number;
      }>;
      annotations: Array<{
        title: string;
        body: string;
        path: string;
        line: number;
        endLine?: number;
      }>;
      findings: Array<{
        severity: "info" | "warning" | "critical";
        title: string;
        body: string;
        path?: string;
        line?: number;
      }>;
    }>(),
    error: text(),
    reservedInputTokens: integer().notNull().default(0),
    reservedOutputTokens: integer().notNull().default(0),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    cacheReadTokens: integer().notNull().default(0),
    cacheWriteTokens: integer().notNull().default(0),
    totalTokens: integer().notNull().default(0),
    reservedMicroUsd: bigint({ mode: "number" }).notNull().default(0),
    actualMicroUsd: bigint({ mode: "number" }).notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    cancelledAt: timestamp({ withTimezone: true }),
    quotaSettledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check(
      "ai_job_question_context_check",
      sql`(
        (${t.question} is null and ${t.focusLine} is null and ${t.threadId} is null)
        or
        (${t.question} is not null and ${t.focusLine} is not null and ${t.threadId} is not null)
      )`,
    ),
    index("ai_job_review_lookup_idx").on(
      t.pullRequestId,
      t.snapshotId,
      t.userId,
      t.kind,
      t.createdAt,
    ),
  ],
);

export const aiJobTurns = createTable(
  "ai_job_turn",
  {
    id: uuid().primaryKey().defaultRandom(),
    jobId: uuid()
      .notNull()
      .references(() => aiJobs.id, { onDelete: "cascade" }),
    sequence: integer().notNull(),
    role: varchar({ length: 16 }).notNull(),
    encryptedContent: text().notNull(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ai_job_turn_sequence_idx").on(t.jobId, t.sequence)],
);

export const aiJobToolCalls = createTable(
  "ai_job_tool_call",
  {
    id: uuid().primaryKey().defaultRandom(),
    jobId: uuid()
      .notNull()
      .references(() => aiJobs.id, { onDelete: "cascade" }),
    turnSequence: integer().notNull(),
    toolCallId: varchar({ length: 255 }).notNull(),
    toolName: varchar({ length: 80 }).notNull(),
    encryptedInput: text().notNull(),
    encryptedOutput: text(),
    status: varchar({ length: 24 }).notNull().default("running"),
    durationMs: integer(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ai_job_tool_call_id_idx").on(t.jobId, t.toolCallId),
    index("ai_job_tool_turn_idx").on(t.jobId, t.turnSequence),
  ],
);

export const aiJobEvidence = createTable(
  "ai_job_evidence",
  {
    id: uuid().primaryKey().defaultRandom(),
    jobId: uuid()
      .notNull()
      .references(() => aiJobs.id, { onDelete: "cascade" }),
    snapshotFileId: uuid().references(() => snapshotFiles.id, {
      onDelete: "cascade",
    }),
    sourceBlobId: uuid()
      .notNull()
      .references(() => sourceBlobs.id, { onDelete: "restrict" }),
    path: text().notNull(),
    digest: varchar({ length: 64 }).notNull(),
    startByte: integer().notNull(),
    endByte: integer().notNull(),
    startLine: integer().notNull(),
    endLine: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_job_evidence_range_idx").on(
      t.jobId,
      t.sourceBlobId,
      t.startByte,
      t.endByte,
    ),
    index("ai_job_evidence_path_idx").on(t.jobId, t.path),
  ],
);

export const aiJobChunks = createTable(
  "ai_job_chunk",
  {
    id: uuid().primaryKey().defaultRandom(),
    jobId: uuid()
      .notNull()
      .references(() => aiJobs.id, { onDelete: "cascade" }),
    sequence: integer().notNull(),
    kind: varchar({ length: 24 }).notNull(),
    encryptedContent: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ai_job_chunk_sequence_idx").on(t.jobId, t.sequence)],
);

export const aiUsageLedger = createTable(
  "ai_usage_ledger",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    jobId: uuid().references(() => aiJobs.id, { onDelete: "set null" }),
    month: varchar({ length: 7 }).notNull(),
    kind: varchar({ length: 24 }).notNull(),
    microUsd: bigint({ mode: "number" }).notNull(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    providerReference: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_usage_ledger_job_kind_idx").on(t.jobId, t.kind),
    index("ai_usage_ledger_workspace_month_idx").on(t.workspaceId, t.month),
  ],
);

export const semanticArtifacts = createTable(
  "semantic_artifact",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repositoryId: uuid()
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    commitSha: varchar({ length: 64 }).notNull(),
    digest: varchar({ length: 64 }).notNull(),
    sourceBlobId: uuid()
      .notNull()
      .references(() => sourceBlobs.id, { onDelete: "restrict" }),
    status: semanticArtifactStatusEnum().notNull().default("uploading"),
    byteLength: integer().notNull(),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    validatedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex("semantic_artifact_revision_idx").on(
      t.repositoryId,
      t.commitSha,
    ),
  ],
);

export const semanticUploadCredentials = createTable(
  "semantic_upload_credential",
  {
    id: uuid().primaryKey().defaultRandom(),
    repositoryId: uuid()
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    tokenHash: text().notNull(),
    label: varchar({ length: 160 }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index("semantic_upload_repository_idx").on(t.repositoryId)],
);

export const reviewComments = createTable(
  "review_comment",
  {
    id: uuid().primaryKey().defaultRandom(),
    unitId: uuid()
      .notNull()
      .references(() => reviewUnits.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    aiJobId: uuid().references(() => aiJobs.id, { onDelete: "set null" }),
    aiFindingIndex: integer(),
    source: reviewCommentSourceEnum().notNull(),
    body: text().notNull(),
    line: integer().notNull(),
    status: reviewCommentStatusEnum().notNull().default("publishing"),
    providerExternalId: text(),
    error: text(),
    publishedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("review_comment_unit_idx").on(t.unitId, t.createdAt),
    uniqueIndex("review_comment_ai_finding_idx").on(
      t.aiJobId,
      t.aiFindingIndex,
    ),
  ],
);

export const reviewWaits = createTable(
  "review_wait",
  {
    id: uuid().primaryKey().defaultRandom(),
    unitId: uuid()
      .notNull()
      .references(() => reviewUnits.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerThreadIds: jsonb()
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    observedCommentIds: jsonb()
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    waitingSince: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("review_wait_unit_user_idx").on(t.unitId, t.userId),
    index("review_wait_user_date_idx").on(t.userId, t.waitingSince),
  ],
);

export const aiUsage = createTable(
  "ai_usage",
  {
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: timestamp({ withTimezone: true }).notNull(),
    requests: integer().notNull().default(0),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    reservedInputTokens: integer().notNull().default(0),
    reservedOutputTokens: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId, t.day] })],
);

export const reviewSessions = createTable(
  "review_session",
  {
    id: uuid().primaryKey().defaultRandom(),
    pullRequestId: uuid()
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    snapshotId: uuid()
      .notNull()
      .references(() => reviewSnapshots.id, { onDelete: "cascade" }),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
    reviewedUnits: integer().notNull().default(0),
    experienceAwarded: integer().notNull().default(0),
  },
  (t) => [
    index("review_session_active_idx").on(
      t.pullRequestId,
      t.snapshotId,
      t.userId,
      t.completedAt,
    ),
  ],
);

export const rateLimits = createTable("rate_limit", {
  key: varchar({ length: 255 }).primaryKey(),
  count: integer().notNull().default(0),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
});

export const pullRequestRelations = relations(
  pullRequests,
  ({ one, many }) => ({
    repository: one(repositories, {
      fields: [pullRequests.repositoryId],
      references: [repositories.id],
    }),
    snapshots: many(reviewSnapshots),
  }),
);
export const workspaceMemberRelations = relations(
  workspaceMembers,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [workspaceMembers.workspaceId],
      references: [workspaces.id],
    }),
    user: one(users, {
      fields: [workspaceMembers.userId],
      references: [users.id],
    }),
  }),
);
export const snapshotRelations = relations(
  reviewSnapshots,
  ({ one, many }) => ({
    pullRequest: one(pullRequests, {
      fields: [reviewSnapshots.pullRequestId],
      references: [pullRequests.id],
    }),
    units: many(reviewUnits),
  }),
);
export const unitRelations = relations(reviewUnits, ({ one, many }) => ({
  snapshot: one(reviewSnapshots, {
    fields: [reviewUnits.snapshotId],
    references: [reviewSnapshots.id],
  }),
  signOffs: many(signOffs),
  waits: many(reviewWaits),
}));

/** Creates a SQL expression used to atomically increment a numeric column. */
export const increment = (value: number) => sql`${value}`;
