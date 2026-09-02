"use client";

import {
  Check,
  ChevronRight,
  CircleDot,
  ExternalLink,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { providerLabel } from "~/lib/provider-labels";
import { cn } from "~/lib/utils";
import type { RouterOutputs } from "~/trpc/react";

type ProviderConversations = RouterOutputs["review"]["providerConversations"];
export type ProviderDiscussionThread = ProviderConversations["threads"][number];

type DiscussionTab = "open" | "resolved";

/** Treats provider-unknown resolution as active so it can never disappear. */
export function isOpenProviderDiscussion(thread: ProviderDiscussionThread) {
  return thread.status !== "resolved";
}

/** Orders discussions deterministically by file, line, then provider identity. */
export function orderProviderDiscussions(threads: ProviderDiscussionThread[]) {
  return [...threads].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.externalId.localeCompare(right.externalId),
  );
}

/** Returns the latest provider comment, falling back safely for empty threads. */
function latestDiscussionComment(thread: ProviderDiscussionThread) {
  return thread.comments.at(-1);
}

/** Formats compact provider activity timestamps in the reviewer's locale. */
function discussionTimestamp(value: string | undefined) {
  if (!value) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** Renders one compact PR-wide conversation entry. */
function DiscussionRow({
  onOpen,
  resolved,
  thread,
}: {
  onOpen: () => void;
  resolved: boolean;
  thread: ProviderDiscussionThread;
}) {
  const latest = latestDiscussionComment(thread);
  const commentCount = thread.comments.length;

  return (
    <article className="group rounded-xl border border-line bg-surface/65 transition hover:border-line-strong hover:bg-surface">
      <div className="flex items-start gap-1 p-2.5 sm:p-3">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 rounded-lg p-1.5 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-cyan/50"
        >
          <span className="flex min-w-0 items-center gap-2">
            {resolved ? (
              <Check className="text-lime size-3.5 shrink-0" />
            ) : (
              <CircleDot className="text-coral size-3.5 shrink-0" />
            )}
            <span className="text-cloud min-w-0 flex-1 truncate font-mono text-[10px] font-medium">
              {thread.path}
            </span>
            <span className="text-fog shrink-0 font-mono text-[9px]">
              L{thread.line}
            </span>
          </span>
          <span className="text-mist mt-2 line-clamp-3 block text-[11px] leading-5">
            {latest?.body ||
              "This provider conversation has no visible comments."}
          </span>
          <span className="text-fog mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[9px]">
            {latest?.author && <span>{latest.author}</span>}
            {latest?.author && <span aria-hidden="true">·</span>}
            <span>
              {commentCount} {commentCount === 1 ? "comment" : "comments"}
            </span>
            {latest?.createdAt && <span aria-hidden="true">·</span>}
            {latest?.createdAt && (
              <time dateTime={latest.createdAt}>
                {discussionTimestamp(latest.createdAt)}
              </time>
            )}
          </span>
        </button>
        {thread.webUrl && (
          <a
            href={thread.webUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open the conversation in ${thread.path} on the provider`}
            title="Open on provider"
            className="text-fog hover:text-cloud grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-surface-hover"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
    </article>
  );
}

/** Shows every provider conversation in a PR-wide review drawer. */
export function ReviewDiscussionsPanel({
  error,
  loading,
  onClose,
  onOpenThread,
  onRefresh,
  provider,
  threads,
}: {
  error?: string;
  loading: boolean;
  onClose: () => void;
  onOpenThread: (thread: ProviderDiscussionThread) => void;
  onRefresh: () => void;
  provider: ProviderConversations["provider"];
  threads: ProviderDiscussionThread[];
}) {
  const [tab, setTab] = useState<DiscussionTab>("open");
  const ordered = useMemo(() => orderProviderDiscussions(threads), [threads]);
  const openThreads = ordered.filter(isOpenProviderDiscussion);
  const resolvedThreads = ordered.filter(
    (thread) => !isOpenProviderDiscussion(thread),
  );
  const visibleThreads = tab === "open" ? openThreads : resolvedThreads;
  const providerName = providerLabel(provider);

  return (
    <aside
      id="review-discussions-panel"
      aria-label="Pull request discussions"
      className="bg-panel fixed top-16 right-0 bottom-0 z-50 flex w-[min(420px,calc(100vw-2rem))] flex-col border-l border-line shadow-2xl"
    >
      <header className="shrink-0 border-b border-line px-4 pt-4 sm:px-5">
        <div className="flex items-start gap-3">
          <span className="bg-cyan/10 text-cyan grid size-9 shrink-0 place-items-center rounded-xl">
            <MessageSquareText className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
              {providerName} · PR-wide
            </p>
            <h2 className="text-cloud mt-1 text-sm font-medium">Discussions</h2>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh pull request discussions"
            title="Refresh discussions"
            className="text-mist hover:text-cloud grid size-8 place-items-center rounded-lg transition hover:bg-surface-hover disabled:cursor-wait disabled:opacity-50"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close pull request discussions"
            className="text-mist hover:text-cloud grid size-8 place-items-center rounded-lg transition hover:bg-surface-hover"
          >
            <X className="size-4" />
          </button>
        </div>
        <div
          className="mt-4 flex gap-5"
          role="tablist"
          aria-label="Discussion status"
        >
          {(
            [
              ["open", `Open ${openThreads.length}`],
              ["resolved", `Resolved ${resolvedThreads.length}`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={cn(
                "border-b-2 px-0.5 pb-3 text-[10px] font-semibold transition",
                tab === value
                  ? "border-cyan text-cyan"
                  : "text-fog hover:text-mist border-transparent",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4">
        {error ? (
          <div className="border-coral/20 bg-coral/[.055] rounded-xl border p-4">
            <p className="text-coral text-xs font-medium">
              Discussions could not be synchronized
            </p>
            <p className="text-mist mt-2 text-[10px] leading-5">{error}</p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-4"
              onClick={onRefresh}
            >
              <RefreshCw className="size-3.5" />
              Try again
            </Button>
          </div>
        ) : loading && threads.length === 0 ? (
          <div
            role="status"
            className="text-mist flex items-center justify-center gap-2 py-16 text-xs"
          >
            <LoaderCircle className="size-4 animate-spin" />
            Synchronizing discussions…
          </div>
        ) : visibleThreads.length > 0 ? (
          <div className="space-y-2.5">
            {visibleThreads.map((thread) => (
              <DiscussionRow
                key={thread.externalId}
                resolved={tab === "resolved"}
                thread={thread}
                onOpen={() => onOpenThread(thread)}
              />
            ))}
          </div>
        ) : (
          <div className="grid place-items-center px-6 py-16 text-center">
            <span className="border-lime/20 bg-lime/[.07] text-lime grid size-11 place-items-center rounded-2xl border">
              <Check className="size-5" />
            </span>
            <p className="text-cloud mt-4 text-sm font-medium">
              {tab === "open"
                ? "No open discussions"
                : "No resolved discussions yet"}
            </p>
            <p className="text-mist mt-2 text-[10px] leading-5">
              {tab === "open"
                ? "The collaboration loop is clear at the current provider state."
                : "Resolved conversations will remain available here for audit."}
            </p>
          </div>
        )}
      </div>

      <footer className="text-fog shrink-0 border-t border-line bg-surface/45 px-4 py-3 text-[9px] leading-4 sm:px-5">
        Resolved discussions stay folded by default. Opening a discussion
        returns to its exact review unit and line.
      </footer>
    </aside>
  );
}

/** Summarizes active and resolved provider discussions on completion. */
export function ReviewDiscussionSummary({
  onOpenThread,
  provider,
  threads,
}: {
  onOpenThread: (thread: ProviderDiscussionThread) => void;
  provider: ProviderConversations["provider"];
  threads: ProviderDiscussionThread[];
}) {
  const ordered = useMemo(() => orderProviderDiscussions(threads), [threads]);
  const openThreads = ordered.filter(isOpenProviderDiscussion);
  const resolvedThreads = ordered.filter(
    (thread) => !isOpenProviderDiscussion(thread),
  );
  const providerName = providerLabel(provider);

  return (
    <section
      aria-labelledby="review-discussion-summary-title"
      className="overflow-hidden rounded-2xl border border-line bg-panel/70"
    >
      <div className="flex flex-wrap items-start gap-3 p-4 sm:p-5">
        <span
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-xl",
            openThreads.length > 0
              ? "bg-coral/10 text-coral"
              : "bg-lime/10 text-lime",
          )}
        >
          {openThreads.length > 0 ? (
            <MessageSquareText className="size-4" />
          ) : (
            <Check className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-fog text-[9px] font-semibold tracking-[.15em] uppercase">
            Discussion status
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h3
              id="review-discussion-summary-title"
              className="text-sm text-cloud"
            >
              {openThreads.length > 0
                ? `${openThreads.length} ${openThreads.length === 1 ? "discussion remains" : "discussions remain"} open`
                : "All discussions are resolved"}
            </h3>
            <Badge
              className={cn(
                openThreads.length > 0
                  ? "border-coral/25 bg-coral/10 text-coral"
                  : "border-lime/25 bg-lime/10 text-lime",
              )}
            >
              {openThreads.length} open
            </Badge>
          </div>
          <p className="text-mist mt-2 text-[10px] leading-5">
            Code coverage is complete. {providerName} conversation resolution is
            tracked separately so unfinished collaboration stays visible.
          </p>
        </div>
      </div>

      {openThreads.length > 0 && (
        <div className="max-h-[28rem] space-y-2 overflow-y-auto border-t border-line p-3 sm:p-4">
          {openThreads.map((thread) => (
            <DiscussionRow
              key={thread.externalId}
              resolved={false}
              thread={thread}
              onOpen={() => onOpenThread(thread)}
            />
          ))}
        </div>
      )}

      <details className="group border-t border-line">
        <summary className="text-mist hover:text-cloud flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[10px] transition marker:hidden sm:px-5">
          <ChevronRight className="size-3.5 transition group-open:rotate-90" />
          <span className="font-medium">
            {resolvedThreads.length} resolved{" "}
            {resolvedThreads.length === 1 ? "discussion" : "discussions"}
          </span>
          <span className="text-fog ml-auto">Folded by default</span>
        </summary>
        {resolvedThreads.length > 0 && (
          <div className="max-h-80 space-y-2 overflow-y-auto border-t border-line bg-surface/25 p-3 sm:p-4">
            {resolvedThreads.map((thread) => (
              <DiscussionRow
                key={thread.externalId}
                resolved
                thread={thread}
                onOpen={() => onOpenThread(thread)}
              />
            ))}
          </div>
        )}
      </details>
    </section>
  );
}
