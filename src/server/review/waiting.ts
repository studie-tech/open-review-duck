import type { ProviderReviewThread } from "~/server/providers/types";

interface ReviewUnitBounds {
  path: string;
  startLine: number;
  endLine: number;
}

interface AssignableReviewUnit extends ReviewUnitBounds {
  id: string;
  kind: string;
}

export interface AssignedProviderReviewThread extends ProviderReviewThread {
  unitId: string;
}

interface ObservedProviderActivity {
  providerThreadIds: string[];
  observedCommentIds: string[];
}

/** Selects provider comment activity that belongs to a review unit. */
export function providerActivityForUnit(
  threads: ProviderReviewThread[],
  unit: ReviewUnitBounds,
  trackedThreadIds: string[] = [],
): ObservedProviderActivity {
  const tracked = new Set(trackedThreadIds);
  const relevantThreads = threads.filter(
    (thread) =>
      tracked.has(thread.externalId) ||
      (thread.path === unit.path &&
        thread.line >= unit.startLine &&
        thread.line <= unit.endLine),
  );

  return {
    providerThreadIds: relevantThreads
      .map((thread) => thread.externalId)
      .sort(),
    observedCommentIds: relevantThreads
      .flatMap((thread) =>
        thread.comments.map(
          (comment) => `${thread.externalId}:${comment.externalId}`,
        ),
      )
      .sort(),
  };
}

/** Associates provider review threads with the narrowest matching review units. */
export function assignProviderThreadsToUnits(
  threads: ProviderReviewThread[],
  units: AssignableReviewUnit[],
  explicitlyAssignedUnitByThreadId = new Map<string, string>(),
): AssignedProviderReviewThread[] {
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  return threads.flatMap((thread) => {
    const explicitUnitId = explicitlyAssignedUnitByThreadId.get(
      thread.externalId,
    );
    const explicitUnit = explicitUnitId
      ? unitById.get(explicitUnitId)
      : undefined;
    const unit =
      explicitUnit ??
      units
        .filter(
          (candidate) =>
            candidate.path === thread.path &&
            thread.line >= candidate.startLine &&
            thread.line <= candidate.endLine,
        )
        .sort((left, right) => {
          const spanDifference =
            left.endLine - left.startLine - (right.endLine - right.startLine);
          if (spanDifference !== 0) return spanDifference;
          return (
            Number(left.kind === "module") - Number(right.kind === "module")
          );
        })[0];
    return unit ? [{ ...thread, unitId: unit.id }] : [];
  });
}

/** Checks whether code or provider comments changed since a unit began waiting. */
export function hasNewProviderActivity(
  previouslyObservedCommentIds: string[],
  currentCommentIds: string[],
) {
  const observed = new Set(previouslyObservedCommentIds);
  return currentCommentIds.some((commentId) => !observed.has(commentId));
}

/** Checks whether a waiting state remains valid across a synchronized revision. */
export function canCarryReviewWait(
  previousContentHash: string,
  currentContentHash: string,
) {
  return previousContentHash === currentContentHash;
}
