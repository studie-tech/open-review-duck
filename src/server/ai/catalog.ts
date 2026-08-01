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

/** Synchronizes metadata only for the operator-owned paid-model allowlist. */
export async function synchronizeOpenRouterCatalog(db: Database) {
  const allowlist = new Set(
    (env.OPENROUTER_MODEL_ALLOWLIST ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (allowlist.size === 0) return { synchronized: 0 };
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter catalog failed (${response.status})`);
  }
  const remote = catalogResponse.parse(await response.json());
  const selected = remote.data.filter(({ id }) => allowlist.has(id));
  if (selected.length !== allowlist.size) {
    const found = new Set(selected.map(({ id }) => id));
    throw new Error(
      `OpenRouter allowlist models are missing: ${[...allowlist]
        .filter((id) => !found.has(id))
        .join(", ")}`,
    );
  }
  const synchronizedAt = new Date();
  for (const model of selected) {
    await db
      .insert(managedAiModels)
      .values({
        modelId: model.id,
        name: model.name,
        contextLength: model.context_length,
        promptNanoUsdPerToken: nanoUsdPerToken(model.pricing.prompt),
        completionNanoUsdPerToken: nanoUsdPerToken(model.pricing.completion),
        supportsTools: model.supported_parameters?.includes("tools") ?? false,
        synchronizedAt,
      })
      .onConflictDoUpdate({
        target: managedAiModels.modelId,
        set: {
          name: model.name,
          contextLength: model.context_length,
          promptNanoUsdPerToken: nanoUsdPerToken(model.pricing.prompt),
          completionNanoUsdPerToken: nanoUsdPerToken(model.pricing.completion),
          supportsTools: model.supported_parameters?.includes("tools") ?? false,
          synchronizedAt,
        },
      });
  }
  return { synchronized: selected.length };
}
