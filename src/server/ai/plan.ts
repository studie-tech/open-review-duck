import "server-only";

import { and, eq, gte, lt, sum } from "drizzle-orm";
import { aiUsage } from "@/drizzle/schema";
import { env } from "~/env";
import type { db as database } from "~/server/db";

type Database = typeof database;

export const PAID_AI_FEATURE = "paid_ai_models";

/** Returns the UTC calendar-month window containing the supplied instant. */
export function managedAiMonthWindow(now = new Date()) {
  return {
    startsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    resetsAt: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ),
  };
}

/** Selects the account token allowance granted by the Clerk entitlement. */
export function managedAiMonthlyTokenLimit(subscribed: boolean) {
  return subscribed
    ? env.MANAGED_AI_PAID_MONTHLY_TOKEN_LIMIT
    : env.MANAGED_AI_FREE_MONTHLY_TOKEN_LIMIT;
}

/** Returns settled and in-flight managed token usage for the current month. */
export async function managedAiPlanUsage(
  db: Database,
  input: { userId: string; subscribed: boolean; now?: Date },
) {
  const { startsAt, resetsAt } = managedAiMonthWindow(input.now);
  const [usage] = await db
    .select({
      input: sum(aiUsage.inputTokens),
      output: sum(aiUsage.outputTokens),
      reservedInput: sum(aiUsage.reservedInputTokens),
      reservedOutput: sum(aiUsage.reservedOutputTokens),
    })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.userId, input.userId),
        gte(aiUsage.day, startsAt),
        lt(aiUsage.day, resetsAt),
      ),
    );
  const usedTokens =
    Number(usage?.input ?? 0) +
    Number(usage?.output ?? 0) +
    Number(usage?.reservedInput ?? 0) +
    Number(usage?.reservedOutput ?? 0);
  const limitTokens = managedAiMonthlyTokenLimit(input.subscribed);
  return {
    tier: input.subscribed ? ("pro" as const) : ("free" as const),
    subscribed: input.subscribed,
    usedTokens,
    limitTokens,
    remainingTokens: Math.max(0, limitTokens - usedTokens),
    resetsAt,
  };
}
