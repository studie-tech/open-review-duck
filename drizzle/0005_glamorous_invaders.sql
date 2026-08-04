CREATE TABLE "open_review_duck_ai_stream_lease" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jobId" uuid NOT NULL,
	"userId" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "open_review_duck_review_comment" ADD COLUMN "publicationLeaseToken" uuid;--> statement-breakpoint
ALTER TABLE "open_review_duck_source_blob" ADD COLUMN "uploadLeaseToken" uuid;--> statement-breakpoint
ALTER TABLE "open_review_duck_source_blob" ADD COLUMN "uploadLeaseExpiresAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "open_review_duck_source_blob" ADD COLUMN "deletionLeaseToken" uuid;--> statement-breakpoint
ALTER TABLE "open_review_duck_source_blob" ADD COLUMN "deletionLeaseExpiresAt" timestamp with time zone;--> statement-breakpoint
UPDATE "open_review_duck_source_blob"
SET "uploadLeaseToken" = gen_random_uuid(), "uploadLeaseExpiresAt" = now()
WHERE "state" = 'uploading';--> statement-breakpoint
UPDATE "open_review_duck_source_blob"
SET "deletionLeaseToken" = gen_random_uuid(), "deletionLeaseExpiresAt" = now()
WHERE "state" = 'deleting';--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_stream_lease" ADD CONSTRAINT "open_review_duck_ai_stream_lease_jobId_open_review_duck_ai_job_id_fk" FOREIGN KEY ("jobId") REFERENCES "public"."open_review_duck_ai_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_stream_lease" ADD CONSTRAINT "open_review_duck_ai_stream_lease_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_stream_lease_user_idx" ON "open_review_duck_ai_stream_lease" USING btree ("userId","expiresAt");
