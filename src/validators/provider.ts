import { z } from "zod";

export const providerNameSchema = z.enum(["github", "gitlab", "azure_devops"]);

export const connectProviderSchema = z
  .object({
    provider: providerNameSchema,
    displayName: z.string().trim().min(1).max(160).optional(),
    accessToken: z.string().trim().min(1),
    baseUrl: z.string().url().optional(),
  })
  .superRefine((value, context) => {
    if (value.provider === "azure_devops" && !value.baseUrl) {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "Azure DevOps requires an organization URL",
      });
    }
  });

export const importRepositorySchema = z.object({
  connectionId: z.string().uuid(),
  externalId: z.string().min(1),
});

export const connectionIdSchema = importRepositorySchema.pick({
  connectionId: true,
});

export const repositoryIdSchema = z.object({
  repositoryId: z.string().uuid(),
});

export const repositoryIntakeModeSchema = z.enum(["manual", "assigned", "all"]);

export const repositoryIntakeSchema = repositoryIdSchema.extend({
  mode: repositoryIntakeModeSchema,
});

export const repositoryRetentionSchema = repositoryIdSchema.extend({
  days: z.number().int().min(1).max(365),
  snapshots: z.number().int().min(1).max(100),
});
