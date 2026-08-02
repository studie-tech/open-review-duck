CREATE TABLE "open_review_duck_provider_pat_credential" (
	"connectionId" uuid PRIMARY KEY NOT NULL,
	"encryptedToken" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "open_review_duck_provider_pat_credential" ADD CONSTRAINT "open_review_duck_provider_pat_credential_connectionId_open_review_duck_provider_connection_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."open_review_duck_provider_connection"("id") ON DELETE cascade ON UPDATE no action;