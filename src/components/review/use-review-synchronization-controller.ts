"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { providerLabel } from "~/lib/provider-labels";
import { acknowledgeReviewRevision } from "~/lib/review-revision";
import { api, type RouterOutputs } from "~/trpc/react";

type WorkspaceData = RouterOutputs["review"]["workspace"];

interface ReviewSynchronizationControllerInput {
  manualSyncPending: boolean;
  onReset: () => void;
  onRevisionAcknowledged: () => void;
  pullRequest: WorkspaceData["pullRequest"];
  sendReviewSession: (event: {
    type: "SYNC_FINISHED" | "SYNC_STARTED";
  }) => void;
  snapshot: WorkspaceData["snapshot"];
}

/**
 * Owns the durable pull-request synchronization and revision-loading cycle.
 *
 * The workspace supplies navigation state resets, while this controller keeps
 * provider polling, terminal notifications, revision acknowledgement, and
 * query invalidation in one lifecycle.
 */
export function useReviewSynchronizationController({
  manualSyncPending,
  onReset,
  onRevisionAcknowledged,
  pullRequest,
  sendReviewSession,
  snapshot,
}: ReviewSynchronizationControllerInput) {
  const router = useRouter();
  const utils = api.useUtils();
  const [activeSyncId, setActiveSyncId] = useState<string>();
  const [loadingChanges, startLoadingChanges] = useTransition();
  const [updateAvailable, setUpdateAvailable] = useState(false);

  const pollLatestPullRequest = api.review.poll.useMutation({
    onSuccess: (result) => {
      setActiveSyncId(result.syncId);
      void utils.review.activeSyncs.invalidate();
      toast.info("Pull request synchronization queued", {
        description:
          "ReviewDuck will preserve your current review while it runs.",
      });
    },
  });
  const syncStatus = api.review.syncStatus.useQuery(
    { syncId: activeSyncId ?? "00000000-0000-4000-8000-000000000000" },
    {
      enabled: Boolean(activeSyncId),
      refetchInterval: (query) =>
        ["queued", "running"].includes(query.state.data?.status ?? "")
          ? 1_500
          : false,
    },
  );

  useEffect(() => {
    if (!activeSyncId) return;
    const status = syncStatus.data?.status;
    if (status === "completed") {
      setActiveSyncId(undefined);
      if (snapshot) {
        acknowledgeReviewRevision(window.localStorage, pullRequest.id, {
          headSha: snapshot.headSha,
          snapshotId: snapshot.id,
          version: snapshot.version,
        });
      }
      setUpdateAvailable(false);
      void Promise.all([
        utils.review.activeSyncs.invalidate(),
        utils.review.dashboard.invalidate(),
        utils.review.gamification.invalidate(),
        utils.review.providerConversations.invalidate({
          pullRequestId: pullRequest.id,
        }),
        utils.review.providerReviewState.invalidate({
          pullRequestId: pullRequest.id,
        }),
        utils.review.providerLifecycle.invalidate({
          pullRequestId: pullRequest.id,
        }),
      ]);
      sendReviewSession({ type: "SYNC_FINISHED" });
      toast.success("Pull request synchronized", {
        description: "The latest review revision is loaded.",
      });
      router.refresh();
    } else if (status === "failed" || status === "cancelled") {
      setActiveSyncId(undefined);
      void utils.review.activeSyncs.invalidate();
      sendReviewSession({ type: "SYNC_FINISHED" });
      toast.error(
        status === "cancelled"
          ? "Pull request synchronization was cancelled"
          : "Pull request synchronization failed",
        { description: syncStatus.data?.error ?? "Try again in a moment." },
      );
    }
  }, [
    activeSyncId,
    syncStatus.data,
    utils.review.activeSyncs.invalidate,
    utils.review.dashboard.invalidate,
    utils.review.gamification.invalidate,
    utils.review.providerConversations.invalidate,
    utils.review.providerLifecycle.invalidate,
    utils.review.providerReviewState.invalidate,
    pullRequest.id,
    router,
    sendReviewSession,
    snapshot,
  ]);

  const resetReview = api.review.reset.useMutation({
    onSuccess: (result) => {
      onReset();
      setActiveSyncId(result.syncId);
      void Promise.all([
        utils.review.activeSyncs.invalidate(),
        utils.review.dashboard.invalidate(),
        utils.review.gamification.invalidate(),
      ]);
      router.refresh();
      toast.info("Review reset; synchronization queued");
    },
    onError: (error) => {
      toast.error("Review could not be reset", {
        description: error.message,
      });
    },
  });

  /** Queues durable source synchronization. */
  async function syncExternalData() {
    if (manualSyncPending) return;
    sendReviewSession({ type: "SYNC_STARTED" });
    try {
      await pollLatestPullRequest.mutateAsync({
        pullRequestId: pullRequest.id,
      });
    } catch (cause) {
      sendReviewSession({ type: "SYNC_FINISHED" });
      toast.error(
        `Could not queue ${providerLabel(pullRequest.provider)} synchronization`,
        {
          description:
            cause instanceof Error ? cause.message : "Try again in a moment.",
        },
      );
    }
  }

  /** Persists the exact pull-request revision currently on screen. */
  function rememberLoadedRevision() {
    if (!snapshot) return;
    acknowledgeReviewRevision(window.localStorage, pullRequest.id, {
      headSha: snapshot.headSha,
      snapshotId: snapshot.id,
      version: snapshot.version,
    });
  }

  /** Replaces the workspace with the newly synchronized revision. */
  function loadAvailableChanges() {
    if (loadingChanges) return;
    rememberLoadedRevision();
    startLoadingChanges(() => {
      setUpdateAvailable(false);
      router.refresh();
    });
  }

  /** Acknowledges the explanation for the currently loaded revision. */
  function acknowledgeLoadedRevision() {
    rememberLoadedRevision();
    onRevisionAcknowledged();
  }

  return {
    acknowledgeLoadedRevision,
    externalSyncPending:
      manualSyncPending ||
      pollLatestPullRequest.isPending ||
      ["queued", "running"].includes(syncStatus.data?.status ?? ""),
    loadAvailableChanges,
    loadingChanges,
    markUpdateAvailable: () => setUpdateAvailable(true),
    resetReview,
    syncExternalData,
    updateAvailable,
  };
}
