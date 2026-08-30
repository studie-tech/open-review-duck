import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
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
export const aiJobKindEnum = pgEnum("ai_job_kind", [
  "explain",
  "review",
  "review_file",
  "review_survey",
  "semantic_cluster",
]);
export const reviewConceptLayoutSourceEnum = pgEnum(
  "review_concept_layout_source",
  ["deterministic", "manual", "ai"],
);
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
  "deep_review_partial",
  "deep_review_skipped",
]);

// The finding taxonomy is adopted from alibaba/open-code-review, whose vendored
// rulebooks are written against exactly these severities and categories. Storing
// anything narrower would need a lossy translation between what a rulebook
// instructs and what a finding records.
export const findingSeverityEnum = pgEnum("finding_severity", [
  "critical",
  "high",
  "medium",
  "low",
]);
export const findingCategoryEnum = pgEnum("finding_category", [
  "bug",
  "security",
  "performance",
  "maintainability",
  "test",
  "style",
  "documentation",
  "other",
]);
export const deepReviewItemStateEnum = pgEnum("deep_review_item_state", [
  "selected",
  "completed",
  "reused",
  "failed",
  "waived",
]);
export const reviewFailureClassEnum = pgEnum("review_failure_class", [
  "provider",
  "timeout",
  "budget",
  "cancelled",
  "tool_limit",
  "unknown",
]);
export const deepReviewTerminalStateEnum = pgEnum(
  "deep_review_terminal_state",
  ["complete", "partial", "failed", "skipped"],
);
export const deepReviewFindingStateEnum = pgEnum("deep_review_finding_state", [
  "submitted",
  "anchored",
  "unanchored",
  "out_of_scope",
  "ungrounded",
  "refuted",
  "merged",
  "dropped",
]);
export const deepReviewVerdictEnum = pgEnum("deep_review_verdict", [
  "unverified",
  "not_refuted",
  "refuted",
]);
export const anchorTierEnum = pgEnum("anchor_tier", [
  "unit_current",
  "changed_current",
  "file_current",
  "file_previous",
  "relocated",
  "ambiguous",
  "none",
]);
export const anchorSideEnum = pgEnum("anchor_side", ["current", "previous"]);
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
  isAdmin: boolean().notNull().default(false),
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
    credentialStatus: varchar({ length: 24 }).notNull().default("active"),
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
    uniqueIndex("github_app_installation_idx").on(t.installationId),
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

export const providerWebhooks = createTable(
  "provider_webhook",
  {
    id: uuid().primaryKey().defaultRandom(),
    repositoryId: uuid()
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" })
      .unique(),
    provider: providerEnum().notNull(),
    encryptedSecret: text().notNull(),
    remoteHookIds: jsonb()
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("provider_webhook_provider_idx").on(t.provider)],
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
    /**
     * Every sync, webhook delivery and queue join looks a pull request up by
     * its provider number. The pair is not unique because each monitored
     * repository branch stores a synthetic pull request numbered zero.
     */
    index("pull_request_number_idx").on(t.repositoryId, t.number),
  ],
);

/** One long-lived repository branch the workspace keeps prepared for review. */
export const repositoryBranchMonitors = createTable(
  "repository_branch_monitor",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repositoryId: uuid()
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    /** The local review subject backed by the normal snapshot and sign-off machinery. */
    pullRequestId: uuid()
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" })
      .unique(),
    branch: varchar({ length: 255 }).notNull(),
    currentHeadSha: varchar({ length: 64 }),
    lastCheckedAt: timestamp({ withTimezone: true }),
    lastSyncedAt: timestamp({ withTimezone: true }),
    lastError: text(),
    createdBy: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check(
      "repository_branch_monitor_branch_check",
      sql`length(btrim(${t.branch})) > 0`,
    ),
    uniqueIndex("repository_branch_monitor_target_idx").on(
      t.repositoryId,
      t.branch,
    ),
    index("repository_branch_monitor_workspace_idx").on(
      t.workspaceId,
      t.updatedAt,
    ),
  ],
);

