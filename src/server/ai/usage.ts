import "server-only";

import { eq, sql } from "drizzle-orm";
import { aiJobs } from "@/drizzle/schema";
import type { db as database } from "~/server/db";

type Database = typeof database;

export interface PersistedAiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  actualMicroUsd: number;
}

export interface ReportedAiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  microUsd?: number;
}

export type TokenUsage = ReportedAiUsage;

export interface AiProviderUsageResult {
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokenDetails?: {
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
  };
  providerMetadata?: unknown;
}

/** Normalizes one provider response into the application usage ledger. */
export function providerUsage(result: AiProviderUsageResult): TokenUsage {
  const metadata = result.providerMetadata as
    | { openrouter?: { usage?: { cost?: number } } }
    | undefined;
  return {
    input: result.usage.inputTokens ?? 0,
    output: result.usage.outputTokens ?? 0,
    cacheRead: result.usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWrite: result.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
    totalTokens: result.usage.totalTokens ?? 0,
    microUsd: Math.ceil((metadata?.openrouter?.usage?.cost ?? 0) * 1_000_000),
  };
}

/** Adds two provider reports without dropping optional cost information. */
export function addAiUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    microUsd: (left.microUsd ?? 0) + (right.microUsd ?? 0),
  };
}

/** Atomically adds one provider report to a durable AI job's counters. */
export async function accumulateAiUsage(
  db: Pick<Database, "update">,
  jobId: string,
  usage: TokenUsage,
): Promise<void> {
  await db
    .update(aiJobs)
    .set({
      inputTokens: sql`${aiJobs.inputTokens} + ${usage.input}`,
      outputTokens: sql`${aiJobs.outputTokens} + ${usage.output}`,
      cacheReadTokens: sql`${aiJobs.cacheReadTokens} + ${usage.cacheRead}`,
      cacheWriteTokens: sql`${aiJobs.cacheWriteTokens} + ${usage.cacheWrite}`,
      totalTokens: sql`${aiJobs.totalTokens} + ${usage.totalTokens}`,
      actualMicroUsd: sql`${aiJobs.actualMicroUsd} + ${usage.microUsd ?? 0}`,
    })
    .where(eq(aiJobs.id, jobId));
}

/** Settles from persisted usage by default and never reduces an observed counter. */
export function nonReducingAiUsage(
  persisted: PersistedAiUsage,
  reported?: ReportedAiUsage,
) {
  return {
    input: Math.max(persisted.inputTokens, reported?.input ?? 0),
    output: Math.max(persisted.outputTokens, reported?.output ?? 0),
    cacheRead: Math.max(persisted.cacheReadTokens, reported?.cacheRead ?? 0),
    cacheWrite: Math.max(persisted.cacheWriteTokens, reported?.cacheWrite ?? 0),
    totalTokens: Math.max(persisted.totalTokens, reported?.totalTokens ?? 0),
    microUsd: Math.max(persisted.actualMicroUsd, reported?.microUsd ?? 0),
  };
}
