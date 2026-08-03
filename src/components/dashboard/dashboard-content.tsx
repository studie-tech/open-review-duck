"use client";

import {
  CheckCheck,
  ChevronDown,
  GitMerge,
  GitPullRequest,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PullRequestList } from "~/components/dashboard/pull-request-list";
import { PageContainer } from "~/components/page-container";
import { Button } from "~/components/ui/button";
import { partitionReviewQueue } from "~/lib/review-queue";
import { api, type RouterOutputs } from "~/trpc/react";

type DashboardPullRequests = RouterOutputs["review"]["dashboard"];
type AiConfiguration = RouterOutputs["ai"]["configuration"];

/** Renders live dashboard data and follows durable synchronization progress. */
export function DashboardContent({
  initialPullRequests,
  initialAiConfiguration,
  localMode,
}: {
  initialPullRequests: DashboardPullRequests;
  initialAiConfiguration: AiConfiguration;
  localMode: boolean;
}) {
  const utils = api.useUtils();
  const [pendingPullRequestId, setPendingPullRequestId] = useState<string>();
  const activeSyncs = api.review.activeSyncs.useQuery(undefined, {
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      (query.state.data?.length ?? 0) > 0 ? 1_500 : false,
  });
  const pullRequests = api.review.dashboard.useQuery(undefined, {
    enabled: activeSyncs.isFetched,
    initialData: initialPullRequests,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const aiConfiguration = api.ai.configuration.useQuery(undefined, {
    initialData: initialAiConfiguration,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const hadActiveSync = useRef(false);
  const reviews = pullRequests.data ?? initialPullRequests;
  const synchronizing = activeSyncs.data ?? [];
  const configuration = aiConfiguration.data ?? initialAiConfiguration;

  /** Updates one queue item immediately while the server mutation settles. */
  function setQueueState(
    pullRequestId: string,
    queueState: "active" | "removed",
  ) {
    utils.review.dashboard.setData(undefined, (current) =>
      current?.map((pullRequest) =>
        pullRequest.id === pullRequestId
          ? {
              ...pullRequest,
              queueState,
              removedAt: queueState === "removed" ? new Date() : null,
            }
          : pullRequest,
      ),
    );
  }

  const restoreToQueue = api.review.restoreToQueue.useMutation({
    onMutate: ({ pullRequestId }) => {
      setPendingPullRequestId(pullRequestId);
      setQueueState(pullRequestId, "active");
    },
    onSuccess: () => toast.success("Restored to your review queue"),
    onError: (error) => {
      void utils.review.dashboard.invalidate();
      toast.error("Could not restore review", { description: error.message });
    },
    onSettled: () => setPendingPullRequestId(undefined),
  });
  const removeFromQueue = api.review.removeFromQueue.useMutation({
    onMutate: ({ pullRequestId }) => {
      setPendingPullRequestId(pullRequestId);
      setQueueState(pullRequestId, "removed");
    },
    onSuccess: (_result, variables) =>
      toast.success("Removed from your review queue", {
        description:
          "It stays under Removed and can be restored at any time. Automatic intake may bring it back after a new revision.",
        action: {
          label: "Undo",
          onClick: () =>
            restoreToQueue.mutate({
              pullRequestId: variables.pullRequestId,
            }),
        },
      }),
    onError: (error) => {
      void utils.review.dashboard.invalidate();
      toast.error("Could not remove review", { description: error.message });
    },
    onSettled: () => setPendingPullRequestId(undefined),
  });

  useEffect(() => {
    const hasActiveSync = synchronizing.length > 0;
    if (hadActiveSync.current && !hasActiveSync) {
      void pullRequests.refetch();
    }
    hadActiveSync.current = hasActiveSync;
  }, [pullRequests, synchronizing.length]);

  const { needsReview, reviewed, closed, removed } =
    partitionReviewQueue(reviews);
  const aiStatus =
    configuration.mode === "off"
      ? ["Off", "Enable when you want assistance"]
      : !configuration.configuration
        ? [
            "Setup",
            localMode
              ? "Connect your preferred model provider"
              : "Choose a managed model",
          ]
        : configuration.configuration.useManagedModels
          ? configuration.configuration.provider === "opencode"
            ? ["Free", "Managed Big Pickle with privacy controls"]
            : ["Subscriber", "Managed ZDR model with quota guardrails"]
          : localMode
            ? ["Connected", "Using your local AI configuration"]
            : ["BYOK", "Using your encrypted provider key"];

  return (
    <PageContainer>
      <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
        <div>
          <p className="text-lime text-xs font-semibold tracking-[.18em] uppercase">
            Review queue
          </p>
          <h1 className="font-editorial mt-3 text-4xl font-medium tracking-[-.04em] sm:text-5xl">
            Good code deserves attention.
          </h1>
          <p className="text-mist mt-3 max-w-xl text-sm leading-6">
            Continue from your last sign-off or pick up a fresh change. The
            dependency path is already prepared.
          </p>
        </div>
        <Button asChild>
          <Link href="/settings/providers">
            <Plus className="size-4" /> Add repository
          </Link>
        </Button>
      </div>

      <section className="mt-10 grid gap-4 sm:grid-cols-3">
        {[
          [
            "Needs review",
            String(needsReview.length),
            "Active work in your personal queue",
          ],
          [
            "Reviewed",
            String(reviewed.length),
            "Complete and awaiting provider outcome",
          ],
          ["AI assistant", aiStatus[0], aiStatus[1]],
        ].map(([label, value, detail], index) => (
          <article
            key={label}
            className="bg-surface rounded-2xl border border-line p-5 shadow-[0_14px_40px_var(--app-shadow)]"
          >
            <div className="flex items-center justify-between">
              <p className="text-mist text-xs">{label}</p>
              {index === 2 && <Sparkles className="text-violet size-3.5" />}
            </div>
            <p className="mt-3 text-2xl font-semibold tracking-tight">
              {value}
            </p>
            <p className="text-fog mt-1 text-[11px]">{detail}</p>
          </article>
        ))}
      </section>

      {synchronizing.length > 0 && (
        <section
          aria-live="polite"
          className="border-cyan/20 bg-cyan/[.045] mt-6 flex items-center gap-3 rounded-2xl border px-4 py-3"
        >
          <Loader2 className="text-cyan size-4 shrink-0 animate-spin" />
          <div className="min-w-0">
            <p className="text-cloud text-sm font-medium">
              {synchronizing.length === 1
                ? "Preparing a review"
                : `Preparing ${synchronizing.length} reviews`}
            </p>
            <p className="text-mist mt-0.5 text-xs">
              The review queue will update automatically when analysis
              completes.
            </p>
          </div>
        </section>
      )}

      <section className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium">Needs your review</h2>
          <span className="text-fog text-xs">
            {needsReview.length} pull requests
          </span>
        </div>
        {needsReview.length === 0 ? (
          <div className="bg-surface/55 grid min-h-80 place-items-center rounded-3xl border border-dashed border-line-strong p-8 text-center">
            <div>
              <span className="text-lime mx-auto grid size-12 place-items-center rounded-2xl bg-lime/10">
                {reviews.length > 0 ? (
                  <CheckCheck className="size-5" />
                ) : (
                  <GitPullRequest className="size-5" />
                )}
              </span>
              <h3 className="mt-5 text-lg font-medium">
                {synchronizing.length > 0
                  ? "Your review is being prepared"
                  : reviews.length > 0
                    ? "You're caught up"
                    : "Connect your first repository"}
              </h3>
              <p className="text-mist mx-auto mt-2 max-w-sm text-sm leading-6">
                {synchronizing.length > 0
                  ? "You can stay on this page. The pull request will appear as soon as its dependency path is ready."
                  : reviews.length > 0
                    ? "There is nothing waiting for review. Completed, closed, and removed work remains available below."
                    : "Add GitHub, GitLab, or Azure DevOps and choose the pull requests you want to review with full context."}
              </p>
              {synchronizing.length === 0 && reviews.length === 0 && (
                <Button asChild className="mt-6">
                  <Link href="/settings/providers">Connect a provider</Link>
                </Button>
              )}
            </div>
          </div>
        ) : (
          <PullRequestList
            pullRequests={needsReview}
            kind="active"
            pendingPullRequestId={pendingPullRequestId}
            onRemove={(pullRequest) =>
              removeFromQueue.mutate({ pullRequestId: pullRequest.id })
            }
          />
        )}
      </section>

      {reviewed.length > 0 && (
        <details className="group mt-8 rounded-2xl border border-line bg-surface/35">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4">
            <span className="bg-lime/10 text-lime grid size-8 place-items-center rounded-lg">
              <CheckCheck className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">
                Reviewed, awaiting merge
              </span>
              <span className="text-fog mt-0.5 block text-xs">
                Fully reviewed at the current provider revision
              </span>
            </span>
            <span className="text-mist text-xs">{reviewed.length}</span>
            <ChevronDown className="text-mist size-4 transition group-open:rotate-180" />
          </summary>
          <div className="border-t border-line p-3">
            <PullRequestList
              pullRequests={reviewed}
              kind="reviewed"
              pendingPullRequestId={pendingPullRequestId}
              onRemove={(pullRequest) =>
                removeFromQueue.mutate({ pullRequestId: pullRequest.id })
              }
            />
          </div>
        </details>
      )}

      {closed.length > 0 && (
        <details className="group mt-4 rounded-2xl border border-line bg-surface/35">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4">
            <span className="bg-cyan/10 text-cyan grid size-8 place-items-center rounded-lg">
              <GitMerge className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Closed history</span>
              <span className="text-fog mt-0.5 block text-xs">
                Merged and closed pull requests
              </span>
            </span>
            <span className="text-mist text-xs">{closed.length}</span>
            <ChevronDown className="text-mist size-4 transition group-open:rotate-180" />
          </summary>
          <div className="border-t border-line p-3">
            <PullRequestList pullRequests={closed} kind="closed" />
          </div>
        </details>
      )}

      {removed.length > 0 && (
        <details className="group mt-4 rounded-2xl border border-line bg-surface/35">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4">
            <span className="bg-surface-subtle text-mist grid size-8 place-items-center rounded-lg">
              <RotateCcw className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">
                Removed from my queue
              </span>
              <span className="text-fog mt-0.5 block text-xs">
                Hidden until restored or a new revision arrives
              </span>
            </span>
            <span className="text-mist text-xs">{removed.length}</span>
            <ChevronDown className="text-mist size-4 transition group-open:rotate-180" />
          </summary>
          <div className="border-t border-line p-3">
            <PullRequestList
              pullRequests={removed}
              kind="removed"
              pendingPullRequestId={pendingPullRequestId}
              onRestore={(pullRequest) =>
                restoreToQueue.mutate({ pullRequestId: pullRequest.id })
              }
            />
          </div>
        </details>
      )}
    </PageContainer>
  );
}
