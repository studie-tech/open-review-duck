ALTER TABLE "open_review_duck_ai_job" ADD COLUMN "workflowStartToken" uuid;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_job" ADD COLUMN "workflowStartLeaseExpiresAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "open_review_duck_repository_branch_sync_run" ADD COLUMN "workflowStartToken" uuid;--> statement-breakpoint
ALTER TABLE "open_review_duck_repository_branch_sync_run" ADD COLUMN "workflowStartLeaseExpiresAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "open_review_duck_sync_run" ADD COLUMN "workflowStartToken" uuid;--> statement-breakpoint
ALTER TABLE "open_review_duck_sync_run" ADD COLUMN "workflowStartLeaseExpiresAt" timestamp with time zone;