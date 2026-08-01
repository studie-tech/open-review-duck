import "server-only";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { localAiConfigurations } from "@/drizzle/schema";
import { env } from "~/env";
import type { db as database } from "~/server/db";
import { isLocalDeployment } from "~/server/deployment";
import { createSafeRemoteFetch } from "~/server/security/remote-url";
import { openVaultSecret } from "~/server/security/vault";
import { openRouterWorkspaceKey } from "./openrouter-keys";

type Database = typeof database;

const localConfiguration = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
});

export interface ResolvedAiModel {
  model: LanguageModel;
  providerOptions?: {
    openrouter: {
      provider: {
        allow_fallbacks: false;
        data_collection: "deny";
        require_parameters: true;
        zdr: true;
      };
    };
  };
}

/** Resolves one job-scoped model without exposing credentials to Workflow state. */
export async function resolveAiModel(
  db: Database,
  input: { model: string; provider: string; workspaceId: string },
): Promise<ResolvedAiModel> {
  if (input.provider === "openrouter") {
    if (isLocalDeployment()) {
      return resolveLocalModel(db, input);
    }
    const provider = createOpenRouter({
      apiKey: await openRouterWorkspaceKey(db, input.workspaceId),
      compatibility: "strict",
      appName: "ReviewDuck",
    });
    return {
      model: provider.chat(input.model),
      providerOptions: {
        openrouter: {
          provider: {
            allow_fallbacks: false,
            data_collection: "deny",
            require_parameters: true,
            zdr: true,
          },
        },
      },
    };
  }
  if (input.provider === "opencode") {
    const apiKey = isLocalDeployment() ? "public" : env.OPENCODE_API_KEY;
    if (!apiKey) throw new Error("Managed Big Pickle is not configured");
    const provider = createOpenAICompatible({
      name: "opencode",
      apiKey,
      baseURL: env.OPENCODE_PUBLIC_BASE_URL,
      fetch: createSafeRemoteFetch(false),
    });
    return { model: provider.chatModel("big-pickle") };
  }
  if (!isLocalDeployment()) {
    throw new Error("SaaS model provider is not allowed");
  }
  return resolveLocalModel(db, input);
}

/** Resolves one encrypted, explicitly selected local provider configuration. */
async function resolveLocalModel(
  db: Database,
  input: { model: string; provider: string; workspaceId: string },
): Promise<ResolvedAiModel> {
  const row = await db.query.localAiConfigurations.findFirst({
    where: eq(localAiConfigurations.workspaceId, input.workspaceId),
  });
  if (!row || row.provider !== input.provider || row.model !== input.model) {
    throw new Error("Local AI provider is not configured");
  }
  const configuration = localConfiguration.parse(
    JSON.parse(
      await openVaultSecret(
        db,
        {
          workspaceId: input.workspaceId,
          recordId: row.id,
          provider: row.provider,
        },
        row.encryptedConfiguration,
      ),
    ),
  );
  const provider = createOpenAICompatible({
    name: row.provider,
    apiKey: configuration.apiKey ?? "local",
    baseURL: configuration.baseUrl,
    headers: configuration.headers,
    fetch: createSafeRemoteFetch(env.ALLOW_PRIVATE_AI_HOSTS),
  });
  return { model: provider.chatModel(row.model) };
}
