CREATE TYPE "public"."ai_job_kind" AS ENUM('explain', 'review');--> statement-breakpoint
CREATE TYPE "public"."ai_job_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ai_mode" AS ENUM('off', 'on_demand', 'automatic');--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('github', 'gitlab', 'azure_devops');--> statement-breakpoint
CREATE TYPE "public"."pull_request_state" AS ENUM('open', 'merged', 'closed', 'draft');--> statement-breakpoint
CREATE TYPE "public"."review_comment_source" AS ENUM('user', 'ai');--> statement-breakpoint
CREATE TYPE "public"."review_comment_status" AS ENUM('publishing', 'published', 'failed');--> statement-breakpoint
CREATE TYPE "public"."source_change_type" AS ENUM('added', 'modified', 'deleted', 'renamed');--> statement-breakpoint
CREATE TYPE "public"."symbol_kind" AS ENUM('constant', 'variable', 'function', 'method', 'class', 'module', 'test', 'test_suite', 'test_hook', 'binary', 'file');--> statement-breakpoint
CREATE TABLE "open_review_duck_ai_configuration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"provider" varchar(48) NOT NULL,
	"model" varchar(160) NOT NULL,
	"apiProtocol" varchar(48) DEFAULT 'openai-responses' NOT NULL,
	"encryptedApiKey" text,
	"encryptedHeaders" text,
	"baseUrl" text,
	"contextWindow" integer DEFAULT 128000 NOT NULL,
	"maxTokens" integer DEFAULT 8000 NOT NULL,
	"storeResponses" boolean DEFAULT false NOT NULL,
	"useManagedModels" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_review_duck_ai_configuration_workspaceId_unique" UNIQUE("workspaceId")
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_ai_dispatch" (
	"jobId" uuid PRIMARY KEY NOT NULL,
	"status" varchar(24) DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"availableAt" timestamp with time zone DEFAULT now() NOT NULL,
	"leaseExpiresAt" timestamp with time zone,
	"lastError" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_ai_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"pullRequestId" uuid NOT NULL,
	"snapshotId" uuid NOT NULL,
	"unitId" uuid,
	"userId" text NOT NULL,
	"kind" "ai_job_kind" NOT NULL,
	"agentVersion" integer DEFAULT 1 NOT NULL,
	"status" "ai_job_status" DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"error" text,
	"reservedInputTokens" integer DEFAULT 0 NOT NULL,
	"reservedOutputTokens" integer DEFAULT 0 NOT NULL,
	"inputTokens" integer DEFAULT 0 NOT NULL,
	"outputTokens" integer DEFAULT 0 NOT NULL,
	"cacheReadTokens" integer DEFAULT 0 NOT NULL,
	"cacheWriteTokens" integer DEFAULT 0 NOT NULL,
	"totalTokens" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"completedAt" timestamp with time zone,
	"quotaSettledAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_ai_usage" (
	"workspaceId" uuid NOT NULL,
	"userId" text NOT NULL,
	"day" timestamp with time zone NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"inputTokens" integer DEFAULT 0 NOT NULL,
	"outputTokens" integer DEFAULT 0 NOT NULL,
	"reservedInputTokens" integer DEFAULT 0 NOT NULL,
	"reservedOutputTokens" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "open_review_duck_ai_usage_workspaceId_userId_day_pk" PRIMARY KEY("workspaceId","userId","day")
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_provider_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"externalAccountId" text NOT NULL,
	"credentialFingerprint" varchar(64) NOT NULL,
	"displayName" varchar(160) NOT NULL,
	"encryptedAccessToken" text NOT NULL,
	"encryptedRefreshToken" text,
	"baseUrl" text,
	"expiresAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_pull_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repositoryId" uuid NOT NULL,
	"externalId" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"authorLogin" varchar(255) NOT NULL,
	"authorAvatarUrl" text,
	"sourceBranch" varchar(255) NOT NULL,
	"targetBranch" varchar(255) NOT NULL,
	"headSha" varchar(64) NOT NULL,
	"baseSha" varchar(64) NOT NULL,
	"state" "pull_request_state" DEFAULT 'open' NOT NULL,
	"webUrl" text NOT NULL,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"changedFiles" integer DEFAULT 0 NOT NULL,
	"lastSyncedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_rate_limit" (
	"key" varchar(255) PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_repository" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connectionId" uuid NOT NULL,
	"externalId" text NOT NULL,
	"owner" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"defaultBranch" varchar(255) NOT NULL,
	"webUrl" text NOT NULL,
	"isPrivate" boolean DEFAULT true NOT NULL,
	"sourceRetentionDays" integer DEFAULT 30 NOT NULL,
	"sourceRetentionSnapshots" integer DEFAULT 5 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_review_comment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unitId" uuid NOT NULL,
	"userId" text NOT NULL,
	"aiJobId" uuid,
	"aiFindingIndex" integer,
	"source" "review_comment_source" NOT NULL,
	"body" text NOT NULL,
	"line" integer NOT NULL,
	"status" "review_comment_status" DEFAULT 'publishing' NOT NULL,
	"providerExternalId" text,
	"error" text,
	"publishedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_review_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pullRequestId" uuid NOT NULL,
	"userId" text NOT NULL,
	"snapshotId" uuid NOT NULL,
	"startedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"completedAt" timestamp with time zone,
	"reviewedUnits" integer DEFAULT 0 NOT NULL,
	"experienceAwarded" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_review_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pullRequestId" uuid NOT NULL,
	"headSha" varchar(64) NOT NULL,
	"baseSha" varchar(64) NOT NULL,
	"version" integer NOT NULL,
	"analysisVersion" integer DEFAULT 1 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_review_unit_dependency" (
	"unitId" uuid NOT NULL,
	"dependencyId" uuid NOT NULL,
	CONSTRAINT "open_review_duck_review_unit_dependency_unitId_dependencyId_pk" PRIMARY KEY("unitId","dependencyId")
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_review_unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshotId" uuid NOT NULL,
	"stableKey" text NOT NULL,
	"path" text NOT NULL,
	"language" varchar(32) NOT NULL,
	"kind" "symbol_kind" NOT NULL,
	"name" text NOT NULL,
	"signature" text,
	"startLine" integer NOT NULL,
	"endLine" integer NOT NULL,
	"source" text NOT NULL,
	"previousSource" text,
	"contentHash" varchar(64) NOT NULL,
	"semanticHash" varchar(64) NOT NULL,
	"changeType" "source_change_type" DEFAULT 'modified' NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"reviewOrder" integer NOT NULL,
	"complexity" integer DEFAULT 1 NOT NULL,
	"requiresReReview" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_review_wait" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unitId" uuid NOT NULL,
	"userId" text NOT NULL,
	"providerThreadIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observedCommentIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"waitingSince" timestamp with time zone DEFAULT now() NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_sign_off" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unitId" uuid NOT NULL,
	"userId" text NOT NULL,
	"semanticHash" varchar(64) NOT NULL,
	"note" text,
	"durationSeconds" integer DEFAULT 0 NOT NULL,
	"signedOffAt" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidatedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_user" (
	"id" text PRIMARY KEY NOT NULL,
	"email" varchar(320),
	"displayName" varchar(120),
	"imageUrl" text,
	"currentStreak" integer DEFAULT 0 NOT NULL,
	"longestStreak" integer DEFAULT 0 NOT NULL,
	"experiencePoints" integer DEFAULT 0 NOT NULL,
	"lastReviewDate" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_workspace_member" (
	"workspaceId" uuid NOT NULL,
	"userId" text NOT NULL,
	"role" varchar(24) DEFAULT 'member' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_review_duck_workspace_member_workspaceId_userId_pk" PRIMARY KEY("workspaceId","userId")
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerkOrganizationId" text,
	"ownerId" text NOT NULL,
	"name" varchar(120) NOT NULL,
	"slug" varchar(80) NOT NULL,
	"aiMode" "ai_mode" DEFAULT 'on_demand' NOT NULL,
	"aiReviewEnabled" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_review_duck_workspace_clerkOrganizationId_unique" UNIQUE("clerkOrganizationId"),
	CONSTRAINT "open_review_duck_workspace_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_configuration" ADD CONSTRAINT "open_review_duck_ai_configuration_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_dispatch" ADD CONSTRAINT "open_review_duck_ai_dispatch_jobId_open_review_duck_ai_job_id_fk" FOREIGN KEY ("jobId") REFERENCES "public"."open_review_duck_ai_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job" ADD CONSTRAINT "open_review_duck_ai_job_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job" ADD CONSTRAINT "open_review_duck_ai_job_pullRequestId_open_review_duck_pull_request_id_fk" FOREIGN KEY ("pullRequestId") REFERENCES "public"."open_review_duck_pull_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job" ADD CONSTRAINT "open_review_duck_ai_job_snapshotId_open_review_duck_review_snapshot_id_fk" FOREIGN KEY ("snapshotId") REFERENCES "public"."open_review_duck_review_snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job" ADD CONSTRAINT "open_review_duck_ai_job_unitId_open_review_duck_review_unit_id_fk" FOREIGN KEY ("unitId") REFERENCES "public"."open_review_duck_review_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job" ADD CONSTRAINT "open_review_duck_ai_job_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_usage" ADD CONSTRAINT "open_review_duck_ai_usage_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_usage" ADD CONSTRAINT "open_review_duck_ai_usage_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_provider_connection" ADD CONSTRAINT "open_review_duck_provider_connection_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_pull_request" ADD CONSTRAINT "open_review_duck_pull_request_repositoryId_open_review_duck_repository_id_fk" FOREIGN KEY ("repositoryId") REFERENCES "public"."open_review_duck_repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_repository" ADD CONSTRAINT "open_review_duck_repository_connectionId_open_review_duck_provider_connection_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."open_review_duck_provider_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_comment" ADD CONSTRAINT "open_review_duck_review_comment_unitId_open_review_duck_review_unit_id_fk" FOREIGN KEY ("unitId") REFERENCES "public"."open_review_duck_review_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_comment" ADD CONSTRAINT "open_review_duck_review_comment_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_comment" ADD CONSTRAINT "open_review_duck_review_comment_aiJobId_open_review_duck_ai_job_id_fk" FOREIGN KEY ("aiJobId") REFERENCES "public"."open_review_duck_ai_job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_session" ADD CONSTRAINT "open_review_duck_review_session_pullRequestId_open_review_duck_pull_request_id_fk" FOREIGN KEY ("pullRequestId") REFERENCES "public"."open_review_duck_pull_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_session" ADD CONSTRAINT "open_review_duck_review_session_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_session" ADD CONSTRAINT "open_review_duck_review_session_snapshotId_open_review_duck_review_snapshot_id_fk" FOREIGN KEY ("snapshotId") REFERENCES "public"."open_review_duck_review_snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_snapshot" ADD CONSTRAINT "open_review_duck_review_snapshot_pullRequestId_open_review_duck_pull_request_id_fk" FOREIGN KEY ("pullRequestId") REFERENCES "public"."open_review_duck_pull_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_unit_dependency" ADD CONSTRAINT "open_review_duck_review_unit_dependency_unitId_open_review_duck_review_unit_id_fk" FOREIGN KEY ("unitId") REFERENCES "public"."open_review_duck_review_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_unit_dependency" ADD CONSTRAINT "open_review_duck_review_unit_dependency_dependencyId_open_review_duck_review_unit_id_fk" FOREIGN KEY ("dependencyId") REFERENCES "public"."open_review_duck_review_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_unit" ADD CONSTRAINT "open_review_duck_review_unit_snapshotId_open_review_duck_review_snapshot_id_fk" FOREIGN KEY ("snapshotId") REFERENCES "public"."open_review_duck_review_snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_wait" ADD CONSTRAINT "open_review_duck_review_wait_unitId_open_review_duck_review_unit_id_fk" FOREIGN KEY ("unitId") REFERENCES "public"."open_review_duck_review_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_wait" ADD CONSTRAINT "open_review_duck_review_wait_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_sign_off" ADD CONSTRAINT "open_review_duck_sign_off_unitId_open_review_duck_review_unit_id_fk" FOREIGN KEY ("unitId") REFERENCES "public"."open_review_duck_review_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_sign_off" ADD CONSTRAINT "open_review_duck_sign_off_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_workspace_member" ADD CONSTRAINT "open_review_duck_workspace_member_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_workspace_member" ADD CONSTRAINT "open_review_duck_workspace_member_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_workspace" ADD CONSTRAINT "open_review_duck_workspace_ownerId_open_review_duck_user_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_dispatch_ready_idx" ON "open_review_duck_ai_dispatch" USING btree ("status","availableAt");--> statement-breakpoint
CREATE INDEX "ai_job_review_lookup_idx" ON "open_review_duck_ai_job" USING btree ("pullRequestId","snapshotId","userId","kind","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_credential_idx" ON "open_review_duck_provider_connection" USING btree ("workspaceId","provider","credentialFingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_external_idx" ON "open_review_duck_pull_request" USING btree ("repositoryId","externalId");--> statement-breakpoint
CREATE INDEX "pull_request_state_idx" ON "open_review_duck_pull_request" USING btree ("repositoryId","state");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_external_idx" ON "open_review_duck_repository" USING btree ("connectionId","externalId");--> statement-breakpoint
CREATE INDEX "review_comment_unit_idx" ON "open_review_duck_review_comment" USING btree ("unitId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "review_comment_ai_finding_idx" ON "open_review_duck_review_comment" USING btree ("aiJobId","aiFindingIndex");--> statement-breakpoint
CREATE INDEX "review_session_active_idx" ON "open_review_duck_review_session" USING btree ("pullRequestId","snapshotId","userId","completedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshot_version_idx" ON "open_review_duck_review_snapshot" USING btree ("pullRequestId","version");--> statement-breakpoint
CREATE UNIQUE INDEX "review_unit_key_idx" ON "open_review_duck_review_unit" USING btree ("snapshotId","stableKey");--> statement-breakpoint
CREATE INDEX "review_order_idx" ON "open_review_duck_review_unit" USING btree ("snapshotId","reviewOrder");--> statement-breakpoint
CREATE UNIQUE INDEX "review_wait_unit_user_idx" ON "open_review_duck_review_wait" USING btree ("unitId","userId");--> statement-breakpoint
CREATE INDEX "review_wait_user_date_idx" ON "open_review_duck_review_wait" USING btree ("userId","waitingSince");--> statement-breakpoint
CREATE INDEX "sign_off_unit_user_idx" ON "open_review_duck_sign_off" USING btree ("unitId","userId");--> statement-breakpoint
CREATE INDEX "sign_off_user_date_idx" ON "open_review_duck_sign_off" USING btree ("userId","signedOffAt");--> statement-breakpoint
CREATE INDEX "workspace_member_user_idx" ON "open_review_duck_workspace_member" USING btree ("userId");