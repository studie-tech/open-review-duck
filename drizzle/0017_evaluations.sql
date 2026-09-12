-- Foreign keys are emitted after every index because drizzle-kit orders
-- composite keys ahead of the unique indexes they reference, which
-- Postgres rejects with 42830 on a fresh database.
CREATE TABLE "open_review_duck_eval_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"datasetId" uuid NOT NULL,
	"encryptedContent" text NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_eval_dataset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_eval_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"caseId" uuid NOT NULL,
	"encryptedOutput" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_eval_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"datasetId" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"encryptedSnapshot" text NOT NULL,
	"status" varchar(24) DEFAULT 'running' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"completedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "eval_case_dataset_idx" ON "open_review_duck_eval_case" USING btree ("datasetId");
--> statement-breakpoint
CREATE INDEX "eval_dataset_workspace_idx" ON "open_review_duck_eval_dataset" USING btree ("workspaceId");
--> statement-breakpoint
CREATE UNIQUE INDEX "eval_result_run_case_idx" ON "open_review_duck_eval_result" USING btree ("runId","caseId");
--> statement-breakpoint
CREATE INDEX "eval_run_dataset_idx" ON "open_review_duck_eval_run" USING btree ("datasetId");
--> statement-breakpoint
ALTER TABLE "open_review_duck_eval_case" ADD CONSTRAINT "open_review_duck_eval_case_datasetId_open_review_duck_eval_dataset_id_fk" FOREIGN KEY ("datasetId") REFERENCES "public"."open_review_duck_eval_dataset"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "open_review_duck_eval_dataset" ADD CONSTRAINT "open_review_duck_eval_dataset_workspaceId_open_review_duck_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."open_review_duck_workspace"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "open_review_duck_eval_result" ADD CONSTRAINT "open_review_duck_eval_result_runId_open_review_duck_eval_run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."open_review_duck_eval_run"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "open_review_duck_eval_run" ADD CONSTRAINT "open_review_duck_eval_run_datasetId_open_review_duck_eval_dataset_id_fk" FOREIGN KEY ("datasetId") REFERENCES "public"."open_review_duck_eval_dataset"("id") ON DELETE cascade ON UPDATE no action;
