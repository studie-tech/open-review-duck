-- Foreign keys are emitted after every index because drizzle-kit orders
-- composite keys ahead of the unique indexes they reference, which
-- Postgres rejects with 42830 on a fresh database.
CREATE TABLE "open_review_duck_sync_artifact" (
	"repositoryId" uuid NOT NULL,
	"cacheKey" varchar(64) NOT NULL,
	"sourceBlobId" uuid NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "open_review_duck_sync_run" ADD COLUMN "resultSnapshotId" uuid;
--> statement-breakpoint
ALTER TABLE "open_review_duck_sync_run" ADD COLUMN "snapshotCreated" boolean;
--> statement-breakpoint
ALTER TABLE "open_review_duck_sync_run" ADD COLUMN "verifySources" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "open_review_duck_sync_run" ADD COLUMN "requestVersion" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "open_review_duck_sync_run" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "open_review_duck_sync_run" ADD COLUMN "metrics" jsonb;
--> statement-breakpoint
CREATE UNIQUE INDEX "sync_artifact_key_idx" ON "open_review_duck_sync_artifact" USING btree ("repositoryId","cacheKey");
--> statement-breakpoint
CREATE INDEX "sync_artifact_blob_idx" ON "open_review_duck_sync_artifact" USING btree ("sourceBlobId");
--> statement-breakpoint
CREATE INDEX "sync_artifact_expiry_idx" ON "open_review_duck_sync_artifact" USING btree ("expiresAt");
--> statement-breakpoint
ALTER TABLE "open_review_duck_sync_artifact" ADD CONSTRAINT "open_review_duck_sync_artifact_repositoryId_open_review_duck_repository_id_fk" FOREIGN KEY ("repositoryId") REFERENCES "public"."open_review_duck_repository"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "open_review_duck_sync_artifact" ADD CONSTRAINT "open_review_duck_sync_artifact_sourceBlobId_open_review_duck_source_blob_id_fk" FOREIGN KEY ("sourceBlobId") REFERENCES "public"."open_review_duck_source_blob"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "open_review_duck_sync_run" ADD CONSTRAINT "open_review_duck_sync_run_resultSnapshotId_open_review_duck_review_snapshot_id_fk" FOREIGN KEY ("resultSnapshotId") REFERENCES "public"."open_review_duck_review_snapshot"("id") ON DELETE set null ON UPDATE no action;
