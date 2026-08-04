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
  const contentBytes =
    Buffer.byteLength(JSON.stringify(messages)) +
    Buffer.byteLength(systemPrompt);
  // Every content token consumes at least one UTF-8 byte for the supported
  // provider tokenizers. The fixed allowance covers the current tool schemas,
  // role markers, and provider request framing that are not present in content.
  return contentBytes + 2_000;
}

/** Reserves enough managed quota for repeated turns over a growing transcript. */
export function managedInvestigationReservation(input: {
  requestBytes: number;
  minimumInputBytes?: number;
  kind: "explain" | "review";
  monthlyTokenLimit: number;
}) {
  const output = input.kind === "review" ? 16_000 : 8_000;
  const maximumReservation = Math.floor(input.monthlyTokenLimit * 0.8);
  const maximumInput = Math.max(
    0,
    Math.min(input.monthlyTokenLimit - output, maximumReservation - output),
  );
  const onePassInput = input.requestBytes + 12_000;
  const maximumFloor = input.kind === "review" ? 64_000 : 32_000;
  const scaledFloor = Math.floor(
    input.monthlyTokenLimit * (input.kind === "review" ? 0.25 : 0.15),
  );
  const multiTurnFloor = Math.min(maximumFloor, scaledFloor);
  const turnMultiplier = input.monthlyTokenLimit <= 200_000 ? 2 : 4;
  const desiredInput = Math.min(
    maximumInput,
    Math.max(multiTurnFloor, onePassInput * turnMultiplier),
  );
  return {
    input: desiredInput,
    output,
    minimumTokens: Math.min(
      desiredInput + output,
      (input.minimumInputBytes ?? 12_000) + 1_000,
    ),
  };
}

/** Fits a desired job ceiling into the caller's atomically observed allowance. */
export function clampManagedInvestigationReservation(
  desired: { input: number; output: number; minimumTokens: number },
  remainingTokens: number,
) {
  const available = Math.min(
    desired.input + desired.output,
    Math.max(0, remainingTokens),
  );
  if (available < desired.minimumTokens) return undefined;
  if (available === desired.input + desired.output) {
    return { input: desired.input, output: desired.output };
  }
  const output = Math.min(
    desired.output,
    Math.max(1_000, available - desired.input),
  );
  return { input: available - output, output };
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
    if (remainingNanoUsd < 0) {
      return { limit: "cost_limit" as const, maxOutputTokens: 0 };
    }
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
