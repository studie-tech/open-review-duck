ALTER TABLE "open_review_duck_ai_preference" ALTER COLUMN "selectedModel" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_preference" DROP COLUMN "freeProviderDisclosureVersion";--> statement-breakpoint
ALTER TABLE "open_review_duck_ai_preference" DROP COLUMN "freeProviderDisclosureAcceptedAt";