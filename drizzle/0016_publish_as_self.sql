-- Foreign keys are emitted after every index because drizzle-kit orders
-- composite keys ahead of the unique indexes they reference, which
-- Postgres rejects with 42830 on a fresh database.
CREATE TABLE "open_review_duck_user_provider_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" text NOT NULL,
	"connectionId" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"credentialKind" varchar(32) NOT NULL,
	"encryptedAccessToken" text NOT NULL,
	"encryptedRefreshToken" text,
	"expiresAt" timestamp with time zone,
	"refreshVersion" integer DEFAULT 0 NOT NULL,
	"displayLogin" varchar(160) NOT NULL,
	"externalAccountId" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "open_review_duck_review_comment" ADD COLUMN "publishedAs" varchar(24) DEFAULT 'workspace' NOT NULL;
--> statement-breakpoint
ALTER TABLE "open_review_duck_workspace_member" ADD COLUMN "publishAsSelf" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "user_provider_credential_user_connection_idx" ON "open_review_duck_user_provider_credential" USING btree ("userId","connectionId");
--> statement-breakpoint
CREATE INDEX "user_provider_credential_connection_idx" ON "open_review_duck_user_provider_credential" USING btree ("connectionId");
--> statement-breakpoint
ALTER TABLE "open_review_duck_user_provider_credential" ADD CONSTRAINT "open_review_duck_user_provider_credential_userId_open_review_duck_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."open_review_duck_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "open_review_duck_user_provider_credential" ADD CONSTRAINT "open_review_duck_user_provider_credential_connectionId_open_review_duck_provider_connection_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."open_review_duck_provider_connection"("id") ON DELETE cascade ON UPDATE no action;
