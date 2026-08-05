CREATE TYPE "public"."review_concept_layout_source" AS ENUM('deterministic', 'manual', 'ai');--> statement-breakpoint
CREATE TABLE "open_review_duck_review_concept_dependency" (
	"conceptId" uuid NOT NULL,
	"dependencyId" uuid NOT NULL,
	CONSTRAINT "open_review_duck_review_concept_dependency_conceptId_dependencyId_pk" PRIMARY KEY("conceptId","dependencyId")
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_review_concept_layout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshotId" uuid NOT NULL,
	"userId" text,
	"source" "review_concept_layout_source" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"lockedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_review_concept_member" (
	"layoutId" uuid NOT NULL,
	"conceptId" uuid NOT NULL,
	"unitId" uuid NOT NULL,
	"memberOrder" integer NOT NULL,
	CONSTRAINT "open_review_duck_review_concept_member_conceptId_unitId_pk" PRIMARY KEY("conceptId","unitId")
);
--> statement-breakpoint
CREATE TABLE "open_review_duck_review_concept" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"layoutId" uuid NOT NULL,
	"stableKey" text NOT NULL,
	"title" text NOT NULL,
	"rationale" text,
	"reviewOrder" integer NOT NULL,
	"changedLineCount" integer NOT NULL,
	"fileCount" integer NOT NULL,
	"oversized" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "open_review_duck_review_unit" ADD COLUMN "changedLineCount" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_dependency" ADD CONSTRAINT "open_review_duck_review_concept_dependency_conceptId_open_review_duck_review_concept_id_fk" FOREIGN KEY ("conceptId") REFERENCES "public"."open_review_duck_review_concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_dependency" ADD CONSTRAINT "open_review_duck_review_concept_dependency_dependencyId_open_review_duck_review_concept_id_fk" FOREIGN KEY ("dependencyId") REFERENCES "public"."open_review_duck_review_concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_layout" ADD CONSTRAINT "open_review_duck_review_concept_layout_snapshotId_open_review_duck_review_snapshot_id_fk" FOREIGN KEY ("snapshotId") REFERENCES "public"."open_review_duck_review_snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_layout" ADD CONSTRAINT "open_review_duck_review_concept_layout_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_member" ADD CONSTRAINT "open_review_duck_review_concept_member_layoutId_open_review_duck_review_concept_layout_id_fk" FOREIGN KEY ("layoutId") REFERENCES "public"."open_review_duck_review_concept_layout"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_member" ADD CONSTRAINT "open_review_duck_review_concept_member_conceptId_open_review_duck_review_concept_id_fk" FOREIGN KEY ("conceptId") REFERENCES "public"."open_review_duck_review_concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_member" ADD CONSTRAINT "open_review_duck_review_concept_member_unitId_open_review_duck_review_unit_id_fk" FOREIGN KEY ("unitId") REFERENCES "public"."open_review_duck_review_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept" ADD CONSTRAINT "open_review_duck_review_concept_layoutId_open_review_duck_review_concept_layout_id_fk" FOREIGN KEY ("layoutId") REFERENCES "public"."open_review_duck_review_concept_layout"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_concept_baseline_idx" ON "open_review_duck_review_concept_layout" USING btree ("snapshotId") WHERE "open_review_duck_review_concept_layout"."userId" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "review_concept_personal_idx" ON "open_review_duck_review_concept_layout" USING btree ("snapshotId","userId") WHERE "open_review_duck_review_concept_layout"."userId" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "review_concept_membership_idx" ON "open_review_duck_review_concept_member" USING btree ("layoutId","unitId");--> statement-breakpoint
CREATE INDEX "review_concept_member_order_idx" ON "open_review_duck_review_concept_member" USING btree ("conceptId","memberOrder");--> statement-breakpoint
CREATE UNIQUE INDEX "review_concept_key_idx" ON "open_review_duck_review_concept" USING btree ("layoutId","stableKey");--> statement-breakpoint
CREATE UNIQUE INDEX "review_concept_order_idx" ON "open_review_duck_review_concept" USING btree ("layoutId","reviewOrder");