/** A versioned natural-language convention assigned to one monitored branch. */
export const repositoryReviewRules = createTable(
  "repository_review_rule",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    monitorId: uuid()
      .notNull()
      .references(() => repositoryBranchMonitors.id, { onDelete: "cascade" }),
    title: varchar({ length: 200 }).notNull(),
    instruction: text().notNull(),
    pathGlob: varchar({ length: 500 }).notNull().default("**/*"),
    scope: varchar({ length: 24 }).notNull().default("file"),
    severity: findingSeverityEnum().notNull().default("medium"),
    enabled: boolean().notNull().default(true),
    version: integer().notNull().default(1),
    archivedAt: timestamp({ withTimezone: true }),
    createdBy: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check(
      "repository_review_rule_content_check",
      sql`length(btrim(${t.title})) > 0 and length(btrim(${t.instruction})) > 0 and length(btrim(${t.pathGlob})) > 0`,
    ),
    check(
      "repository_review_rule_scope_check",
      sql`${t.scope} in ('file', 'repository')`,
    ),
    check("repository_review_rule_version_check", sql`${t.version} > 0`),
    index("repository_review_rule_monitor_idx").on(
      t.monitorId,
      t.archivedAt,
      t.updatedAt,
    ),
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
    uploadLeaseToken: uuid(),
    uploadLeaseExpiresAt: timestamp({ withTimezone: true }),
    deletionLeaseToken: uuid(),
    deletionLeaseExpiresAt: timestamp({ withTimezone: true }),
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
    skipReason: varchar({ length: 32 }),
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
    changedLineCount: integer().notNull().default(1),
    requiresReReview: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("review_unit_key_idx").on(t.snapshotId, t.stableKey),
    // Membership reaches a unit through the snapshot it claims, so the pair
    // that identifies a unit inside its snapshot has to be referenceable.
    uniqueIndex("review_unit_scope_idx").on(t.id, t.snapshotId),
    index("review_order_idx").on(t.snapshotId, t.reviewOrder),
    // Symbol peeks and unit selection ask for the units of one path, and a
    // snapshot holds thousands, so the path has to be seekable next to the
    // snapshot rather than filtered out of every row.
    index("review_unit_path_idx").on(t.snapshotId, t.path),
    // Snapshot pruning cascades from snapshot_file, and source-blob collection
    // has to prove no unit still references a blob. Without these the referential
    // triggers scan the whole unit table once per parent row.
    index("review_unit_snapshot_file_idx").on(t.snapshotFileId),
    index("review_unit_current_blob_idx").on(t.currentBlobId),
    index("review_unit_previous_blob_idx").on(t.previousBlobId),
  ],
);

export const reviewConceptLayouts = createTable(
  "review_concept_layout",
  {
    id: uuid().primaryKey().defaultRandom(),
    snapshotId: uuid()
      .notNull()
      .references(() => reviewSnapshots.id, { onDelete: "cascade" }),
    userId: text().references(() => users.id, { onDelete: "cascade" }),
    source: reviewConceptLayoutSourceEnum().notNull(),
    version: integer().notNull().default(1),
    lockedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("review_concept_baseline_idx")
      .on(t.snapshotId)
      .where(sql`${t.userId} is null`),
    uniqueIndex("review_concept_personal_idx")
      .on(t.snapshotId, t.userId)
      .where(sql`${t.userId} is not null`),
    // Membership carries the snapshot as well, and that copy is only
    // trustworthy if it can be tied back to the layout.
    uniqueIndex("review_concept_layout_scope_idx").on(t.id, t.snapshotId),
  ],
);

export const reviewConcepts = createTable(
  "review_concept",
  {
    id: uuid().primaryKey().defaultRandom(),
    layoutId: uuid()
      .notNull()
      .references(() => reviewConceptLayouts.id, { onDelete: "cascade" }),
    stableKey: text().notNull(),
    title: text().notNull(),
    rationale: text(),
    reviewOrder: integer().notNull(),
    changedLineCount: integer().notNull(),
    fileCount: integer().notNull(),
    oversized: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("review_concept_key_idx").on(t.layoutId, t.stableKey),
    uniqueIndex("review_concept_order_idx").on(t.layoutId, t.reviewOrder),
    // Membership carries its own layoutId so one unit can be unique per layout.
    // That copy is only trustworthy if it can be tied back to the concept, which
    // needs the pair to be referenceable.
    uniqueIndex("review_concept_scope_idx").on(t.id, t.layoutId),
  ],
);

