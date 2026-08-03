CREATE TABLE "open_review_duck_provider_webhook" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repositoryId" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"encryptedSecret" text NOT NULL,
	"remoteHookIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_review_duck_provider_webhook_repositoryId_unique" UNIQUE("repositoryId")
);
--> statement-breakpoint
ALTER TABLE "open_review_duck_provider_webhook" ADD CONSTRAINT "open_review_duck_provider_webhook_repositoryId_open_review_duck_repository_id_fk" FOREIGN KEY ("repositoryId") REFERENCES "public"."open_review_duck_repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_webhook_provider_idx" ON "open_review_duck_provider_webhook" USING btree ("provider");--> statement-breakpoint
CREATE UNIQUE INDEX "github_app_installation_idx" ON "open_review_duck_provider_connection" USING btree ("installationId");