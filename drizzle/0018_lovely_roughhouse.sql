ALTER TABLE "open_review_duck_pull_request" ADD COLUMN "authorExternalId" text;--> statement-breakpoint
ALTER TABLE "open_review_duck_pull_request" ADD COLUMN "reviewerExternalIds" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "open_review_duck_pull_request" ADD COLUMN "assigneeExternalIds" jsonb DEFAULT '[]'::jsonb NOT NULL;