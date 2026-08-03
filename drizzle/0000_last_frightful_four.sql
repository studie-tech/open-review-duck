CREATE TYPE "public"."ai_completion_reason" AS ENUM('answered', 'investigation_limit', 'quota_limit', 'cost_limit', 'cancelled', 'provider_failure');--> statement-breakpoint
CREATE TYPE "public"."ai_job_kind" AS ENUM('explain', 'review');--> statement-breakpoint
CREATE TYPE "public"."ai_job_status" AS ENUM('queued', 'running', 'waiting_for_provider', 'streaming', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ai_mode" AS ENUM('off', 'on_demand', 'automatic');--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('github', 'gitlab', 'azure_devops');--> statement-breakpoint
CREATE TYPE "public"."pull_request_state" AS ENUM('open', 'merged', 'closed', 'draft');--> statement-breakpoint
CREATE TYPE "public"."repository_intake_mode" AS ENUM('manual', 'assigned', 'all');--> statement-breakpoint
CREATE TYPE "public"."review_comment_source" AS ENUM('user', 'ai');--> statement-breakpoint
CREATE TYPE "public"."review_comment_status" AS ENUM('publishing', 'published', 'failed');--> statement-breakpoint
CREATE TYPE "public"."review_queue_source" AS ENUM('manual', 'assigned', 'all');--> statement-breakpoint
CREATE TYPE "public"."review_queue_state" AS ENUM('active', 'removed');--> statement-breakpoint
CREATE TYPE "public"."semantic_artifact_status" AS ENUM('uploading', 'validating', 'ready', 'rejected', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."source_blob_state" AS ENUM('uploading', 'ready', 'failed', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."source_change_type" AS ENUM('added', 'modified', 'deleted', 'renamed');--> statement-breakpoint
CREATE TYPE "public"."source_storage" AS ENUM('uploadthing', 'local');--> statement-breakpoint
CREATE TYPE "public"."symbol_kind" AS ENUM('constant', 'variable', 'function', 'method', 'class', 'module', 'test', 'test_suite', 'test_hook', 'binary', 'file');--> statement-breakpoint
CREATE TYPE "public"."workflow_run_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "open_review_duck_ai_job_chunk" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jobId" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" varchar(24) NOT NULL,
	"encryptedContent" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_ai_job_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jobId" uuid NOT NULL,
	"snapshotFileId" uuid,
	"sourceBlobId" uuid NOT NULL,
	"path" text NOT NULL,
	"digest" varchar(64) NOT NULL,
	"startByte" integer NOT NULL,
	"endByte" integer NOT NULL,
	"startLine" integer NOT NULL,
	"endLine" integer NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_ai_job_tool_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jobId" uuid NOT NULL,
	"turnSequence" integer NOT NULL,
	"toolCallId" varchar(255) NOT NULL,
	"toolName" varchar(80) NOT NULL,
	"encryptedInput" text NOT NULL,
	"encryptedOutput" text,
	"status" varchar(24) DEFAULT 'running' NOT NULL,
	"durationMs" integer,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"completedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_ai_job_turn" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jobId" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"role" varchar(16) NOT NULL,
	"encryptedContent" text NOT NULL,
	"inputTokens" integer DEFAULT 0 NOT NULL,
	"outputTokens" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
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
	"question" text,
	"focusLine" integer,
	"threadId" uuid,
	"agentVersion" integer DEFAULT 1 NOT NULL,
	"status" "ai_job_status" DEFAULT 'queued' NOT NULL,
	"workflowRunId" uuid,
	"progress" integer DEFAULT 0 NOT NULL,
	"completionReason" "ai_completion_reason",
	"model" varchar(255),
	"provider" varchar(64),
	"result" jsonb,
	"error" text,
	"reservedInputTokens" integer DEFAULT 0 NOT NULL,
	"reservedOutputTokens" integer DEFAULT 0 NOT NULL,
	"inputTokens" integer DEFAULT 0 NOT NULL,
	"outputTokens" integer DEFAULT 0 NOT NULL,
	"cacheReadTokens" integer DEFAULT 0 NOT NULL,
	"cacheWriteTokens" integer DEFAULT 0 NOT NULL,
	"totalTokens" integer DEFAULT 0 NOT NULL,
	"reservedMicroUsd" bigint DEFAULT 0 NOT NULL,
	"actualMicroUsd" bigint DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"startedAt" timestamp with time zone,
	"completedAt" timestamp with time zone,
	"cancelledAt" timestamp with time zone,
	"quotaSettledAt" timestamp with time zone,
	CONSTRAINT "ai_job_question_context_check" CHECK ((
        ("open_review_duck_ai_job"."question" is null and "open_review_duck_ai_job"."focusLine" is null and "open_review_duck_ai_job"."threadId" is null)
        or
        ("open_review_duck_ai_job"."question" is not null and "open_review_duck_ai_job"."focusLine" is not null and "open_review_duck_ai_job"."threadId" is not null)
      ))
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_ai_preference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"selectedModel" varchar(255) DEFAULT 'big-pickle' NOT NULL,
	"mode" "ai_mode" DEFAULT 'on_demand' NOT NULL,
	"reviewPullRequests" boolean DEFAULT false NOT NULL,
	"freeProviderDisclosureVersion" varchar(64),
	"freeProviderDisclosureAcceptedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_review_duck_ai_preference_workspaceId_unique" UNIQUE("workspaceId")
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
CREATE TABLE "open_review_duck_ai_usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"jobId" uuid,
	"month" varchar(7) NOT NULL,
	"kind" varchar(24) NOT NULL,
	"microUsd" bigint NOT NULL,
	"inputTokens" integer DEFAULT 0 NOT NULL,
	"outputTokens" integer DEFAULT 0 NOT NULL,
	"providerReference" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_credential_audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"actorId" text,
	"credentialId" uuid,
	"action" varchar(48) NOT NULL,
	"provider" varchar(32),
	"metadata" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_local_ai_configuration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"provider" varchar(48) NOT NULL,
	"model" varchar(160) NOT NULL,
	"encryptedConfiguration" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_review_duck_local_ai_configuration_workspaceId_unique" UNIQUE("workspaceId")
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_local_bootstrap_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tokenHash" varchar(64) NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"consumedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_review_duck_local_bootstrap_token_tokenHash_unique" UNIQUE("tokenHash")
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_local_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"label" varchar(160) NOT NULL,
	"encryptedPayload" text NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_local_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" text NOT NULL,
	"tokenHash" varchar(64) NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"lastUsedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"revokedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_review_duck_local_session_tokenHash_unique" UNIQUE("tokenHash")
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_managed_ai_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"provider" varchar(48) NOT NULL,
	"providerKeyId" text NOT NULL,
	"encryptedCredential" text NOT NULL,
	"monthlyLimitMicroUsd" bigint NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_managed_ai_model" (
	"modelId" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"contextLength" integer NOT NULL,
	"promptNanoUsdPerToken" bigint NOT NULL,
	"completionNanoUsdPerToken" bigint NOT NULL,
	"supportsTools" boolean NOT NULL,
	"synchronizedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_oauth_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connectionId" uuid NOT NULL,
	"encryptedAccessToken" text NOT NULL,
	"encryptedRefreshToken" text,
	"expiresAt" timestamp with time zone,
	"refreshVersion" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_review_duck_oauth_credential_connectionId_unique" UNIQUE("connectionId")
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_oauth_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"stateHash" varchar(64) NOT NULL,
	"encryptedVerifier" text,
	"redirectPath" text,
	"expiresAt" timestamp with time zone NOT NULL,
	"consumedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_review_duck_oauth_state_stateHash_unique" UNIQUE("stateHash")
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_provider_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"externalAccountId" text NOT NULL,
	"credentialKind" varchar(32) DEFAULT 'local_pat' NOT NULL,
	"credentialFingerprint" varchar(64),
	"displayName" varchar(160) NOT NULL,
	"installationId" text,
	"localCredentialId" uuid,
	"baseUrl" text,
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
	"workspaceId" uuid NOT NULL,
	"connectionId" uuid NOT NULL,
	"externalId" text NOT NULL,
	"owner" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"defaultBranch" varchar(255) NOT NULL,
	"webUrl" text NOT NULL,
	"isPrivate" boolean DEFAULT true NOT NULL,
	"reviewIntakeMode" "repository_intake_mode" DEFAULT 'manual' NOT NULL,
	"intakeLastAttemptAt" timestamp with time zone,
	"intakeLastReconciledAt" timestamp with time zone,
	"intakeLastError" text,
	"intakeOwnerId" text,
	"pullRequestStateLastCheckedAt" timestamp with time zone,
	"pullRequestStateLastError" text,
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
CREATE TABLE "open_review_duck_review_queue_item" (
	"pullRequestId" uuid NOT NULL,
	"userId" text NOT NULL,
	"state" "review_queue_state" DEFAULT 'active' NOT NULL,
	"source" "review_queue_source" DEFAULT 'manual' NOT NULL,
	"removedAt" timestamp with time zone,
	"removedHeadSha" varchar(64),
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_review_duck_review_queue_item_pullRequestId_userId_pk" PRIMARY KEY("pullRequestId","userId")
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
	"snapshotFileId" uuid,
	"currentBlobId" uuid,
	"previousBlobId" uuid,
	"stableKey" text NOT NULL,
	"path" text NOT NULL,
	"language" varchar(32) NOT NULL,
	"kind" "symbol_kind" NOT NULL,
	"name" text NOT NULL,
	"signature" text,
	"startLine" integer NOT NULL,
	"endLine" integer NOT NULL,
	"startByte" integer DEFAULT 0 NOT NULL,
	"endByte" integer DEFAULT 0 NOT NULL,
	"previousStartByte" integer,
	"previousEndByte" integer,
	"relatedRanges" jsonb,
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
CREATE TABLE "open_review_duck_semantic_artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"repositoryId" uuid NOT NULL,
	"commitSha" varchar(64) NOT NULL,
	"digest" varchar(64) NOT NULL,
	"sourceBlobId" uuid NOT NULL,
	"status" "semantic_artifact_status" DEFAULT 'uploading' NOT NULL,
	"byteLength" integer NOT NULL,
	"error" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"validatedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_semantic_upload_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repositoryId" uuid NOT NULL,
	"tokenHash" text NOT NULL,
	"label" varchar(160) NOT NULL,
	"revokedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lastUsedAt" timestamp with time zone
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
CREATE TABLE "open_review_duck_snapshot_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshotId" uuid NOT NULL,
	"path" text NOT NULL,
	"previousPath" text,
	"language" varchar(32) NOT NULL,
	"changeType" "source_change_type" NOT NULL,
	"currentBlobId" uuid,
	"previousBlobId" uuid,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"isBinary" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_source_blob" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"digest" varchar(64) NOT NULL,
	"storage" "source_storage" NOT NULL,
	"state" "source_blob_state" DEFAULT 'uploading' NOT NULL,
	"objectKey" text,
	"customId" text,
	"byteLength" integer NOT NULL,
	"mediaType" varchar(160) DEFAULT 'application/octet-stream' NOT NULL,
	"encoding" varchar(32) DEFAULT 'utf-8' NOT NULL,
	"error" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_sync_queue_request" (
	"syncRunId" uuid NOT NULL,
	"userId" text NOT NULL,
	"source" "review_queue_source" NOT NULL,
	"explicit" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_review_duck_sync_queue_request_syncRunId_userId_pk" PRIMARY KEY("syncRunId","userId")
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_sync_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"repositoryId" uuid NOT NULL,
	"pullRequestNumber" integer NOT NULL,
	"workflowRunId" uuid,
	"status" "workflow_run_status" DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"error" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"startedAt" timestamp with time zone,
	"completedAt" timestamp with time zone
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
CREATE TABLE "open_review_duck_webhook_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "provider" NOT NULL,
	"deliveryId" varchar(255) NOT NULL,
	"event" varchar(120) NOT NULL,
	"receivedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"processedAt" timestamp with time zone,
	"expiresAt" timestamp with time zone NOT NULL,
	"status" varchar(24) DEFAULT 'received' NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_workflow_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"providerRunId" text NOT NULL,
	"kind" varchar(48) NOT NULL,
	"status" "workflow_run_status" DEFAULT 'queued' NOT NULL,
	"targetId" uuid,
	"deploymentId" text,
	"error" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"startedAt" timestamp with time zone,
	"completedAt" timestamp with time zone,
	CONSTRAINT "open_review_duck_workflow_run_providerRunId_unique" UNIQUE("providerRunId")
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
ALTER TABLE "open_review_duck_ai_job_chunk" ADD CONSTRAINT "open_review_duck_ai_job_chunk_jobId_open_review_duck_ai_job_id_fk" FOREIGN KEY ("jobId") REFERENCES "public"."open_review_duck_ai_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job_evidence" ADD CONSTRAINT "open_review_duck_ai_job_evidence_jobId_open_review_duck_ai_job_id_fk" FOREIGN KEY ("jobId") REFERENCES "public"."open_review_duck_ai_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job_evidence" ADD CONSTRAINT "open_review_duck_ai_job_evidence_snapshotFileId_open_review_duck_snapshot_file_id_fk" FOREIGN KEY ("snapshotFileId") REFERENCES "public"."open_review_duck_snapshot_file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job_evidence" ADD CONSTRAINT "open_review_duck_ai_job_evidence_sourceBlobId_open_review_duck_source_blob_id_fk" FOREIGN KEY ("sourceBlobId") REFERENCES "public"."open_review_duck_source_blob"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job_tool_call" ADD CONSTRAINT "open_review_duck_ai_job_tool_call_jobId_open_review_duck_ai_job_id_fk" FOREIGN KEY ("jobId") REFERENCES "public"."open_review_duck_ai_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job_turn" ADD CONSTRAINT "open_review_duck_ai_job_turn_jobId_open_review_duck_ai_job_id_fk" FOREIGN KEY ("jobId") REFERENCES "public"."open_review_duck_ai_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job" ADD CONSTRAINT "open_review_duck_ai_job_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job" ADD CONSTRAINT "open_review_duck_ai_job_pullRequestId_open_review_duck_pull_request_id_fk" FOREIGN KEY ("pullRequestId") REFERENCES "public"."open_review_duck_pull_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job" ADD CONSTRAINT "open_review_duck_ai_job_snapshotId_open_review_duck_review_snapshot_id_fk" FOREIGN KEY ("snapshotId") REFERENCES "public"."open_review_duck_review_snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job" ADD CONSTRAINT "open_review_duck_ai_job_unitId_open_review_duck_review_unit_id_fk" FOREIGN KEY ("unitId") REFERENCES "public"."open_review_duck_review_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job" ADD CONSTRAINT "open_review_duck_ai_job_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job" ADD CONSTRAINT "open_review_duck_ai_job_workflowRunId_open_review_duck_workflow_run_id_fk" FOREIGN KEY ("workflowRunId") REFERENCES "public"."open_review_duck_workflow_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_preference" ADD CONSTRAINT "open_review_duck_ai_preference_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_usage" ADD CONSTRAINT "open_review_duck_ai_usage_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_usage" ADD CONSTRAINT "open_review_duck_ai_usage_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_usage_ledger" ADD CONSTRAINT "open_review_duck_ai_usage_ledger_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_usage_ledger" ADD CONSTRAINT "open_review_duck_ai_usage_ledger_jobId_open_review_duck_ai_job_id_fk" FOREIGN KEY ("jobId") REFERENCES "public"."open_review_duck_ai_job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_credential_audit_event" ADD CONSTRAINT "open_review_duck_credential_audit_event_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_credential_audit_event" ADD CONSTRAINT "open_review_duck_credential_audit_event_actorId_open_review_duck_user_id_fk" FOREIGN KEY ("actorId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_local_ai_configuration" ADD CONSTRAINT "open_review_duck_local_ai_configuration_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_local_credential" ADD CONSTRAINT "open_review_duck_local_credential_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_local_session" ADD CONSTRAINT "open_review_duck_local_session_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_managed_ai_credential" ADD CONSTRAINT "open_review_duck_managed_ai_credential_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_oauth_credential" ADD CONSTRAINT "open_review_duck_oauth_credential_connectionId_open_review_duck_provider_connection_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."open_review_duck_provider_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_oauth_state" ADD CONSTRAINT "open_review_duck_oauth_state_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_provider_connection" ADD CONSTRAINT "open_review_duck_provider_connection_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_provider_connection" ADD CONSTRAINT "open_review_duck_provider_connection_localCredentialId_open_review_duck_local_credential_id_fk" FOREIGN KEY ("localCredentialId") REFERENCES "public"."open_review_duck_local_credential"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_pull_request" ADD CONSTRAINT "open_review_duck_pull_request_repositoryId_open_review_duck_repository_id_fk" FOREIGN KEY ("repositoryId") REFERENCES "public"."open_review_duck_repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_repository" ADD CONSTRAINT "open_review_duck_repository_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_repository" ADD CONSTRAINT "open_review_duck_repository_connectionId_open_review_duck_provider_connection_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."open_review_duck_provider_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_repository" ADD CONSTRAINT "open_review_duck_repository_intakeOwnerId_open_review_duck_user_id_fk" FOREIGN KEY ("intakeOwnerId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_comment" ADD CONSTRAINT "open_review_duck_review_comment_unitId_open_review_duck_review_unit_id_fk" FOREIGN KEY ("unitId") REFERENCES "public"."open_review_duck_review_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_comment" ADD CONSTRAINT "open_review_duck_review_comment_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_comment" ADD CONSTRAINT "open_review_duck_review_comment_aiJobId_open_review_duck_ai_job_id_fk" FOREIGN KEY ("aiJobId") REFERENCES "public"."open_review_duck_ai_job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_queue_item" ADD CONSTRAINT "open_review_duck_review_queue_item_pullRequestId_open_review_duck_pull_request_id_fk" FOREIGN KEY ("pullRequestId") REFERENCES "public"."open_review_duck_pull_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_queue_item" ADD CONSTRAINT "open_review_duck_review_queue_item_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_session" ADD CONSTRAINT "open_review_duck_review_session_pullRequestId_open_review_duck_pull_request_id_fk" FOREIGN KEY ("pullRequestId") REFERENCES "public"."open_review_duck_pull_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_session" ADD CONSTRAINT "open_review_duck_review_session_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_session" ADD CONSTRAINT "open_review_duck_review_session_snapshotId_open_review_duck_review_snapshot_id_fk" FOREIGN KEY ("snapshotId") REFERENCES "public"."open_review_duck_review_snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_snapshot" ADD CONSTRAINT "open_review_duck_review_snapshot_pullRequestId_open_review_duck_pull_request_id_fk" FOREIGN KEY ("pullRequestId") REFERENCES "public"."open_review_duck_pull_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_unit_dependency" ADD CONSTRAINT "open_review_duck_review_unit_dependency_unitId_open_review_duck_review_unit_id_fk" FOREIGN KEY ("unitId") REFERENCES "public"."open_review_duck_review_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_unit_dependency" ADD CONSTRAINT "open_review_duck_review_unit_dependency_dependencyId_open_review_duck_review_unit_id_fk" FOREIGN KEY ("dependencyId") REFERENCES "public"."open_review_duck_review_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_unit" ADD CONSTRAINT "open_review_duck_review_unit_snapshotId_open_review_duck_review_snapshot_id_fk" FOREIGN KEY ("snapshotId") REFERENCES "public"."open_review_duck_review_snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_unit" ADD CONSTRAINT "open_review_duck_review_unit_snapshotFileId_open_review_duck_snapshot_file_id_fk" FOREIGN KEY ("snapshotFileId") REFERENCES "public"."open_review_duck_snapshot_file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_unit" ADD CONSTRAINT "open_review_duck_review_unit_currentBlobId_open_review_duck_source_blob_id_fk" FOREIGN KEY ("currentBlobId") REFERENCES "public"."open_review_duck_source_blob"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_unit" ADD CONSTRAINT "open_review_duck_review_unit_previousBlobId_open_review_duck_source_blob_id_fk" FOREIGN KEY ("previousBlobId") REFERENCES "public"."open_review_duck_source_blob"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_wait" ADD CONSTRAINT "open_review_duck_review_wait_unitId_open_review_duck_review_unit_id_fk" FOREIGN KEY ("unitId") REFERENCES "public"."open_review_duck_review_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_wait" ADD CONSTRAINT "open_review_duck_review_wait_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_semantic_artifact" ADD CONSTRAINT "open_review_duck_semantic_artifact_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_semantic_artifact" ADD CONSTRAINT "open_review_duck_semantic_artifact_repositoryId_open_review_duck_repository_id_fk" FOREIGN KEY ("repositoryId") REFERENCES "public"."open_review_duck_repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_semantic_artifact" ADD CONSTRAINT "open_review_duck_semantic_artifact_sourceBlobId_open_review_duck_source_blob_id_fk" FOREIGN KEY ("sourceBlobId") REFERENCES "public"."open_review_duck_source_blob"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_semantic_upload_credential" ADD CONSTRAINT "open_review_duck_semantic_upload_credential_repositoryId_open_review_duck_repository_id_fk" FOREIGN KEY ("repositoryId") REFERENCES "public"."open_review_duck_repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_sign_off" ADD CONSTRAINT "open_review_duck_sign_off_unitId_open_review_duck_review_unit_id_fk" FOREIGN KEY ("unitId") REFERENCES "public"."open_review_duck_review_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_sign_off" ADD CONSTRAINT "open_review_duck_sign_off_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_snapshot_file" ADD CONSTRAINT "open_review_duck_snapshot_file_snapshotId_open_review_duck_review_snapshot_id_fk" FOREIGN KEY ("snapshotId") REFERENCES "public"."open_review_duck_review_snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_snapshot_file" ADD CONSTRAINT "open_review_duck_snapshot_file_currentBlobId_open_review_duck_source_blob_id_fk" FOREIGN KEY ("currentBlobId") REFERENCES "public"."open_review_duck_source_blob"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_snapshot_file" ADD CONSTRAINT "open_review_duck_snapshot_file_previousBlobId_open_review_duck_source_blob_id_fk" FOREIGN KEY ("previousBlobId") REFERENCES "public"."open_review_duck_source_blob"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_source_blob" ADD CONSTRAINT "open_review_duck_source_blob_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_sync_queue_request" ADD CONSTRAINT "open_review_duck_sync_queue_request_syncRunId_open_review_duck_sync_run_id_fk" FOREIGN KEY ("syncRunId") REFERENCES "public"."open_review_duck_sync_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_sync_queue_request" ADD CONSTRAINT "open_review_duck_sync_queue_request_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_sync_run" ADD CONSTRAINT "open_review_duck_sync_run_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_sync_run" ADD CONSTRAINT "open_review_duck_sync_run_repositoryId_open_review_duck_repository_id_fk" FOREIGN KEY ("repositoryId") REFERENCES "public"."open_review_duck_repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_sync_run" ADD CONSTRAINT "open_review_duck_sync_run_workflowRunId_open_review_duck_workflow_run_id_fk" FOREIGN KEY ("workflowRunId") REFERENCES "public"."open_review_duck_workflow_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_workflow_run" ADD CONSTRAINT "open_review_duck_workflow_run_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_workspace_member" ADD CONSTRAINT "open_review_duck_workspace_member_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_workspace_member" ADD CONSTRAINT "open_review_duck_workspace_member_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_workspace" ADD CONSTRAINT "open_review_duck_workspace_ownerId_open_review_duck_user_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_job_chunk_sequence_idx" ON "open_review_duck_ai_job_chunk" USING btree ("jobId","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_job_evidence_range_idx" ON "open_review_duck_ai_job_evidence" USING btree ("jobId","sourceBlobId","startByte","endByte");--> statement-breakpoint
CREATE INDEX "ai_job_evidence_path_idx" ON "open_review_duck_ai_job_evidence" USING btree ("jobId","path");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_job_tool_call_id_idx" ON "open_review_duck_ai_job_tool_call" USING btree ("jobId","toolCallId");--> statement-breakpoint
CREATE INDEX "ai_job_tool_turn_idx" ON "open_review_duck_ai_job_tool_call" USING btree ("jobId","turnSequence");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_job_turn_sequence_idx" ON "open_review_duck_ai_job_turn" USING btree ("jobId","sequence");--> statement-breakpoint
CREATE INDEX "ai_job_review_lookup_idx" ON "open_review_duck_ai_job" USING btree ("pullRequestId","snapshotId","userId","kind","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_ledger_job_kind_idx" ON "open_review_duck_ai_usage_ledger" USING btree ("jobId","kind");--> statement-breakpoint
CREATE INDEX "ai_usage_ledger_workspace_month_idx" ON "open_review_duck_ai_usage_ledger" USING btree ("workspaceId","month");--> statement-breakpoint
CREATE INDEX "credential_audit_workspace_idx" ON "open_review_duck_credential_audit_event" USING btree ("workspaceId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "local_credential_fingerprint_idx" ON "open_review_duck_local_credential" USING btree ("workspaceId","kind","fingerprint");--> statement-breakpoint
CREATE INDEX "local_session_user_idx" ON "open_review_duck_local_session" USING btree ("userId","expiresAt");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_ai_credential_workspace_provider_idx" ON "open_review_duck_managed_ai_credential" USING btree ("workspaceId","provider");--> statement-breakpoint
CREATE INDEX "oauth_expiry_idx" ON "open_review_duck_oauth_credential" USING btree ("expiresAt");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_credential_idx" ON "open_review_duck_provider_connection" USING btree ("workspaceId","provider","credentialFingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_external_idx" ON "open_review_duck_pull_request" USING btree ("repositoryId","externalId");--> statement-breakpoint
CREATE INDEX "pull_request_state_idx" ON "open_review_duck_pull_request" USING btree ("repositoryId","state");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_external_idx" ON "open_review_duck_repository" USING btree ("workspaceId","connectionId","externalId");--> statement-breakpoint
CREATE INDEX "review_comment_unit_idx" ON "open_review_duck_review_comment" USING btree ("unitId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "review_comment_ai_finding_idx" ON "open_review_duck_review_comment" USING btree ("aiJobId","aiFindingIndex");--> statement-breakpoint
CREATE INDEX "review_queue_user_state_idx" ON "open_review_duck_review_queue_item" USING btree ("userId","state","updatedAt");--> statement-breakpoint
CREATE INDEX "review_session_active_idx" ON "open_review_duck_review_session" USING btree ("pullRequestId","snapshotId","userId","completedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshot_version_idx" ON "open_review_duck_review_snapshot" USING btree ("pullRequestId","version");--> statement-breakpoint
CREATE UNIQUE INDEX "review_unit_key_idx" ON "open_review_duck_review_unit" USING btree ("snapshotId","stableKey");--> statement-breakpoint
CREATE INDEX "review_order_idx" ON "open_review_duck_review_unit" USING btree ("snapshotId","reviewOrder");--> statement-breakpoint
CREATE UNIQUE INDEX "review_wait_unit_user_idx" ON "open_review_duck_review_wait" USING btree ("unitId","userId");--> statement-breakpoint
CREATE INDEX "review_wait_user_date_idx" ON "open_review_duck_review_wait" USING btree ("userId","waitingSince");--> statement-breakpoint
CREATE UNIQUE INDEX "semantic_artifact_revision_idx" ON "open_review_duck_semantic_artifact" USING btree ("repositoryId","commitSha");--> statement-breakpoint
CREATE INDEX "semantic_upload_repository_idx" ON "open_review_duck_semantic_upload_credential" USING btree ("repositoryId");--> statement-breakpoint
CREATE INDEX "sign_off_unit_user_idx" ON "open_review_duck_sign_off" USING btree ("unitId","userId");--> statement-breakpoint
CREATE INDEX "sign_off_user_date_idx" ON "open_review_duck_sign_off" USING btree ("userId","signedOffAt");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshot_file_path_idx" ON "open_review_duck_snapshot_file" USING btree ("snapshotId","path");--> statement-breakpoint
CREATE INDEX "snapshot_file_current_blob_idx" ON "open_review_duck_snapshot_file" USING btree ("currentBlobId");--> statement-breakpoint
CREATE INDEX "snapshot_file_previous_blob_idx" ON "open_review_duck_snapshot_file" USING btree ("previousBlobId");--> statement-breakpoint
CREATE UNIQUE INDEX "source_blob_digest_idx" ON "open_review_duck_source_blob" USING btree ("workspaceId","digest");--> statement-breakpoint
CREATE INDEX "source_blob_state_idx" ON "open_review_duck_source_blob" USING btree ("state","updatedAt");--> statement-breakpoint
CREATE INDEX "sync_run_repository_idx" ON "open_review_duck_sync_run" USING btree ("repositoryId","pullRequestNumber","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_delivery_provider_idx" ON "open_review_duck_webhook_delivery" USING btree ("provider","deliveryId");--> statement-breakpoint
CREATE INDEX "webhook_delivery_expiry_idx" ON "open_review_duck_webhook_delivery" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "workflow_run_target_idx" ON "open_review_duck_workflow_run" USING btree ("kind","targetId","createdAt");--> statement-breakpoint
CREATE INDEX "workspace_member_user_idx" ON "open_review_duck_workspace_member" USING btree ("userId");
