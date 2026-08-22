import "server-only";

import { and, eq, gte, lt, sum } from "drizzle-orm";
import { aiUsage } from "@/drizzle/schema";
import { env } from "~/env";
import type { db as database } from "~/server/db";

type Database = typeof database;

export const PAID_AI_FEATURE = "paid_ai_models";
export const SCALE_AI_FEATURE = "managed_ai_scale";
export const ULTRA_AI_FEATURE = "managed_ai_ultra";

export type ManagedAiPlanTier = "free" | "pro" | "scale" | "ultra";

/** Resolves the highest managed-AI entitlement attached to an account. */
export function managedAiPlanTier(
  hasFeature: (feature: string) => boolean,
): ManagedAiPlanTier {
  if (hasFeature(ULTRA_AI_FEATURE)) return "ultra";
  if (hasFeature(SCALE_AI_FEATURE)) return "scale";
  if (hasFeature(PAID_AI_FEATURE)) return "pro";
  return "free";
}

/** Returns the single managed model selected by the SaaS deployment. */
export function managedSaasModel() {
  const model = env.OPENROUTER_MODEL_ALLOWLIST?.trim();
  if (!model || model.includes(",")) {
    throw new Error("The managed SaaS model is not configured");
  }
  return model;
}

/** Returns the UTC calendar-month window containing the supplied instant. */
export function managedAiMonthWindow(now = new Date()) {
  return {
    startsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    resetsAt: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ),
  };
}

/** Selects the account token allowance granted by its Clerk entitlement. */
export function managedAiMonthlyTokenLimit(tier: ManagedAiPlanTier) {
  switch (tier) {
    case "ultra":
      return env.MANAGED_AI_ULTRA_MONTHLY_TOKEN_LIMIT;
    case "scale":
      return env.MANAGED_AI_SCALE_MONTHLY_TOKEN_LIMIT;
    case "pro":
      return env.MANAGED_AI_PAID_MONTHLY_TOKEN_LIMIT;
    case "free":
      return env.MANAGED_AI_FREE_MONTHLY_TOKEN_LIMIT;
  }
}

/** Returns settled managed token usage for the current month. */
export async function managedAiPlanUsage(
  db: Database,
  input: { userId: string; tier: ManagedAiPlanTier; now?: Date },
) {
  const { startsAt, resetsAt } = managedAiMonthWindow(input.now);
  const [usage] = await db
    .select({
      input: sum(aiUsage.inputTokens),
      output: sum(aiUsage.outputTokens),
    })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.userId, input.userId),
        gte(aiUsage.day, startsAt),
        lt(aiUsage.day, resetsAt),
      ),
    );
  const usedTokens = Number(usage?.input ?? 0) + Number(usage?.output ?? 0);
  const limitTokens = managedAiMonthlyTokenLimit(input.tier);
  return {
    tier: input.tier,
    subscribed: input.tier !== "free",
    usedTokens,
    limitTokens,
    remainingTokens: Math.max(0, limitTokens - usedTokens),
    resetsAt,
  };
}