export const reviewConceptMembers = createTable(
  "review_concept_member",
  {
    layoutId: uuid()
      .notNull()
      .references(() => reviewConceptLayouts.id, { onDelete: "cascade" }),
    conceptId: uuid().notNull(),
    unitId: uuid().notNull(),
    // A layout partitions one snapshot's units. Carrying the snapshot lets
    // both the layout and the unit be reached through it, so a membership
    // cannot place a unit from one revision into a layout of another.
    snapshotId: uuid()
      .notNull()
      .references(() => reviewSnapshots.id, { onDelete: "cascade" }),
    memberOrder: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.conceptId, t.unitId] }),
    uniqueIndex("review_concept_membership_idx").on(t.layoutId, t.unitId),
    index("review_concept_member_order_idx").on(t.conceptId, t.memberOrder),
    // Deleting a unit filters on unitId alone, which the layoutId-leading
    // membership index cannot serve.
    index("review_concept_member_unit_idx").on(t.unitId),
    // Membership is the largest child of a snapshot, and snapshot pruning runs
    // inside every sync. No other index leads with snapshotId, so the cascade
    // would scan the whole table once per pruned snapshot.
    index("review_concept_member_snapshot_idx").on(t.snapshotId),
    // Reaching the concept through the layout the row already claims keeps the
    // membership uniqueness above from being enforced against the wrong layout.
    foreignKey({
      columns: [t.conceptId, t.layoutId],
      foreignColumns: [reviewConcepts.id, reviewConcepts.layoutId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.layoutId, t.snapshotId],
      foreignColumns: [
        reviewConceptLayouts.id,
        reviewConceptLayouts.snapshotId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.unitId, t.snapshotId],
      foreignColumns: [reviewUnits.id, reviewUnits.snapshotId],
    }).onDelete("cascade"),
  ],
);

export const reviewConceptDependencies = createTable(
  "review_concept_dependency",
  {
    // An edge belongs to one layout, and carrying it lets both endpoints be
    // reached through the pair the concept is unique on. Without it the two
    // ends are only known to be concepts, and an edge could join a concept of
    // one layout to a concept of another.
    layoutId: uuid()
      .notNull()
      .references(() => reviewConceptLayouts.id, { onDelete: "cascade" }),
    conceptId: uuid().notNull(),
    dependencyId: uuid().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.conceptId, t.dependencyId] }),
    // The primary key only covers the dependent side of the edge, so the
    // dependency side needs its own index for cascading concept deletes.
    index("review_concept_dependency_dependency_idx").on(t.dependencyId),
    foreignKey({
      columns: [t.conceptId, t.layoutId],
      foreignColumns: [reviewConcepts.id, reviewConcepts.layoutId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.dependencyId, t.layoutId],
      foreignColumns: [reviewConcepts.id, reviewConcepts.layoutId],
    }).onDelete("cascade"),
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
  (t) => [
    primaryKey({ columns: [t.unitId, t.dependencyId] }),
    // The primary key only covers the dependent side of the edge, so the
    // dependency side needs its own index for cascading unit deletes.
    index("review_unit_dependency_dependency_idx").on(t.dependencyId),
  ],
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

