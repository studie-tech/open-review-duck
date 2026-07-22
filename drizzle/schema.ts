import { relations, sql } from "drizzle-orm";
import {
  boolean,
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
export const pullRequestStateEnum = pgEnum("pull_request_state", [
  "open",
  "merged",
  "closed",
  "draft",
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
  "completed",
  "failed",
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

export const providerConnections = createTable(
  "provider_connection",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: providerEnum().notNull(),
    externalAccountId: text().notNull(),
    credentialFingerprint: varchar({ length: 64 }).notNull(),
    displayName: varchar({ length: 160 }).notNull(),
    encryptedAccessToken: text().notNull(),
    encryptedRefreshToken: text(),
    baseUrl: text(),
    expiresAt: timestamp({ withTimezone: true }),
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

export const repositories = createTable(
  "repository",
  {
    id: uuid().primaryKey().defaultRandom(),
    connectionId: uuid()
      .notNull()
      .references(() => providerConnections.id, { onDelete: "cascade" }),
    externalId: text().notNull(),
    owner: varchar({ length: 255 }).notNull(),
    name: varchar({ length: 255 }).notNull(),
    defaultBranch: varchar({ length: 255 }).notNull(),
    webUrl: text().notNull(),
    isPrivate: boolean().notNull().default(true),
    sourceRetentionDays: integer().notNull().default(30),
    sourceRetentionSnapshots: integer().notNull().default(5),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("repository_external_idx").on(t.connectionId, t.externalId),
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

export const reviewUnits = createTable(
  "review_unit",
  {
    id: uuid().primaryKey().defaultRandom(),
    snapshotId: uuid()
      .notNull()
      .references(() => reviewSnapshots.id, { onDelete: "cascade" }),
    stableKey: text().notNull(),
    path: text().notNull(),
    language: varchar({ length: 32 }).notNull(),
    kind: symbolKindEnum().notNull(),
    name: text().notNull(),
    signature: text(),
    startLine: integer().notNull(),
    endLine: integer().notNull(),
    source: text().notNull(),
    previousSource: text(),
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

export const aiConfigurations = createTable("ai_configuration", {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid()
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" })
    .unique(),
  provider: varchar({ length: 48 }).notNull(),
  model: varchar({ length: 160 }).notNull(),
  apiProtocol: varchar({ length: 48 }).notNull().default("openai-responses"),
  encryptedApiKey: text(),
  encryptedHeaders: text(),
  baseUrl: text(),
  contextWindow: integer().notNull().default(128_000),
  maxTokens: integer().notNull().default(8_000),
  storeResponses: boolean().notNull().default(false),
  useManagedModels: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

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
    agentVersion: integer().notNull().default(1),
    status: aiJobStatusEnum().notNull().default("queued"),
    result: jsonb().$type<{
      summary: string;
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
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
    quotaSettledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("ai_job_review_lookup_idx").on(
      t.pullRequestId,
      t.snapshotId,
      t.userId,
      t.kind,
      t.createdAt,
    ),
  ],
);

export const aiDispatches = createTable(
  "ai_dispatch",
  {
    jobId: uuid()
      .primaryKey()
      .references(() => aiJobs.id, { onDelete: "cascade" }),
    status: varchar({ length: 24 }).notNull().default("queued"),
    attempts: integer().notNull().default(0),
    availableAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    leaseExpiresAt: timestamp({ withTimezone: true }),
    lastError: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("ai_dispatch_ready_idx").on(t.status, t.availableAt)],
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
