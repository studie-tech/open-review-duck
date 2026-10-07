"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { providerLabel } from "~/lib/provider-labels";
import { acknowledgeReviewRevision } from "~/lib/review-revision";
import { syncProgressLabel } from "~/lib/sync-progress";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  REVIEW_REVISION_PROBE_MS,
  reviewSyncStatus,
  shouldAutoSyncReviewRevision,
} from "./review-sync-status";

type WorkspaceData = RouterOutputs["review"]["workspace"];

interface ReviewSynchronizationControllerInput {
  manualSyncPending: boolean;
  canLoadChanges?: boolean | (() => boolean);
  stagedRevisionAvailable?: boolean;
  onBeforeLoad?: () => void;
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
  canLoadChanges = true,
  stagedRevisionAvailable = false,
  onBeforeLoad,
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
  const retryAfter = useRef(0);
  const failedAttempts = useRef(0);
  const retryRevision = useRef<string | undefined>(undefined);
  const queueInFlight = useRef(false);

  useEffect(() => {
    if (stagedRevisionAvailable) setUpdateAvailable(true);
  }, [stagedRevisionAvailable]);

  const loadedSnapshotId = useRef(snapshot?.id);
  const displayedSnapshotIds = useRef(new Set([snapshot?.id]));
  useEffect(() => {
    if (loadedSnapshotId.current === snapshot?.id) return;
    loadedSnapshotId.current = snapshot?.id;
    displayedSnapshotIds.current.add(snapshot?.id);
    setUpdateAvailable(false);
    void utils.review.revisionProbe.invalidate({
      pullRequestId: pullRequest.id,
    });
  }, [snapshot?.id, pullRequest.id, utils.review.revisionProbe.invalidate]);

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
        !query.state.data ||
        query.state.status === "error" ||
        ["queued", "running"].includes(query.state.data.status)
          ? 1_500
          : false,
    },
  );
  const revisionProbe = api.review.revisionProbe.useQuery(
    { pullRequestId: pullRequest.id },
    {
      enabled: !activeSyncId,
      refetchInterval: REVIEW_REVISION_PROBE_MS,
      staleTime: 0,
      refetchOnWindowFocus: "always",
      refetchOnReconnect: "always",
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
      failedAttempts.current = 0;
      retryAfter.current = 0;
      const resultSnapshotId = syncStatus.data?.resultSnapshotId;
      // Old runs have no result identity; probe them instead of guessing that
      // every successful manual synchronization created a new snapshot.
      if (
        resultSnapshotId &&
        resultSnapshotId !== loadedSnapshotId.current &&
        !displayedSnapshotIds.current.has(resultSnapshotId)
      )
        setUpdateAvailable(true);
      void utils.review.revisionProbe.invalidate({
        pullRequestId: pullRequest.id,
      });
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
    } else if (status === "failed" || status === "cancelled") {
      if (status === "failed") {
        autoSyncedHeadSha.current = undefined;
        failedAttempts.current += 1;
        retryAfter.current =
          Date.now() +
          Math.min(
            REVIEW_REVISION_PROBE_MS * 2 ** (failedAttempts.current - 1),
            30_000,
          );
      }
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
    utils.review.revisionProbe.invalidate,
    utils.review.dashboard.invalidate,
    utils.review.gamification.invalidate,
    utils.review.providerConversations.invalidate,
    utils.review.providerLifecycle.invalidate,
    utils.review.providerReviewState.invalidate,
    pullRequest.id,
    sendReviewSession,
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
    if (activeSyncId && syncStatus.isError) {
      await syncStatus.refetch();
      return false;
    }
    if (syncing || activeSyncId || queueInFlight.current) return false;
    queueInFlight.current = true;
    if (!options?.silent) {
      failedAttempts.current = 0;
      retryAfter.current = 0;
    }
    sendReviewSession({ type: "SYNC_STARTED" });
    try {
      await pollLatestPullRequest.mutateAsync({
        pullRequestId: pullRequest.id,
        verifySources: !options?.silent,
      });
      if (!options?.silent) {
        toast.info("Pull request synchronization queued", {
          description:
            "ReviewDuck will preserve your current review while it runs.",
        });
      }
      return true;
    } catch (cause) {
      sendReviewSession({ type: "SYNC_FINISHED" });
      toast.error(
        `Could not queue ${providerLabel(pullRequest.provider)} synchronization`,
        {
          description:
            cause instanceof Error ? cause.message : "Try again in a moment.",
        },
      );
      return false;
    } finally {
      queueInFlight.current = false;
    }
  }

  const syncExternalDataRef = useRef(syncExternalData);
  syncExternalDataRef.current = syncExternalData;

  useEffect(() => {
    const probe = revisionProbe.data;
    if (
      probe?.current &&
      probe.snapshotId &&
      probe.snapshotId !== snapshot?.id &&
      !displayedSnapshotIds.current.has(probe.snapshotId) &&
      !syncing
    ) {
      setUpdateAvailable(true);
    }
    const revision = probe ? `${probe.headSha}:${probe.baseSha}` : undefined;
    if (
      revision &&
      revision !== retryRevision.current &&
      !syncing &&
      !activeSyncId
    ) {
      retryRevision.current = revision;
      failedAttempts.current = 0;
      retryAfter.current = 0;
    }
    if (
      !probe ||
      activeSyncId ||
      queueInFlight.current ||
      failedAttempts.current >= 4 ||
      revisionProbe.dataUpdatedAt < retryAfter.current ||
      !shouldAutoSyncReviewRevision({
        attemptedHeadSha: autoSyncedHeadSha.current,
        busy: syncing,
        current: probe.current,
        remoteHeadSha: `${probe.headSha}:${probe.baseSha}`,
      })
    ) {
      return;
    }
    autoSyncedHeadSha.current = revision;
    void (async () => {
      const queued = await syncExternalDataRef.current({ silent: true });
      autoSyncedHeadSha.current = queued
        ? `${probe.headSha}:${probe.baseSha}`
        : undefined;
      if (!queued) {
        failedAttempts.current += 1;
        retryAfter.current =
          Date.now() +
          Math.min(
            REVIEW_REVISION_PROBE_MS * 2 ** (failedAttempts.current - 1),
            30_000,
          );
      }
    })();
  }, [
    activeSyncId,
    revisionProbe.data,
    revisionProbe.dataUpdatedAt,
    syncing,
    snapshot?.id,
  ]);

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
    if (
      !(typeof canLoadChanges === "function"
        ? canLoadChanges()
        : canLoadChanges)
    ) {
      return;
    }
    onBeforeLoad?.();
    rememberLoadedRevision();
    startLoadingChanges(() => {
      setUpdateAvailable(false);
      if (!stagedRevisionAvailable) router.refresh();
    });
  }

  // Recheck readiness after every render: drafts and pending actions can finish
  // without a new provider probe. Loading stays automatic once they do.
  useEffect(() => {
    if (updateAvailable && !loadingChanges && !syncing) {
      loadAvailableChanges();
    }
  });

  /** Acknowledges the explanation for the currently loaded revision. */
  function acknowledgeLoadedRevision() {
    rememberLoadedRevision();
    onRevisionAcknowledged();
  }

  return {
    acknowledgeLoadedRevision,
    externalSyncPending: syncing,
    loadingChanges,
    markUpdateAvailable: () => setUpdateAvailable(true),
    resetReview,
    syncExternalData,
    syncDetail:
      syncStatus.isError && activeSyncId
        ? "Could not read synchronization progress. Click to reconnect to the running job."
        : activeSyncId && syncStatus.data
          ? `${syncProgressLabel(syncStatus.data.status, syncStatus.data.progress)}${syncStatus.data.startedAt ? ` · ${Math.max(0, Math.floor((Date.now() - syncStatus.data.startedAt.getTime()) / 1000))}s` : ""}${syncStatus.data.attempt > 1 ? ` · attempt ${syncStatus.data.attempt}` : ""}`
          : undefined,
    syncStatus: reviewSyncStatus({
      loadingChanges,
      probeFailed:
        (revisionProbe.isError || syncStatus.isError) && !loadingChanges,
      syncing: syncing && !syncStatus.isError,
      updateAvailable,
    }),
    updateAvailable,
  };
}
