/** Stores the first valid final submission and rejects every later call. */
export function acceptFirstFinalSubmission<T>(
  submission: { value: T | undefined },
  candidate: T,
) {
  if (submission.value !== undefined) return false;
  submission.value = candidate;
  return true;
}

/** Conservatively estimates the complete pending model input. */
export function estimatePendingInputTokens(
  messages: unknown,
  systemPrompt: string,
) {
  const bytes =
    Buffer.byteLength(JSON.stringify(messages)) +
    Buffer.byteLength(systemPrompt);
  return Math.ceil(bytes / 3.2) + 1_500;
}

/** Reserves pending input and cost before calculating a safe output cap. */
export function boundedTurnOutput(input: {
  pendingInputTokens: number;
  reservedTokens: number;
  consumedTokens: number;
  reservedMicroUsd: number;
  consumedMicroUsd: number;
  pricing?: {
    promptNanoUsdPerToken: number;
    completionNanoUsdPerToken: number;
  };
}) {
  let maxOutputTokens = 8_000;
  if (input.reservedTokens > 0) {
    maxOutputTokens = Math.min(
      maxOutputTokens,
      input.reservedTokens - input.consumedTokens - input.pendingInputTokens,
    );
    if (maxOutputTokens < 1) {
      return { limit: "quota_limit" as const, maxOutputTokens: 0 };
    }
  }
  if (input.reservedMicroUsd > 0) {
    if (!input.pricing) {
      return { limit: "cost_limit" as const, maxOutputTokens: 0 };
    }
    const remainingNanoUsd =
      (input.reservedMicroUsd - input.consumedMicroUsd) * 1_000 -
      input.pendingInputTokens * input.pricing.promptNanoUsdPerToken;
    const affordableOutput =
      input.pricing.completionNanoUsdPerToken > 0
        ? Math.floor(remainingNanoUsd / input.pricing.completionNanoUsdPerToken)
        : maxOutputTokens;
    maxOutputTokens = Math.min(maxOutputTokens, affordableOutput);
    if (maxOutputTokens < 1) {
      return { limit: "cost_limit" as const, maxOutputTokens: 0 };
    }
  }
  return { maxOutputTokens: Math.max(1, maxOutputTokens) };
}
