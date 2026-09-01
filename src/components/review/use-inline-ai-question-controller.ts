"use client";

import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { RouterOutputs } from "~/trpc/react";
import { rememberAiConversationVisibility } from "./review-workspace-ai-conversation";

type ReviewUnit = RouterOutputs["review"]["workspace"]["units"][number];
type ReviewRange = { endLine: number; startLine: number };

interface InlineAiQuestionControllerInput {
  activeUnit?: ReviewUnit;
  codeScrollRef: RefObject<HTMLDivElement | null>;
  isReviewLine: (line: number) => boolean;
  liveQuestions: ReadonlyArray<{
    focusLine?: number;
    threadId?: string;
  }>;
  persistedQuestions?: ReadonlyArray<{
    conversationId?: string | null;
    focusLine?: number | null;
  }>;
  primaryEnd: number;
  primaryRanges?: ReviewRange[];
  primaryStart: number;
  pullRequestId: string;
}

/** Clamps a requested line to the closest disjoint review range. */
export function closestReviewLine(
  line: number,
  ranges: ReviewRange[] | undefined,
  fallbackStart: number,
  fallbackEnd: number,
) {
  const candidates = ranges ?? [
    { startLine: fallbackStart, endLine: fallbackEnd },
  ];
  return candidates.reduce((closest, range) => {
    const candidate = Math.min(range.endLine, Math.max(range.startLine, line));
    return Math.abs(candidate - line) < Math.abs(closest - line)
      ? candidate
      : closest;
  }, candidates[0]?.startLine ?? fallbackStart);
}

/** Owns line placement, persistence, and scroll anchoring for inline AI chat. */
export function useInlineAiQuestionController({
  activeUnit,
  codeScrollRef,
  isReviewLine,
  liveQuestions,
  persistedQuestions,
  primaryEnd,
  primaryRanges,
  primaryStart,
  pullRequestId,
}: InlineAiQuestionControllerInput) {
  const [line, setLine] = useState<number>();
  const [threadId, setThreadId] = useState<string>();
  const [focusComposer, setFocusComposer] = useState(false);
  const [previewLine, setPreviewLine] = useState<number>();
  const moveAnchor = useRef<{ cardTop: number; scrollTop: number } | undefined>(
    undefined,
  );

  useLayoutEffect(() => {
    if (line === undefined) {
      moveAnchor.current = undefined;
      return;
    }
    const anchor = moveAnchor.current;
    if (!anchor) return;
    moveAnchor.current = undefined;
    const pane = codeScrollRef.current;
    const card = document.getElementById("inline-ai-question");
    if (!pane || !card) return;
    pane.scrollTop =
      anchor.scrollTop + card.getBoundingClientRect().top - anchor.cardTop;
  }, [codeScrollRef, line]);

  /** Opens a conversation at the closest line inside the active review scope. */
  function openAt(requestedLine: number) {
    if (!activeUnit) return;
    const nextLine = closestReviewLine(
      requestedLine,
      primaryRanges,
      primaryStart,
      primaryEnd,
    );
    setFocusComposer(true);
    const latestLiveThread = liveQuestions
      .filter((question) => question.focusLine === nextLine)
      .at(-1)?.threadId;
    const latestPersistedThread = persistedQuestions
      ?.filter((question) => question.focusLine === nextLine)
      .at(-1)?.conversationId;
    const nextThreadId =
      latestLiveThread ?? latestPersistedThread ?? crypto.randomUUID();
    setLine(nextLine);
    setThreadId(nextThreadId ?? undefined);
    rememberAiConversationVisibility(
      window.localStorage,
      pullRequestId,
      activeUnit.id,
      nextLine,
      nextThreadId ?? undefined,
    );
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document
          .getElementById("inline-ai-question")
          ?.scrollIntoView({ block: "center", behavior: "smooth" }),
      ),
    );
  }

  /** Moves the conversation while preserving its on-screen vertical anchor. */
  function move(requestedLine: number) {
    if (!activeUnit) return;
    const nextLine = closestReviewLine(
      requestedLine,
      primaryRanges,
      primaryStart,
      primaryEnd,
    );
    if (nextLine === line) return;
    const pane = codeScrollRef.current;
    const card = document.getElementById("inline-ai-question");
    if (pane && card) {
      moveAnchor.current = {
        cardTop: card.getBoundingClientRect().top,
        scrollTop: pane.scrollTop,
      };
    }
    setLine(nextLine);
    rememberAiConversationVisibility(
      window.localStorage,
      pullRequestId,
      activeUnit.id,
      nextLine,
      threadId,
    );
  }

  /** Moves to the next rendered line inside the active review scope. */
  function step(direction: -1 | 1) {
    if (!activeUnit || line === undefined) return;
    const distinctLines = new Set<number>();
    for (const element of document.querySelectorAll<HTMLElement>(
      '[id^="review-line-"]',
    )) {
      const renderedLine = Number(element.id.replace("review-line-", ""));
      if (Number.isInteger(renderedLine) && isReviewLine(renderedLine)) {
        distinctLines.add(renderedLine);
      }
    }
    const renderedLines = [...distinctLines].sort(
      (left, right) => left - right,
    );
    const nextLine =
      direction === 1
        ? renderedLines.find((candidate) => candidate > line)
        : [...renderedLines].reverse().find((candidate) => candidate < line);
    if (nextLine !== undefined) move(nextLine);
  }

  return {
    focusComposer,
    line,
    move,
    openAt,
    previewLine,
    setFocusComposer,
    setLine,
    setPreviewLine,
    setThreadId,
    step,
    threadId,
  };
}
