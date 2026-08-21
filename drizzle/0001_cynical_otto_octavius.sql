-- Foreign keys are emitted after every index because drizzle-kit orders
-- composite keys ahead of the unique indexes they reference, which
-- Postgres rejects with 42830 on a fresh database.
CREATE TABLE "open_review_duck_repository_branch_monitor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"repositoryId" uuid NOT NULL,
	"pullRequestId" uuid NOT NULL,
	"branch" varchar(255) NOT NULL,
	"currentHeadSha" varchar(64),
	"lastCheckedAt" timestamp with time zone,
	"lastSyncedAt" timestamp with time zone,
	"lastError" text,
	"createdBy" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_review_duck_repository_branch_monitor_pullRequestId_unique" UNIQUE("pullRequestId")
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_repository_branch_sync_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"monitorId" uuid NOT NULL,
	"workflowRunId" uuid,
	"status" "workflow_run_status" DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"force" boolean DEFAULT false NOT NULL,
	"error" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"startedAt" timestamp with time zone,
	"completedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_repository_review_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"monitorId" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"instruction" text NOT NULL,
	"pathGlob" varchar(500) DEFAULT '**/*' NOT NULL,
	"scope" varchar(24) DEFAULT 'file' NOT NULL,
	"severity" "finding_severity" DEFAULT 'medium' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archivedAt" timestamp with time zone,
	"createdBy" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job" ADD COLUMN "reviewScope" varchar(32) DEFAULT 'pull_request' NOT NULL;
--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job" ADD COLUMN "reviewPurpose" varchar(24) DEFAULT 'code' NOT NULL;
--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job" ADD COLUMN "reviewRules" jsonb;
--> statement-breakpoint
CREATE UNIQUE INDEX "repository_branch_monitor_target_idx" ON "open_review_duck_repository_branch_monitor" USING btree ("repositoryId","branch");
--> statement-breakpoint
CREATE INDEX "repository_branch_monitor_workspace_idx" ON "open_review_duck_repository_branch_monitor" USING btree ("workspaceId","updatedAt");
--> statement-breakpoint
CREATE INDEX "repository_branch_sync_monitor_idx" ON "open_review_duck_repository_branch_sync_run" USING btree ("monitorId","status","createdAt");
--> statement-breakpoint
CREATE INDEX "repository_branch_sync_workspace_idx" ON "open_review_duck_repository_branch_sync_run" USING btree ("workspaceId","status","createdAt");
--> statement-breakpoint
CREATE INDEX "repository_review_rule_monitor_idx" ON "open_review_duck_repository_review_rule" USING btree ("monitorId","archivedAt","updatedAt");
--> statement-breakpoint
ALTER TABLE "open_review_duck_repository_branch_monitor" ADD CONSTRAINT "open_review_duck_repository_branch_monitor_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "open_review_duck_repository_branch_monitor" ADD CONSTRAINT "open_review_duck_repository_branch_monitor_repositoryId_open_review_duck_repository_id_fk" FOREIGN KEY ("repositoryId") REFERENCES "public"."open_review_duck_repository"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "open_review_duck_repository_branch_monitor" ADD CONSTRAINT "open_review_duck_repository_branch_monitor_pullRequestId_open_review_duck_pull_request_id_fk" FOREIGN KEY ("pullRequestId") REFERENCES "public"."open_review_duck_pull_request"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "open_review_duck_repository_branch_monitor" ADD CONSTRAINT "open_review_duck_repository_branch_monitor_createdBy_open_review_duck_user_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "open_review_duck_repository_branch_sync_run" ADD CONSTRAINT "open_review_duck_repository_branch_sync_run_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "open_review_duck_repository_branch_sync_run" ADD CONSTRAINT "open_review_duck_repository_branch_sync_run_monitorId_open_review_duck_repository_branch_monitor_id_fk" FOREIGN KEY ("monitorId") REFERENCES "public"."open_review_duck_repository_branch_monitor"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "open_review_duck_repository_branch_sync_run" ADD CONSTRAINT "open_review_duck_repository_branch_sync_run_workflowRunId_open_review_duck_workflow_run_id_fk" FOREIGN KEY ("workflowRunId") REFERENCES "public"."open_review_duck_workflow_run"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "open_review_duck_repository_review_rule" ADD CONSTRAINT "open_review_duck_repository_review_rule_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "open_review_duck_repository_review_rule" ADD CONSTRAINT "open_review_duck_repository_review_rule_monitorId_open_review_duck_repository_branch_monitor_id_fk" FOREIGN KEY ("monitorId") REFERENCES "public"."open_review_duck_repository_branch_monitor"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "open_review_duck_repository_review_rule" ADD CONSTRAINT "open_review_duck_repository_review_rule_createdBy_open_review_duck_user_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;
