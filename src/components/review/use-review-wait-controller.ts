"use client";

import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useMemo,
} from "react";
import { toast } from "sonner";
import {
  type ReviewFileEntry,
  waitingReviewFileUnits,
} from "~/lib/review-files";
import { api, type RouterOutputs } from "~/trpc/react";
import type { WaitingReviewUnit } from "./review-waiting-completion";
import { INITIAL_PATH_ITEMS } from "./review-workspace-constants";
import { releaseWaitingUnits } from "./review-workspace-stream";

type ReviewUnit = RouterOutputs["review"]["workspace"]["units"][number];
type ProviderConversations = RouterOutputs["review"]["providerConversations"];

interface ReviewWaitNavigation {
  commentDraft: MutableRefObject<string>;
  nextReviewIndex: (units: ReviewUnit[]) => number;
  pathSearch: string;
  queueLimit: number;
  searchLimit: number;
  selectedLine?: number;
  setActiveIndex: (index: number) => void;
  setPathSearch: Dispatch<SetStateAction<string>>;
  setQueueLimit: Dispatch<SetStateAction<number>>;
  setSearchLimit: Dispatch<SetStateAction<number>>;
  setSelectedLine: Dispatch<SetStateAction<number | undefined>>;
  setShowDiff: Dispatch<SetStateAction<boolean>>;
  setStartedAt: Dispatch<SetStateAction<number>>;
  setWaitingLimit: Dispatch<SetStateAction<number>>;
  showDiff: boolean;
  startedAt: number;
  waitingLimit: number;
}

interface ReviewWaitControllerInput {
  activeUnitId?: string;
  conceptProgress: Array<{
    concept: { title: string };
    members: ReviewUnit[];
  }>;
  conversations?: ProviderConversations;
  discussionComments?: Array<{ status: string }>;
  navigation: ReviewWaitNavigation;
  setUnits: Dispatch<SetStateAction<ReviewUnit[]>>;
  units: ReviewUnit[];
}

