-- Foreign keys are emitted after every index because drizzle-kit orders
-- composite keys ahead of the unique indexes they reference, which
-- Postgres rejects with 42830 on a fresh database.
CREATE TABLE "open_review_duck_ai_prompt" (
	"key" varchar(128) PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"updatedByUserId" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "open_review_duck_user" ADD COLUMN "isAdmin" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_prompt" ADD CONSTRAINT "open_review_duck_ai_prompt_updatedByUserId_open_review_duck_user_id_fk" FOREIGN KEY ("updatedByUserId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE set null ON UPDATE no action;
