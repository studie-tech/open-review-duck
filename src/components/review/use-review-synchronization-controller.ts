"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { providerLabel } from "~/lib/provider-labels";
import { acknowledgeReviewRevision } from "~/lib/review-revision";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  REVIEW_REVISION_PROBE_MS,
  reviewSyncStatus,
  shouldAutoSyncReviewRevision,
} from "./review-sync-status";

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
 * query invalidation in one lifecycle. A cheap head-sha probe watches for
 * new commits and queues a silent sync when the branch moves.
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
  const autoSyncedHeadSha = useRef<string | undefined>(undefined);
  const silentSync = useRef(false);

  const pollLatestPullRequest = api.review.poll.useMutation({
    onSuccess: (result) => {
      setActiveSyncId(result.syncId);
      void utils.review.activeSyncs.invalidate();
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
  const revisionProbe = api.review.revisionProbe.useQuery(
    { pullRequestId: pullRequest.id },
    {
      enabled: !activeSyncId,
      refetchInterval: REVIEW_REVISION_PROBE_MS,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  );

  const syncing =
    manualSyncPending ||
    pollLatestPullRequest.isPending ||
    ["queued", "running"].includes(syncStatus.data?.status ?? "");

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
      if (!silentSync.current) {
        toast.success("Pull request synchronized", {
          description: "The latest review revision is loaded.",
        });
      }
      silentSync.current = false;
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
      silentSync.current = false;
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
  async function syncExternalData(options?: { silent?: boolean }) {
    if (manualSyncPending) return;
    silentSync.current = Boolean(options?.silent);
    sendReviewSession({ type: "SYNC_STARTED" });
    try {
      await pollLatestPullRequest.mutateAsync({
        pullRequestId: pullRequest.id,
      });
      if (!options?.silent) {
        toast.info("Pull request synchronization queued", {
          description:
            "ReviewDuck will preserve your current review while it runs.",
        });
      }
    } catch (cause) {
      silentSync.current = false;
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

  const syncExternalDataRef = useRef(syncExternalData);
  syncExternalDataRef.current = syncExternalData;

  useEffect(() => {
    const probe = revisionProbe.data;
    if (
      !probe ||
      !shouldAutoSyncReviewRevision({
        attemptedHeadSha: autoSyncedHeadSha.current,
        busy: syncing,
        current: probe.current,
        remoteHeadSha: probe.headSha,
      })
    ) {
      return;
    }
    autoSyncedHeadSha.current = probe.headSha;
    void syncExternalDataRef.current({ silent: true });
  }, [revisionProbe.data, syncing]);

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
    externalSyncPending: syncing,
    loadAvailableChanges,
    loadingChanges,
    markUpdateAvailable: () => setUpdateAvailable(true),
    resetReview,
    syncExternalData,
    syncStatus: reviewSyncStatus({
      loadingChanges,
      probeFailed: revisionProbe.isError && !syncing,
      syncing,
      updateAvailable,
    }),
    updateAvailable,
  };
}
