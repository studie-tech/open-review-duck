import type { AiQuestionStreamUpdate } from "~/lib/ai-question-stream";
import { conceptStatusFromMembers } from "~/lib/concept-progress";
import type { RouterOutputs } from "~/trpc/react";

type WorkspaceData = RouterOutputs["review"]["workspace"];
type ReviewUnit = WorkspaceData["units"][number];
type ReviewConcept = WorkspaceData["concepts"][number];

export interface LiveAiQuestion {
  error: string | null;
  focusLine: number;
  id: string;
  jobId?: string;
  progress?: string;
  question: string;
  result: {
    summary: string;
    commentProposals?: Array<{
      body: string;
      line: number;
      path: string;
    }>;
  } | null;
  status: "queued" | "running" | "streaming" | "completed" | "failed";
  threadId: string;
}

/** Derives live concept progress from the canonical atomic-unit ledger. */
export function liveConceptStatus(
  concept: ReviewConcept,
  unitsById: Map<string, ReviewUnit>,
) {
  const members = concept.memberIds
    .map((id) => unitsById.get(id))
    .filter((unit): unit is ReviewUnit => Boolean(unit));
  const signed = members.filter(({ status }) => status === "signed_off").length;
  return {
    members,
    signed,
    status: conceptStatusFromMembers(members, concept.memberIds.length),
  };
}

/**
 * Applies one streamed answer update to the live AI question it names.
 *
 * The stream repeats the running job's progress while the model thinks, so an
 * update often restates what the entry already holds. Returning the array it
 * was given leaves the workspace state referentially equal, which is what
 * keeps a repeated update from re-rendering the whole review tree.
 */
export function applyAiQuestionStreamUpdate(
  questions: LiveAiQuestion[],
  id: string,
  update: AiQuestionStreamUpdate,
): LiveAiQuestion[] {
  const current = questions.find((question) => question.id === id);
  if (!current) return questions;
  const error = update.error ?? null;
  const status = update.status === "working" ? "running" : update.status;
  const unchanged =
    current.error === error &&
    current.progress === update.progress &&
    current.status === status &&
    (!update.text ||
      (current.result?.summary === update.text &&
        current.result?.commentProposals === update.commentProposals));
  if (unchanged) return questions;
  return questions.map((question) =>
    question.id === id
      ? {
          ...question,
          error,
          progress: update.progress,
          result: update.text
            ? {
                summary: update.text,
                commentProposals: update.commentProposals,
              }
            : question.result,
          status,
        }
      : question,
  );
}

/** Gives the named waits back to the actionable review path. */
export function releaseWaitingUnits(
  units: ReviewUnit[],
  unitIds: Iterable<string>,
): ReviewUnit[] {
  const released = new Set(unitIds);
  return units.map((unit) =>
    released.has(unit.id)
      ? { ...unit, status: "pending" as const, waitingSince: null }
      : unit,
  );
}
