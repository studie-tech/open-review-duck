-- A concept's identity within its layout is what the keys below reference, so
-- the pair has to be unique before anything can point at it.
CREATE UNIQUE INDEX "review_concept_scope_idx" ON "open_review_duck_review_concept" USING btree ("id","layoutId");--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_dependency" DROP CONSTRAINT "open_review_duck_review_concept_dependency_conceptId_open_review_duck_review_concept_id_fk";--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_dependency" DROP CONSTRAINT "open_review_duck_review_concept_dependency_dependencyId_open_review_duck_review_concept_id_fk";--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_member" DROP CONSTRAINT "open_review_duck_review_concept_member_conceptId_open_review_duck_review_concept_id_fk";--> statement-breakpoint
-- An edge learns the layout it belongs to from the concept it depends from.
-- The column arrives nullable so existing rows can be filled before it is
-- required of them.
ALTER TABLE "open_review_duck_review_concept_dependency" ADD COLUMN "layoutId" uuid;--> statement-breakpoint
UPDATE "open_review_duck_review_concept_dependency" AS d
SET "layoutId" = c."layoutId"
FROM "open_review_duck_review_concept" AS c
WHERE c."id" = d."conceptId";--> statement-breakpoint
-- Nothing the application writes can produce these, and the constraints being
-- added would refuse them. Clearing them keeps a database that somehow holds
-- one migratable rather than stopping the deployment on it: an edge is derived
-- from the analysis and is rebuilt on the next synchronization.
DELETE FROM "open_review_duck_review_concept_dependency" AS d
WHERE d."layoutId" IS NULL;--> statement-breakpoint
DELETE FROM "open_review_duck_review_concept_dependency" AS d
WHERE NOT EXISTS (
  SELECT 1
  FROM "open_review_duck_review_concept" AS c
  WHERE c."id" = d."dependencyId" AND c."layoutId" = d."layoutId"
);--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_dependency" ALTER COLUMN "layoutId" SET NOT NULL;--> statement-breakpoint
-- A membership already carries the layout it claims. One naming a concept from
-- a different layout was never reachable through the review path, so it is
-- removed rather than allowed to fail the key.
DELETE FROM "open_review_duck_review_concept_member" AS m
WHERE NOT EXISTS (
  SELECT 1
  FROM "open_review_duck_review_concept" AS c
  WHERE c."id" = m."conceptId" AND c."layoutId" = m."layoutId"
);--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_dependency" ADD CONSTRAINT "open_review_duck_review_concept_dependency_layoutId_open_review_duck_review_concept_layout_id_fk" FOREIGN KEY ("layoutId") REFERENCES "public"."open_review_duck_review_concept_layout"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_dependency" ADD CONSTRAINT "open_review_duck_review_concept_dependency_conceptId_layoutId_open_review_duck_review_concept_id_layoutId_fk" FOREIGN KEY ("conceptId","layoutId") REFERENCES "public"."open_review_duck_review_concept"("id","layoutId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_dependency" ADD CONSTRAINT "open_review_duck_review_concept_dependency_dependencyId_layoutId_open_review_duck_review_concept_id_layoutId_fk" FOREIGN KEY ("dependencyId","layoutId") REFERENCES "public"."open_review_duck_review_concept"("id","layoutId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_member" ADD CONSTRAINT "open_review_duck_review_concept_member_conceptId_layoutId_open_review_duck_review_concept_id_layoutId_fk" FOREIGN KEY ("conceptId","layoutId") REFERENCES "public"."open_review_duck_review_concept"("id","layoutId") ON DELETE cascade ON UPDATE no action;
