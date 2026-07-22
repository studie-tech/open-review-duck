import { aiConnectionErrorMessage } from "./connection-test";

/** Redacts configured credentials while preserving an actionable execution failure. */
export function aiExecutionErrorMessage(
  cause: unknown,
  secrets: Array<string | undefined>,
) {
  return aiConnectionErrorMessage(cause, secrets);
}

/** Returns whether an AI execution failure can plausibly succeed when retried. */
export function isRetryableAiExecutionError(cause: unknown) {
  const message = cause instanceof Error ? cause.message.toLowerCase() : "";
  if (
    /\b(?:400|401|403|404|405|409|410|422)\b/.test(message) ||
    message.includes("invalid_request_error") ||
    message.includes("authentication") ||
    message.includes("unauthorized")
  ) {
    return false;
  }
  return true;
}
