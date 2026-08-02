export interface TokenUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

/** Formats a token count as a compact, human-readable value. */
export function formatTokenCount(tokens: number) {
  if (tokens < 1_000) return tokens.toLocaleString("en-US");
  if (tokens < 10_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (tokens < 999_500) {
    return `${Math.round(tokens / 1_000).toLocaleString("en-US")}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
