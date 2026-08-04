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
