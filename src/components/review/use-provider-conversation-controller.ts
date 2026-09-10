"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { providerLabel } from "~/lib/provider-labels";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  mergePendingProviderThreads,
  type ProviderThreadChange,
  pendingProviderThreadFromComment,
  providerThreadsForVisibleUnits,
  reshapeProviderThreads,
  restoreProviderThread,
  withPublishedDiscussionComment,
} from "./review-workspace-hooks";
import type { ProviderConversationActions } from "./review-workspace-provider-conversation";

type WorkspacePullRequest = RouterOutputs["review"]["workspace"]["pullRequest"];
type ProviderConversations = RouterOutputs["review"]["providerConversations"];
type ProviderConversationThread = ProviderConversations["threads"][number];
type DiscussionComment =
  RouterOutputs["review"]["unitDiscussion"]["comments"][number];

interface ProviderConversationControllerInput {
  clearDraft: () => void;
  pullRequest: WorkspacePullRequest;
  refreshIntervalMs: number;
  settledUnitId?: string;
  unitPathById: ReadonlyMap<string, string>;
  visibleUnitIds: readonly string[];
  waitingCount: number;
}

/**
 * Owns provider-conversation reads, optimistic cache changes, and mutations.
 *
 * Review navigation consumes the resulting threads but does not need to know
 * how GitHub, GitLab, or Azure mutations reconcile their cached snapshots.
 */
