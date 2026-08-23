-- Existing deployments predate the squashed baseline that already declares
-- these enum members. Repository reviews fan out into both job kinds, so add
-- them explicitly for upgraded databases as well as fresh installations.
ALTER TYPE "public"."ai_job_kind" ADD VALUE IF NOT EXISTS 'review_file' BEFORE 'semantic_cluster';
--> statement-breakpoint
ALTER TYPE "public"."ai_job_kind" ADD VALUE IF NOT EXISTS 'review_survey' BEFORE 'semantic_cluster';
