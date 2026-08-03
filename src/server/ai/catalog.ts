import "server-only";

import { z } from "zod";
import { managedAiModels } from "@/drizzle/schema";
import { env } from "~/env";
import type { db as database } from "~/server/db";

type Database = typeof database;

const catalogResponse = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      context_length: z.number().int().positive(),
      pricing: z.object({
        prompt: z.string(),
        completion: z.string(),
      }),
      supported_parameters: z.array(z.string()).optional(),
    }),
  ),
});

/** Converts decimal dollar pricing into integer nano-dollars per token. */
function nanoUsdPerToken(dollars: string) {
  const parsed = Number(dollars);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("OpenRouter returned invalid model pricing");
  }
  return Math.ceil(parsed * 1_000_000_000);
}

/** Synchronizes metadata for the operator-owned SaaS model. */
export async function synchronizeOpenRouterCatalog(db: Database) {
  const modelId = env.OPENROUTER_MODEL_ALLOWLIST?.trim();
  if (!modelId) return { synchronized: 0 };
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter catalog failed (${response.status})`);
  }
  const remote = catalogResponse.parse(await response.json());
  const selected = remote.data.find(({ id }) => id === modelId);
  if (!selected) {
    throw new Error(`OpenRouter managed model is missing: ${modelId}`);
  }
  const synchronizedAt = new Date();
  await db
    .insert(managedAiModels)
    .values({
      modelId: selected.id,
      name: selected.name,
      contextLength: selected.context_length,
      promptNanoUsdPerToken: nanoUsdPerToken(selected.pricing.prompt),
      completionNanoUsdPerToken: nanoUsdPerToken(selected.pricing.completion),
      supportsTools: selected.supported_parameters?.includes("tools") ?? false,
      synchronizedAt,
    })
    .onConflictDoUpdate({
      target: managedAiModels.modelId,
      set: {
        name: selected.name,
        contextLength: selected.context_length,
        promptNanoUsdPerToken: nanoUsdPerToken(selected.pricing.prompt),
        completionNanoUsdPerToken: nanoUsdPerToken(selected.pricing.completion),
        supportsTools:
          selected.supported_parameters?.includes("tools") ?? false,
        synchronizedAt,
      },
    });
  return { synchronized: 1 };
}