export function useProviderConversationController({
  clearDraft,
  pullRequest,
  refreshIntervalMs,
  settledUnitId,
  unitPathById,
  visibleUnitIds,
  waitingCount,
}: ProviderConversationControllerInput) {
  const utils = api.useUtils();
  const [pendingThreads, setPendingThreads] = useState<
    ProviderConversationThread[]
  >([]);
  const discussion = api.review.unitDiscussion.useQuery(
    { unitId: settledUnitId ?? "" },
    { enabled: Boolean(settledUnitId) },
  );
  const conversations = api.review.providerConversations.useQuery(
    { pullRequestId: pullRequest.id },
    {
      retry: false,
      staleTime: refreshIntervalMs,
      refetchOnWindowFocus: true,
      refetchInterval: waitingCount > 0 ? refreshIntervalMs : false,
    },
  );

  const notifiedAnsweredUnits = useRef(new Set<string>());
  useEffect(() => {
    const answeredUnitIds =
      conversations.data?.answeredUnitIds.filter(
        (unitId) => !notifiedAnsweredUnits.current.has(unitId),
      ) ?? [];
    if (answeredUnitIds.length === 0) return;
    for (const unitId of answeredUnitIds) {
      notifiedAnsweredUnits.current.add(unitId);
    }
    toast.info(
      answeredUnitIds.length === 1
        ? "A waiting conversation has a response"
        : `${answeredUnitIds.length} waiting conversations have responses`,
      {
        description:
          "The work stays in Waiting until you resume it — open it to see what changed.",
      },
    );
  }, [conversations.data?.answeredUnitIds]);

  const visibleThreads = useMemo(() => {
    const listed = providerThreadsForVisibleUnits(
      conversations.data?.threads,
      visibleUnitIds,
    );
    return mergePendingProviderThreads(listed, pendingThreads);
  }, [conversations.data?.threads, pendingThreads, visibleUnitIds]);

  useEffect(() => {
    const listed = new Set(
      (conversations.data?.threads ?? []).map(({ externalId }) => externalId),
    );
    if (listed.size === 0) return;
    setPendingThreads((current) => {
      const next = current.filter(({ externalId }) => !listed.has(externalId));
      return next.length === current.length ? current : next;
    });
  }, [conversations.data?.threads]);

  const publishComment = api.review.publishComment.useMutation({
    onSuccess: (comment) => {
      toast.success("Comment published", {
        description: `Your inline comment is now on ${providerLabel(pullRequest.provider)}.`,
      });
      clearDraft();
      rememberPublishedComment(comment);
      void discussion.refetch();
      void conversations.refetch();
    },
    onError: (error) => toast.error(error.message),
  });

  /** Keeps a just-posted comment on the file card if the reviewer leaves. */
  function rememberPublishedComment(comment: DiscussionComment) {
    utils.review.unitDiscussion.setData({ unitId: comment.unitId }, (current) =>
      withPublishedDiscussionComment(current, comment),
    );
    const path = unitPathById.get(comment.unitId);
    const pending = path
      ? pendingProviderThreadFromComment(comment, path)
      : undefined;
    if (!pending) return;
    setPendingThreads((current) =>
      mergePendingProviderThreads(
        current.filter(({ externalId }) => externalId !== pending.externalId),
        [pending],
      ),
    );
  }

  /** Applies one optimistic provider change and returns its rollback snapshot. */
  async function applyConversationChange(change: ProviderThreadChange) {
    const key = { pullRequestId: pullRequest.id };
    await utils.review.providerConversations.cancel(key);
    const previous = utils.review.providerConversations.getData(key);
    utils.review.providerConversations.setData(
      key,
      (current) =>
        current && {
          ...current,
          threads: reshapeProviderThreads(current.threads, change),
        },
    );
    return { previous };
  }

  /** Restores the provider thread changed by a failed optimistic mutation. */
  function restoreCachedConversations(
    previous: ProviderConversations | undefined,
    threadExternalId: string,
  ) {
    utils.review.providerConversations.setData(
      { pullRequestId: pullRequest.id },
      (current) =>
        previous && current
          ? {
              ...current,
              threads: restoreProviderThread(
                current.threads,
                previous.threads,
                threadExternalId,
              ),
            }
          : (previous ?? current),
    );
  }

  /** Schedules the provider read that reconciles an optimistic mutation. */
  function reconcileConversations() {
    return utils.review.providerConversations.invalidate({
      pullRequestId: pullRequest.id,
    });
  }

  const replyToThread = api.review.replyToThread.useMutation({
    onSuccess: async () => {
      toast.success("Reply published", {
        description: `The conversation was updated on ${providerLabel(pullRequest.provider)}.`,
      });
      await reconcileConversations();
    },
    onError: (error) => toast.error(error.message),
  });
  const setThreadResolution = api.review.setThreadResolution.useMutation({
    onMutate: ({ threadExternalId, resolved }) =>
      applyConversationChange({
        kind: "resolution",
        threadExternalId,
        resolved,
      }),
    onSuccess: ({ resolved }) => {
      toast.success(
        resolved ? "Conversation resolved" : "Conversation reopened",
        {
          description: `The change is live on ${providerLabel(pullRequest.provider)}.`,
        },
      );
      void reconcileConversations();
    },
    onError: (error, input, context) => {
      if (context) {
        restoreCachedConversations(context.previous, input.threadExternalId);
      }
      toast.error(error.message);
    },
  });
  const editThreadComment = api.review.editThreadComment.useMutation({
    onMutate: ({ threadExternalId, commentExternalId, body }) =>
      applyConversationChange({
        kind: "edit-comment",
        threadExternalId,
        commentExternalId,
        body,
      }),
    onSuccess: () => {
      toast.success("Comment updated", {
        description: `The new text is live on ${providerLabel(pullRequest.provider)}.`,
      });
      void Promise.all([discussion.refetch(), reconcileConversations()]);
    },
    onError: (error, input, context) => {
      if (context) {
        restoreCachedConversations(context.previous, input.threadExternalId);
      }
      toast.error(error.message);
    },
  });
  const deleteThreadComment = api.review.deleteThreadComment.useMutation({
    onMutate: ({ threadExternalId, commentExternalId }) =>
      applyConversationChange({
        kind: "delete-comment",
        threadExternalId,
        commentExternalId,
      }),
    onSuccess: () => {
      toast.success("Comment deleted", {
        description: `It is gone from ${providerLabel(pullRequest.provider)}.`,
      });
      void Promise.all([discussion.refetch(), reconcileConversations()]);
    },
    onError: (error, input, context) => {
      if (context) {
        restoreCachedConversations(context.previous, input.threadExternalId);
      }
      toast.error(error.message);
    },
  });
  const deleteThread = api.review.deleteThread.useMutation({
    onMutate: ({ threadExternalId }) =>
      applyConversationChange({ kind: "delete-thread", threadExternalId }),
    onSuccess: ({ deleted }) => {
      toast.success("Conversation deleted", {
        description: `${deleted} ${deleted === 1 ? "comment is" : "comments are"} gone from ${providerLabel(pullRequest.provider)}.`,
      });
      void Promise.all([discussion.refetch(), reconcileConversations()]);
    },
    onError: (error, input, context) => {
      if (context) {
        restoreCachedConversations(context.previous, input.threadExternalId);
      }
      toast.error(error.message);
    },
  });

  /** Reports whether one named conversation is currently being changed. */
  function managingThread(threadExternalId: string) {
    return [
      setThreadResolution,
      editThreadComment,
      deleteThreadComment,
      deleteThread,
    ].some(
      (mutation) =>
        mutation.isPending &&
        mutation.variables?.threadExternalId === threadExternalId,
    );
  }

  /** Reports whether a reply is being published to one conversation. */
  function replyingToThread(threadExternalId: string) {
    return (
      replyToThread.isPending &&
      replyToThread.variables?.threadExternalId === threadExternalId
    );
  }

  /** Binds the provider mutations to one conversation. */
  function providerThreadActions(
    unitId: string,
    threadExternalId: string,
  ): ProviderConversationActions {
    return {
      onDeleteComment: (commentExternalId) =>
        deleteThreadComment.mutateAsync({
          unitId,
          threadExternalId,
          commentExternalId,
        }),
      onDeleteThread: () =>
        deleteThread.mutateAsync({ unitId, threadExternalId }),
      onEditComment: (commentExternalId, body) =>
        editThreadComment.mutateAsync({
          unitId,
          threadExternalId,
          commentExternalId,
          body,
        }),
      onReply: (body) =>
        replyToThread.mutateAsync({ unitId, threadExternalId, body }),
      onResolve: (resolved) =>
        setThreadResolution.mutateAsync({
          unitId,
          threadExternalId,
          resolved,
        }),
    };
  }

  return {
    conversations,
    discussion,
    managingThread,
    providerThreadActions,
    publishComment,
    replyingToThread,
    visibleThreads,
  };
}
