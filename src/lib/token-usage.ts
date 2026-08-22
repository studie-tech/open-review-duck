/** Highest per-review token cap a reviewer may store. */
export const MAX_REVIEW_TOKEN_CAP = 1_000_000_000;

/** Parses a settings field that is empty for “no limit”. */
export function parseOptionalReviewTokenCap(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return { cap: null, valid: true as const };
  if (!/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)$/.test(trimmed)) {
    return { cap: null, valid: false as const };
  }
  const parsed = Number(trimmed.replace(/,/g, ""));
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_REVIEW_TOKEN_CAP
  ) {
    return { cap: null, valid: false as const };
  }
  return { cap: parsed, valid: true as const };
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
