-- The pairs the membership will reference have to be unique before anything
-- can point at them.
CREATE UNIQUE INDEX "review_concept_layout_scope_idx" ON "open_review_duck_review_concept_layout" USING btree ("id","snapshotId");--> statement-breakpoint
CREATE UNIQUE INDEX "review_unit_scope_idx" ON "open_review_duck_review_unit" USING btree ("id","snapshotId");--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_member" DROP CONSTRAINT "open_review_duck_review_concept_member_unitId_open_review_duck_review_unit_id_fk";--> statement-breakpoint
-- A membership learns its snapshot from the layout it already claims. The
-- column arrives nullable so existing rows can be filled before it is required
-- of them.
ALTER TABLE "open_review_duck_review_concept_member" ADD COLUMN "snapshotId" uuid;--> statement-breakpoint
UPDATE "open_review_duck_review_concept_member" AS m
SET "snapshotId" = l."snapshotId"
FROM "open_review_duck_review_concept_layout" AS l
WHERE l."id" = m."layoutId";--> statement-breakpoint
-- A layout partitions one snapshot's units, so a membership naming a unit from
-- another revision was never reachable through the review path. Clearing such a
-- row keeps a database that somehow holds one migratable: memberships are
-- derived from the analysis and are rebuilt on the next synchronization.
DELETE FROM "open_review_duck_review_concept_member" AS m
WHERE m."snapshotId" IS NULL;--> statement-breakpoint
DELETE FROM "open_review_duck_review_concept_member" AS m
WHERE NOT EXISTS (
  SELECT 1
  FROM "open_review_duck_review_unit" AS u
  WHERE u."id" = m."unitId" AND u."snapshotId" = m."snapshotId"
);--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_member" ALTER COLUMN "snapshotId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_member" ADD CONSTRAINT "open_review_duck_review_concept_member_snapshotId_open_review_duck_review_snapshot_id_fk" FOREIGN KEY ("snapshotId") REFERENCES "public"."open_review_duck_review_snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_member" ADD CONSTRAINT "open_review_duck_review_concept_member_layoutId_snapshotId_open_review_duck_review_concept_layout_id_snapshotId_fk" FOREIGN KEY ("layoutId","snapshotId") REFERENCES "public"."open_review_duck_review_concept_layout"("id","snapshotId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_review_duck_review_concept_member" ADD CONSTRAINT "open_review_duck_review_concept_member_unitId_snapshotId_open_review_duck_review_unit_id_snapshotId_fk" FOREIGN KEY ("unitId","snapshotId") REFERENCES "public"."open_review_duck_review_unit"("id","snapshotId") ON DELETE cascade ON UPDATE no action;
