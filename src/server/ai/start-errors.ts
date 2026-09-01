import { DEEP_REVIEW_UNENTITLED_MESSAGE } from "~/server/ai/service";

/**
 * Policy failures `ai.start` and `repoReviews.startRun` may surface verbatim.
 *
 * Imported rather than repeated: the set matches on exact text, so a copy
 * that drifted from the thrown message would be laundered into the generic
 * "could not start" reply and the caller would never learn it needs a plan.
 */
export const SAFE_AI_START_MESSAGES = new Set([
  DEEP_REVIEW_UNENTITLED_MESSAGE,
  "Pull request not found",
  "The managed SaaS model is not configured",
  "No review snapshot found",
  "No review context found",
  "Daily managed AI request limit reached",
  "Daily user AI request limit reached",
  "Monthly AI token limit reached",
  "The managed model is missing a current tool-capable catalog entry",
  "Configure a local AI provider before using AI",
  "Too many requests. Wait a moment and try again.",
]);

/** Converts expected policy failures into a safe user-facing start error. */
export function mapAiStartError(
  cause: unknown,
  fallback: string,
  extras: Iterable<string> = [],
) {
  const allowed = new Set(SAFE_AI_START_MESSAGES);
  for (const extra of extras) allowed.add(extra);
  const message = cause instanceof Error ? cause.message : "";
  if (allowed.has(message)) return message;
  console.error("AI job creation failed", cause);
  return fallback;
}