export const aiPrompts = createTable("ai_prompt", {
  key: varchar({ length: 128 }).primaryKey(),
  body: text().notNull(),
  updatedByUserId: text().references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const aiPreferences = createTable("ai_preference", {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid()
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" })
    .unique(),
  selectedModel: varchar({ length: 255 }).notNull().default(""),
  mode: aiModeEnum().notNull().default("on_demand"),
  reviewPullRequests: boolean().notNull().default(false),
  maxReviewTokens: integer(),
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

/** One durable synchronization of a monitored repository branch. */
export const repositoryBranchSyncRuns = createTable(
  "repository_branch_sync_run",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    monitorId: uuid()
      .notNull()
      .references(() => repositoryBranchMonitors.id, { onDelete: "cascade" }),
    workflowRunId: uuid().references(() => workflowRuns.id, {
      onDelete: "set null",
    }),
    status: workflowRunStatusEnum().notNull().default("queued"),
    progress: integer().notNull().default(0),
    force: boolean().notNull().default(false),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("repository_branch_sync_monitor_idx").on(
      t.monitorId,
      t.status,
      t.createdAt,
    ),
    index("repository_branch_sync_workspace_idx").on(
      t.workspaceId,
      t.status,
      t.createdAt,
    ),
  ],
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
    // Dashboards poll for the workspace's queued and running runs, which
    // otherwise scans the whole run history on every poll.
    index("sync_run_workspace_idx").on(t.workspaceId, t.status, t.createdAt),
    // The recent-failure poll constrains a createdAt window without a status,
    // so it needs createdAt adjacent to the workspace to seek the window in
    // order and stop at the limit rather than sorting the matches.
    index("sync_run_workspace_recent_idx").on(
      t.workspaceId,
      t.createdAt.desc(),
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
    /**
     * The concept layout a clustering run proposes for, as `<id>:<version>`.
     *
     * `question`, `focusLine`, and `threadId` describe reviewer conversations;
     * clustering jobs keep their independent layout identity here.
     */
    layoutKey: text(),
    /**
     * The deep-review parent this job belongs to, null on the parent itself.
     *
     * Partitioning the four durability tables by jobId already isolates each
     * child transcript, so a child needs no sequence banding of its own.
     */
    parentJobId: uuid(),
    ruleConfigDigest: varchar({ length: 64 }),
    /** Whether this run reviews a PR delta or an entire repository snapshot. */
    reviewScope: varchar({ length: 32 }).notNull().default("pull_request"),
    /** Separates general defect discovery from user-authored compliance rules. */
    reviewPurpose: varchar({ length: 24 }).notNull().default("code"),
    /** Immutable rule copies keep compliance history meaningful after edits. */
    reviewRules:
      jsonb().$type<
        Array<{
          id: string;
          version: number;
          title: string;
          instruction: string;
          pathGlob: string;
          scope: "file" | "repository";
          severity: "critical" | "high" | "medium" | "low";
        }>
      >(),
    deepReviewTerminalState: deepReviewTerminalStateEnum(),
    runFailureClass: reviewFailureClassEnum(),
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
      concepts?: Array<{
        title: string;
        rationale: string;
        memberUnitIds: string[];
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
      "ai_job_review_scope_check",
      sql`${t.reviewScope} in ('pull_request', 'repository_snapshot')`,
    ),
    check(
      "ai_job_review_purpose_check",
      sql`${t.reviewPurpose} in ('code', 'compliance')`,
    ),
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
    // The review lookup index leads with pullRequestId, so snapshot pruning could
    // not use it and scanned every job row for each unit it removed.
    index("ai_job_unit_idx").on(t.unitId),
    index("ai_job_snapshot_idx").on(t.snapshotId),
    foreignKey({
      columns: [t.parentJobId],
      foreignColumns: [t.id],
      name: "ai_job_parent_fk",
    }).onDelete("cascade"),
    index("ai_job_parent_idx").on(t.parentJobId),
    // A coverage item carries the parent it belongs to and names the child that
    // reviews it. That pair is only checkable if the run a child belongs to can
    // be reached through the child itself.
    uniqueIndex("ai_job_parent_scope_idx").on(t.id, t.parentJobId),
  ],
);

export const aiStreamLeases = createTable(
  "ai_stream_lease",
  {
    id: uuid().primaryKey().defaultRandom(),
    jobId: uuid()
      .notNull()
      .references(() => aiJobs.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_stream_lease_user_idx").on(t.userId, t.expiresAt),
    index("ai_stream_lease_expiry_idx").on(t.expiresAt),
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
    // A finding grounds itself on the ranges its own agent read, so the job a
    // range was recorded under has to be reachable through the range itself.
    uniqueIndex("ai_job_evidence_job_scope_idx").on(t.id, t.jobId),
  ],
);

/**
 * The sealed coverage denominator: one row per file the run committed to
 * reviewing, written before any concurrency exists.
 *
 * Freezing the set up front is what lets a run report `partial` truthfully. A
 * denominator that could still grow while agents were running would make every
 * completeness claim a guess.
 */
export const aiReviewItems = createTable(
  "ai_review_item",
  {
    id: uuid().primaryKey().defaultRandom(),
    parentJobId: uuid()
      .notNull()
      .references(() => aiJobs.id, { onDelete: "cascade" }),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    childJobId: uuid().references(() => aiJobs.id, { onDelete: "set null" }),
    path: text().notNull(),
    changeType: varchar({ length: 24 }).notNull(),
    changedLineCount: integer().notNull().default(0),
    state: deepReviewItemStateEnum().notNull().default("selected"),
    failureClass: reviewFailureClassEnum(),
    reason: text(),
    fingerprint: varchar({ length: 64 }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("ai_review_item_path_idx").on(t.parentJobId, t.path),
    index("ai_review_item_reuse_idx").on(t.workspaceId, t.fingerprint),
    index("ai_review_item_state_idx").on(t.parentJobId, t.state),
    // Reaching the child job through the parent the item already claims is what
    // keeps a run's denominator its own: an item cannot hand its file to an
    // agent running under a different review. A waived item names no child, and
    // MATCH SIMPLE leaves a pair with a null in it unchecked, so only an item
    // that actually claims an agent is held to the run it belongs to.
    foreignKey({
      columns: [t.childJobId, t.parentJobId],
      foreignColumns: [aiJobs.id, aiJobs.parentJobId],
    }).onDelete("cascade"),
    // A finding names the job that produced it, and that claim is only
    // trustworthy if the item's own agent can be reached through the pair.
    uniqueIndex("ai_review_item_child_scope_idx").on(t.id, t.childJobId),
  ],
);

/**
 * One reported finding, retained whatever becomes of it.
 *
 * A refuted or ungrounded finding keeps its row so a discard stays auditable
 * rather than silently vanishing. Content is vault-sealed because
 * `existingCode` is a verbatim source excerpt, and every other column in this
 * schema holding model-visible repository content is sealed too.
 */
export const aiReviewFindings = createTable(
  "ai_review_finding",
  {
    id: varchar({ length: 64 }).primaryKey(),
    itemId: uuid()
      .notNull()
      .references(() => aiReviewItems.id, { onDelete: "cascade" }),
    jobId: uuid()
      .notNull()
      .references(() => aiJobs.id, { onDelete: "cascade" }),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Null for a cross-file survey finding, which names its locations in
    // ai_review_finding_location instead.
    path: text(),
    severity: findingSeverityEnum().notNull(),
    category: findingCategoryEnum().notNull(),
    encryptedContent: text().notNull(),
    state: deepReviewFindingStateEnum().notNull().default("submitted"),
    verdict: deepReviewVerdictEnum().notNull().default("unverified"),
    verdictReason: text(),
    anchorTier: anchorTierEnum(),
    anchorSide: anchorSideEnum(),
    startLine: integer(),
    endLine: integer(),
    anchorAmbiguous: boolean().notNull().default(false),
    unitId: uuid().references(() => reviewUnits.id, { onDelete: "set null" }),
    mergedIntoId: varchar({ length: 64 }),
    orderIndex: integer(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_review_finding_item_idx").on(t.itemId),
    index("ai_review_finding_job_idx").on(t.jobId),
    index("ai_review_finding_state_idx").on(t.itemId, t.state),
    foreignKey({
      columns: [t.mergedIntoId],
      foreignColumns: [t.id],
      name: "ai_review_finding_merged_fk",
    }).onDelete("set null"),
    // A finding is only as trustworthy as the agent that reported it, so the
    // job it names has to be the very agent its item claims. Reaching the item
    // through that pair is what stops one file's agent from filing against
    // another file, and stops a finding from outliving the item's agent.
    foreignKey({
      columns: [t.itemId, t.jobId],
      foreignColumns: [aiReviewItems.id, aiReviewItems.childJobId],
    }).onDelete("cascade"),
    // Evidence links carry the job as well, and that copy is only trustworthy
    // if it can be tied back to the finding.
    uniqueIndex("ai_review_finding_job_scope_idx").on(t.id, t.jobId),
  ],
);

/**
 * The per-file locations of a cross-file finding.
 *
 * A survey finding spans files by construction, so it anchors once per named
 * location and surfaces on the first that resolves. `position` preserves the
 * order the model named them in, which decides which location resolves first
 * and therefore where the finding surfaces.
 */
export const aiReviewFindingLocations = createTable(
  "ai_review_finding_location",
  {
    id: uuid().primaryKey().defaultRandom(),
    findingId: varchar({ length: 64 })
      .notNull()
      .references(() => aiReviewFindings.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    path: text().notNull(),
    encryptedExistingCode: text().notNull(),
    anchorTier: anchorTierEnum(),
    anchorSide: anchorSideEnum(),
    startLine: integer(),
    endLine: integer(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_review_finding_location_idx").on(t.findingId, t.position),
  ],
);

/** Ties a finding to the byte ranges its agent provably read. */
export const aiReviewFindingEvidence = createTable(
  "ai_review_finding_evidence",
  {
    findingId: varchar({ length: 64 }).notNull(),
    evidenceId: uuid().notNull(),
    // Grounding means one agent read the range it cites. Carrying the job lets
    // both ends be reached through it, so a link cannot ground a finding on
    // text a different agent read.
    jobId: uuid()
      .notNull()
      .references(() => aiJobs.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.findingId, t.evidenceId] }),
    index("ai_review_finding_evidence_idx").on(t.evidenceId),
    // The primary key leads with findingId and the other index covers evidence,
    // so neither serves a job delete: without this one the referential trigger
    // scans every link row for each job a snapshot prune removes.
    index("ai_review_finding_evidence_job_idx").on(t.jobId),
    foreignKey({
      columns: [t.findingId, t.jobId],
      foreignColumns: [aiReviewFindings.id, aiReviewFindings.jobId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.evidenceId, t.jobId],
      foreignColumns: [aiJobEvidence.id, aiJobEvidence.jobId],
    }).onDelete("cascade"),
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
    /**
     * The provider's identifier for this comment on its own.
     *
     * `providerExternalId` names the conversation a publication opened, which
     * is a discussion on GitLab and a thread on Azure DevOps rather than the
     * comment inside it. A reply opens no conversation, so this is what says
     * which reviewer wrote one, and what refuses another reviewer's edit.
     */
    providerCommentExternalId: text(),
    publicationLeaseToken: uuid(),
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
    // Every edit and delete asks who published one provider comment before
    // it touches it.
    index("review_comment_provider_comment_idx").on(
      t.unitId,
      t.providerCommentExternalId,
    ),
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
    conceptLayouts: many(reviewConceptLayouts),
  }),
);
export const unitRelations = relations(reviewUnits, ({ one, many }) => ({
  snapshot: one(reviewSnapshots, {
    fields: [reviewUnits.snapshotId],
    references: [reviewSnapshots.id],
  }),
  signOffs: many(signOffs),
  waits: many(reviewWaits),
  conceptMemberships: many(reviewConceptMembers),
}));

export const conceptLayoutRelations = relations(
  reviewConceptLayouts,
  ({ one, many }) => ({
    snapshot: one(reviewSnapshots, {
      fields: [reviewConceptLayouts.snapshotId],
      references: [reviewSnapshots.id],
    }),
    user: one(users, {
      fields: [reviewConceptLayouts.userId],
      references: [users.id],
    }),
    concepts: many(reviewConcepts),
  }),
);

export const conceptRelations = relations(reviewConcepts, ({ one, many }) => ({
  layout: one(reviewConceptLayouts, {
    fields: [reviewConcepts.layoutId],
    references: [reviewConceptLayouts.id],
  }),
  members: many(reviewConceptMembers),
  dependencies: many(reviewConceptDependencies, {
    relationName: "concept_dependencies",
  }),
  dependents: many(reviewConceptDependencies, {
    relationName: "concept_dependents",
  }),
}));

export const conceptDependencyRelations = relations(
  reviewConceptDependencies,
  ({ one }) => ({
    concept: one(reviewConcepts, {
      fields: [reviewConceptDependencies.conceptId],
      references: [reviewConcepts.id],
      relationName: "concept_dependencies",
    }),
    dependency: one(reviewConcepts, {
      fields: [reviewConceptDependencies.dependencyId],
      references: [reviewConcepts.id],
      relationName: "concept_dependents",
    }),
  }),
);

export const conceptMemberRelations = relations(
  reviewConceptMembers,
  ({ one }) => ({
    layout: one(reviewConceptLayouts, {
      fields: [reviewConceptMembers.layoutId],
      references: [reviewConceptLayouts.id],
    }),
    concept: one(reviewConcepts, {
      fields: [reviewConceptMembers.conceptId],
      references: [reviewConcepts.id],
    }),
    unit: one(reviewUnits, {
      fields: [reviewConceptMembers.unitId],
      references: [reviewUnits.id],
    }),
  }),
);

/** Creates a SQL expression used to atomically increment a numeric column. */
export const increment = (value: number) => sql`${value}`;
