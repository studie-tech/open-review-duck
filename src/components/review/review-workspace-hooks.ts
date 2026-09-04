"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RouterOutputs } from "~/trpc/react";

type ProviderConversations = RouterOutputs["review"]["providerConversations"];
type ProviderConversationThread = ProviderConversations["threads"][number];

// Only three of the seven `ai_job_status` values are terminal. A deep-review
// parent sits in `waiting_for_provider` from `startAiJob` until seal-plan marks
// it running, so a predicate written as ["queued", "running"] reads a live
// fan-out as finished: polling stops and the run looks frozen.
const terminalAiJobStatuses = ["completed", "failed", "cancelled"];

/** Reports whether an AI job can still change state without a new request. */
export function aiJobActive(status: string | null | undefined) {
  return Boolean(status) && !terminalAiJobStatuses.includes(status ?? "");
}

/** Chooses the card top for file navigation and the exact unit otherwise. */
export function reviewCardPinTarget<T>(input: {
  card: T;
  pinToFileTop: boolean;
  unitLine?: T;
  unitStart?: T;
}) {
  if (input.pinToFileTop) return input.card;
  return input.unitStart ?? input.unitLine ?? input.card;
}

/** Advances to a requested file after the sign-off state has committed. */
export function useReviewFileAdvance<File extends { path: string }>(
  files: readonly File[],
  selectFile: (file: File) => void,
) {
  const selectFileRef = useRef(selectFile);
  selectFileRef.current = selectFile;
  const [requestedPath, setRequestedPath] = useState<string>();

  useEffect(() => {
    if (!requestedPath) return;
    setRequestedPath(undefined);
    const target = files.find(({ path }) => path === requestedPath);
    if (target) selectFileRef.current(target);
  }, [files, requestedPath]);

  return useCallback((path: string) => setRequestedPath(path), []);
}

/** One conversation change a reviewer just asked the provider to make. */
export type ProviderThreadChange = { threadExternalId: string } & (
  | { kind: "resolution"; resolved: boolean }
  | { kind: "edit-comment"; commentExternalId: string; body: string }
  | { kind: "delete-comment"; commentExternalId: string }
  | { kind: "delete-thread" }
);

/**
 * Rewrites the provider conversations as the change in flight will leave them.
 *
 * Publishing a conversation change costs a live provider round trip and the
 * read that reconciles it costs a second one, so the reviewer would otherwise
 * face the old status long after the control stopped spinning. Every field
 * here is one the client already decided, which is what makes the guess exact
 * enough to show before the provider confirms it.
 */
export function reshapeProviderThreads(
  threads: ProviderConversationThread[],
  change: ProviderThreadChange,
): ProviderConversationThread[] {
  if (change.kind === "delete-thread") {
    return threads.filter(
      (thread) => thread.externalId !== change.threadExternalId,
    );
  }
  return threads.map((thread) => {
    if (thread.externalId !== change.threadExternalId) return thread;
    if (change.kind === "resolution") {
      return { ...thread, status: change.resolved ? "resolved" : "open" };
    }
    if (change.kind === "delete-comment") {
      return {
        ...thread,
        comments: thread.comments.filter(
          (comment) => comment.externalId !== change.commentExternalId,
        ),
      };
    }
    return {
      ...thread,
      comments: thread.comments.map((comment) =>
        comment.externalId === change.commentExternalId
          ? { ...comment, body: change.body }
          : comment,
      ),
    };
  });
}

/** Restores one failed optimistic change without disturbing sibling threads. */
export function restoreProviderThread(
  current: ProviderConversationThread[],
  previous: ProviderConversationThread[],
  threadExternalId: string,
): ProviderConversationThread[] {
  const previousIndex = previous.findIndex(
    (thread) => thread.externalId === threadExternalId,
  );
  const previousThread = previous[previousIndex];
  if (!previousThread) {
    return current.filter((thread) => thread.externalId !== threadExternalId);
  }
  const currentIndex = current.findIndex(
    (thread) => thread.externalId === threadExternalId,
  );
  if (currentIndex >= 0) {
    return current.map((thread, index) =>
      index === currentIndex ? previousThread : thread,
    );
  }
  const restored = [...current];
  restored.splice(Math.min(previousIndex, restored.length), 0, previousThread);
  return restored;
}

interface RefetchableQuery {
  refetch: () => unknown;
}

/** Pulls the review tree once the pull-request review reaches a terminal status. */
export function useTerminalReviewRefetch(
  status: string | null | undefined,
  queries: {
    aiUsage: RefetchableQuery;
    deepReview: RefetchableQuery;
    discussion: RefetchableQuery;
  },
) {
  // A query result is a new object on every render, so the effect hangs off the
  // observer-bound `refetch` methods instead: those keep their identity, and
  // depending on the results themselves refetches on every keystroke.
  const { refetch: refetchAiUsage } = queries.aiUsage;
  const { refetch: refetchDeepReview } = queries.deepReview;
  const { refetch: refetchDiscussion } = queries.discussion;
  useEffect(() => {
    // A failed or cancelled parent still owns coverage rows and whatever its
    // children surfaced before the run stopped, so every terminal status pulls
    // the tree once, not just `completed`.
    if (!status || aiJobActive(status)) return;
    void refetchDiscussion();
    void refetchAiUsage();
    void refetchDeepReview();
  }, [refetchAiUsage, refetchDeepReview, refetchDiscussion, status]);
}

interface PrefetchingRouter {
  prefetch: (href: string) => void;
}

/** Warms the router cache for the exits a finished review offers. */
export function useReviewExitPrefetch(
  router: PrefetchingRouter,
  destinations: { nextReviewId: string | undefined; reviewEnded: boolean },
) {
  const { nextReviewId, reviewEnded } = destinations;
  useEffect(() => {
    // The review page sits outside the shell, so no sidebar link has warmed
    // either destination, and both are one deliberate click away in the footer
    // and the completion panel once the review ends.
    if (!reviewEnded) return;
    router.prefetch("/pullrequests");
    if (nextReviewId) router.prefetch(`/review/${nextReviewId}`);
  }, [nextReviewId, reviewEnded, router]);
}
