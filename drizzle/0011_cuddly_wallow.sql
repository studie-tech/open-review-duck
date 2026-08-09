CREATE INDEX "ai_job_unit_idx" ON "open_review_duck_ai_job" USING btree ("unitId");--> statement-breakpoint
CREATE INDEX "ai_job_snapshot_idx" ON "open_review_duck_ai_job" USING btree ("snapshotId");--> statement-breakpoint
CREATE INDEX "review_concept_dependency_dependency_idx" ON "open_review_duck_review_concept_dependency" USING btree ("dependencyId");--> statement-breakpoint
CREATE INDEX "review_concept_member_unit_idx" ON "open_review_duck_review_concept_member" USING btree ("unitId");--> statement-breakpoint
CREATE INDEX "review_unit_dependency_dependency_idx" ON "open_review_duck_review_unit_dependency" USING btree ("dependencyId");--> statement-breakpoint
CREATE INDEX "review_unit_snapshot_file_idx" ON "open_review_duck_review_unit" USING btree ("snapshotFileId");--> statement-breakpoint
CREATE INDEX "review_unit_current_blob_idx" ON "open_review_duck_review_unit" USING btree ("currentBlobId");--> statement-breakpoint
CREATE INDEX "review_unit_previous_blob_idx" ON "open_review_duck_review_unit" USING btree ("previousBlobId");--> statement-breakpoint
CREATE INDEX "sync_run_workspace_idx" ON "open_review_duck_sync_run" USING btree ("workspaceId","status","createdAt");