"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AiQuestionStreamUpdate,
  coalesceAiQuestionStreamUpdates,
  consumeAiQuestionStream,
} from "~/lib/ai-question-stream";
import { api } from "~/trpc/react";
import { showAiStartError } from "./review-workspace-diff";
import {
  applyAiQuestionStreamUpdate,
  type LiveAiQuestion,
} from "./review-workspace-stream";

interface AskAiQuestionInput {
  canAsk: boolean;
  focusLine?: number;
  question: string;
  threadId?: string;
  unitId?: string;
}

interface AiQuestionStreamControllerInput {
  onQuestionsChanged: () => void;
  onUsageChanged: () => void;
  pullRequestId: string;
}

/** Owns optimistic AI questions and their reconnecting durable event streams. */
export function useAiQuestionStreamController({
  onQuestionsChanged,
  onUsageChanged,
  pullRequestId,
}: AiQuestionStreamControllerInput) {
  const [liveQuestions, setLiveQuestions] = useState<LiveAiQuestion[]>([]);
  const streams = useRef(new Map<string, AbortController>());
  const questionInFlight = useRef(false);
  const startQuestion = api.ai.start.useMutation({
    onSuccess: onUsageChanged,
  });

  useEffect(
    () => () => {
      for (const stream of streams.current.values()) stream.abort();
      streams.current.clear();
    },
    [],
  );

  /** Removes optimistic entries once persistence reports a terminal job. */
  const removeTerminalQuestions = useCallback(function removeTerminalQuestions(
    jobIds: ReadonlySet<string>,
  ) {
    if (jobIds.size === 0) return;
    setLiveQuestions((questions) =>
      questions.filter(({ jobId }) => !jobId || !jobIds.has(jobId)),
    );
  }, []);

  /** Removes optimistic entries that belonged to a deleted conversation. */
  const removeDeletedQuestions = useCallback(function removeDeletedQuestions(
    jobIds: readonly string[],
  ) {
    const deleted = new Set(jobIds);
    setLiveQuestions((questions) =>
      questions.filter(
        ({ id, jobId }) => !deleted.has(id) && (!jobId || !deleted.has(jobId)),
      ),
    );
  }, []);

  /** Applies one durable stream update to an optimistic entry. */
  function updateLiveQuestion(id: string, update: AiQuestionStreamUpdate) {
    setLiveQuestions((questions) =>
      applyAiQuestionStreamUpdate(questions, id, update),
    );
  }

  /** Follows a persisted conversation stream until it reaches a terminal state. */
  async function streamQuestion(jobId: string, optimisticId: string) {
    streams.current.get(optimisticId)?.abort();
    const controller = new AbortController();
    streams.current.set(optimisticId, controller);
    let cursor = -1;
    let reconnects = 0;
    const answerUpdates = coalesceAiQuestionStreamUpdates((update) =>
      updateLiveQuestion(optimisticId, update),
    );
    try {
      while (!controller.signal.aborted) {
        try {
          const query = cursor >= 0 ? `?cursor=${cursor}` : "";
          const response = await fetch(`/api/ai/jobs/${jobId}/stream${query}`, {
            headers: { Accept: "text/event-stream" },
            signal: controller.signal,
          });
          const lastUpdate = await consumeAiQuestionStream(
            response,
            (update) => {
              if (update.cursor !== undefined) cursor = update.cursor;
              answerUpdates.push(update);
            },
          );
          if (
            lastUpdate?.status === "completed" ||
            lastUpdate?.status === "failed"
          ) {
            return;
          }
          throw new Error("AI answer stream ended before completion");
        } catch {
          if (controller.signal.aborted) return;
          answerUpdates.flush();
          reconnects += 1;
          if (reconnects > 5) break;
          setLiveQuestions((questions) =>
            questions.map((question) =>
              question.id === optimisticId &&
              !["completed", "failed"].includes(question.status)
                ? {
                    ...question,
                    progress: "Live updates disconnected; reconnecting…",
                    status: "running",
                  }
                : question,
            ),
          );
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(4_000, 250 * 2 ** reconnects)),
          );
        }
      }
      if (!controller.signal.aborted) {
        setLiveQuestions((questions) =>
          questions.map((question) =>
            question.id === optimisticId &&
            !["completed", "failed"].includes(question.status)
              ? {
                  ...question,
                  progress: "Live updates unavailable; still working…",
                  status: "running",
                }
              : question,
          ),
        );
      }
    } finally {
      answerUpdates.cancel();
      if (streams.current.get(optimisticId) === controller) {
        streams.current.delete(optimisticId);
      }
      onQuestionsChanged();
      onUsageChanged();
      questionInFlight.current = false;
    }
  }

  /** Sends one line-focused question to the isolated AI reviewer. */
  function askQuestion({
    canAsk,
    focusLine,
    question: rawQuestion,
    threadId,
    unitId,
  }: AskAiQuestionInput) {
    if (
      !unitId ||
      focusLine === undefined ||
      !canAsk ||
      questionInFlight.current
    ) {
      return;
    }
    const question = rawQuestion.trim();
    if (!question) return;
    questionInFlight.current = true;
    const conversationId = threadId ?? crypto.randomUUID();
    const optimisticId = `pending-${crypto.randomUUID()}`;
    const clientRequestId = crypto.randomUUID();
    setLiveQuestions((questions) => [
      ...questions,
      {
        error: null,
        focusLine,
        id: optimisticId,
        progress: "Sending question…",
        question,
        result: null,
        status: "queued",
        threadId: conversationId,
      },
    ]);
    startQuestion.mutate(
      {
        pullRequestId,
        unitId,
        kind: "explain",
        question,
        focusLine,
        threadId: conversationId,
        clientRequestId,
      },
      {
        onSuccess: (job) => {
          setLiveQuestions((questions) =>
            questions.map((entry) =>
              entry.id === optimisticId
                ? {
                    ...entry,
                    jobId: job.id,
                    progress: "Waiting for the AI reviewer…",
                    status: job.status === "running" ? "running" : "queued",
                  }
                : entry,
            ),
          );
          void streamQuestion(job.id, optimisticId);
          onQuestionsChanged();
        },
        onError: (error) => {
          questionInFlight.current = false;
          setLiveQuestions((questions) =>
            questions.map((entry) =>
              entry.id === optimisticId
                ? {
                    ...entry,
                    error: error.message,
                    progress: "Question was not sent",
                    status: "failed",
                  }
                : entry,
            ),
          );
          showAiStartError(error);
        },
      },
    );
    return conversationId;
  }

  return {
    askQuestion,
    liveQuestions,
    removeDeletedQuestions,
    removeTerminalQuestions,
    startPending: startQuestion.isPending,
  };
}
