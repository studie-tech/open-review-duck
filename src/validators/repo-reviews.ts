import { z } from "zod";

export const monitorIdSchema = z.object({
  monitorId: z.string().uuid(),
});

export const reportIdSchema = monitorIdSchema.extend({
  jobId: z.string().uuid(),
});

export const listBranchesSchema = z.object({
  repositoryId: z.string().uuid(),
});

export const addMonitorSchema = listBranchesSchema.extend({
  branch: z.string().trim().min(1).max(255),
});

export const ruleScopeSchema = z.enum(["file", "repository"]);
const ruleSeveritySchema = z.enum(["critical", "high", "medium", "low"]);

const ruleFields = {
  title: z.string().trim().min(1).max(200),
  instruction: z.string().trim().min(1).max(8_000),
  pathGlob: z.string().trim().min(1).max(500),
  scope: ruleScopeSchema,
  severity: ruleSeveritySchema,
} as const;

export const addRuleSchema = monitorIdSchema.extend(ruleFields);

export const updateRuleSchema = monitorIdSchema
  .extend({
    ruleId: z.string().uuid(),
    enabled: z.boolean().optional(),
    title: ruleFields.title.optional(),
    instruction: ruleFields.instruction.optional(),
    pathGlob: ruleFields.pathGlob.optional(),
    scope: ruleFields.scope.optional(),
    severity: ruleFields.severity.optional(),
  })
  .refine(
    ({ monitorId: _monitorId, ruleId: _ruleId, ...updates }) =>
      Object.values(updates).some((value) => value !== undefined),
    "Supply at least one rule change",
  );

export const archiveRuleSchema = monitorIdSchema.extend({
  ruleId: z.string().uuid(),
});

export const startRunSchema = monitorIdSchema.extend({
  purpose: z.enum(["code", "compliance"]),
});