/** Owns optimistic wait, resume, rollback, and waiting-summary state. */
export function useReviewWaitController({
  activeUnitId,
  conceptProgress,
  conversations,
  discussionComments,
  navigation,
  setUnits,
  units,
}: ReviewWaitControllerInput) {
  const unitsById = useMemo(
    () => new Map(units.map((unit) => [unit.id, unit])),
    [units],
  );
  const answeredUnitIds = useMemo(
    () => new Set(conversations?.answeredUnitIds ?? []),
    [conversations?.answeredUnitIds],
  );
  const waitingUnits = useMemo(() => {
    const threads = conversations?.threads ?? [];
    const conceptTitleByUnitId = new Map(
      conceptProgress.flatMap(({ concept, members }) =>
        members.map((member) => [member.id, concept.title] as const),
      ),
    );
    return units.flatMap((unit): WaitingReviewUnit[] => {
      if (unit.status !== "waiting") return [];
      const unitThreads = threads.filter((thread) => thread.unitId === unit.id);
      const latestComment = unitThreads
        .flatMap(({ comments }) => comments)
        .sort(
          (left, right) =>
            new Date(right.createdAt).getTime() -
            new Date(left.createdAt).getTime(),
        )[0];
      return [
        {
          answered: answeredUnitIds.has(unit.id),
          commentCount: unitThreads.reduce(
            (total, thread) => total + thread.comments.length,
            0,
          ),
          conceptTitle: conceptTitleByUnitId.get(unit.id),
          id: unit.id,
          latestComment: latestComment
            ? {
                author: latestComment.author,
                body: latestComment.body.replace(/\s+/g, " ").trim(),
              }
            : undefined,
          path: unit.path,
          threadCount: unitThreads.length,
          title: unit.name,
          waitingSince: unit.waitingSince,
        },
      ];
    });
  }, [answeredUnitIds, conceptProgress, conversations?.threads, units]);
  const activeThreads = useMemo(
    () =>
      conversations?.threads.filter(
        (thread) => thread.unitId === activeUnitId,
      ) ?? [],
    [activeUnitId, conversations?.threads],
  );
  const activeUnitHasConversation =
    activeThreads.length > 0 ||
    (discussionComments?.some((comment) => comment.status === "published") ??
      false);

  /** Moves named units into Waiting before persistence responds. */
  function markUnitsWaiting(waitingUnitIds: string[]) {
    const waiting = new Set(waitingUnitIds);
    const updated = units.map((unit) =>
      waiting.has(unit.id)
        ? {
            ...unit,
            status: "waiting" as const,
            waitingSince: new Date(),
            changedSinceSignOff: false,
          }
        : unit,
    );
    const nextIndex = navigation.nextReviewIndex(updated);
    setUnits(updated);
    if (nextIndex >= 0) navigation.setActiveIndex(nextIndex);
    navigation.setQueueLimit(INITIAL_PATH_ITEMS);
    navigation.setWaitingLimit(INITIAL_PATH_ITEMS);
    navigation.setSelectedLine(undefined);
    navigation.commentDraft.current = "";
    navigation.setShowDiff(true);
    navigation.setStartedAt(Date.now());
  }

  const awaitResponse = api.review.awaitResponse.useMutation({
    onMutate: ({ unitId }) => {
      const paused = unitsById.get(unitId);
      if (!paused) return;
      const unitIndex = units.findIndex((unit) => unit.id === unitId);
      markUnitsWaiting([unitId]);
      return {
        paused,
        unitIndex,
        startedAt: navigation.startedAt,
        pathSearch: navigation.pathSearch,
        queueLimit: navigation.queueLimit,
        searchLimit: navigation.searchLimit,
        waitingLimit: navigation.waitingLimit,
        selectedLine: navigation.selectedLine,
        commentDraft: navigation.commentDraft.current,
        showDiff: navigation.showDiff,
      };
    },
    onSuccess: (wait) => {
      const paused = unitsById.get(wait.unitId);
      if (!paused) return;
      toast.success("Waiting for response", {
        description: `${paused.name} will return to your review path when its code or conversation changes.`,
      });
    },
    onError: (error, _input, rollback) => {
      if (rollback) {
        setUnits((current) =>
          current.map((unit) =>
            unit.id === rollback.paused.id ? rollback.paused : unit,
          ),
        );
        if (rollback.unitIndex >= 0) {
          navigation.setActiveIndex(rollback.unitIndex);
        }
        navigation.setPathSearch(rollback.pathSearch);
        navigation.setQueueLimit(rollback.queueLimit);
        navigation.setSearchLimit(rollback.searchLimit);
        navigation.setWaitingLimit(rollback.waitingLimit);
        navigation.setSelectedLine(rollback.selectedLine);
        navigation.commentDraft.current = rollback.commentDraft;
        navigation.setShowDiff(rollback.showDiff);
        navigation.setStartedAt(rollback.startedAt);
      }
      toast.error(error.message);
    },
  });

  const releaseReviewWaits = api.review.releaseReviewWaits.useMutation({
    onMutate: ({ unitIds }) => {
      const releasing = new Set(unitIds);
      const paused = units.filter((unit) => releasing.has(unit.id));
      setUnits((current) => releaseWaitingUnits(current, releasing));
      return { paused };
    },
    onSuccess: ({ authorizedUnitIds }) => {
      const released = new Set(authorizedUnitIds);
      setUnits((current) => releaseWaitingUnits(current, released));
      navigation.setQueueLimit(INITIAL_PATH_ITEMS);
      navigation.setWaitingLimit(INITIAL_PATH_ITEMS);
      navigation.setStartedAt(Date.now());
      toast.success("Back in your review path", {
        description:
          released.size === 1
            ? "The unit no longer waits for a response."
            : `${released.size} units no longer wait for a response.`,
      });
    },
    onError: (error, _input, rollback) => {
      if (rollback) {
        const paused = new Map(
          rollback.paused.map((unit) => [unit.id, unit] as const),
        );
        setUnits((current) =>
          current.map((unit) => paused.get(unit.id) ?? unit),
        );
      }
      toast.error(error.message);
    },
  });
  const resumeReviewFile = useCallback(
    (file: ReviewFileEntry) => {
      const unitIds = waitingReviewFileUnits(file).map(({ id }) => id);
      if (unitIds.length > 0) releaseReviewWaits.mutate({ unitIds });
    },
    [releaseReviewWaits.mutate],
  );

  return {
    activeThreads,
    activeUnitHasConversation,
    answeredWaitCount: waitingUnits.filter(({ answered }) => answered).length,
    awaitResponse,
    releaseReviewWaits,
    resumeReviewFile,
    waitingUnits,
  };
}
