"use client";

import {
  ArrowDownWideNarrow,
  Check,
  ChevronRight,
  CircleDot,
  ExternalLink,
  ImageIcon,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Badge } from "~/components/ui/badge";
import {
  type AiFixPromptPullRequest,
  discussionFixPrompt,
} from "~/lib/ai-fix-prompt";
import { providerCommentHasImages } from "~/lib/comment-images";
import { matchesShortcutStroke } from "~/lib/keyboard-shortcuts";
import { providerLabel } from "~/lib/provider-labels";
import { reviewShortcuts } from "~/lib/review-shortcuts";
import { cn } from "~/lib/utils";
import type { RouterOutputs } from "~/trpc/react";
import { CopyAiFixPromptButton } from "./copy-ai-fix-prompt-button";
import {
  discussionTimestamp,
  ReviewDiscussionDetail,
} from "./review-discussion-detail";

type ProviderConversations = RouterOutputs["review"]["providerConversations"];
export type ProviderDiscussionThread =
  ProviderConversations["threads"][number] & {
    kind?: "code";
  };
type PullRequestComment = ProviderConversations["pullRequestComments"][number];
const emptyPullRequestComments: PullRequestComment[] = [];
export type ProviderDiscussionConversation =
  | ProviderDiscussionThread
  | {
      kind: "pull_request";
      externalId: string;
      webUrl?: string;
      comments: PullRequestComment[];
      path?: never;
      line?: never;
      side?: never;
      status?: never;
      unitId?: never;
    };

type DiscussionTab = "all" | "open" | "resolved" | "comments";
type DiscussionSort = "recent" | "oldest" | "file";

/** Treats provider-unknown resolution as active so it can never disappear. */
export function isOpenProviderDiscussion(
  thread: ProviderDiscussionConversation,
) {
  return thread.kind !== "pull_request" && thread.status !== "resolved";
}

/** Orders discussions deterministically by file, line, then provider identity. */
export function orderProviderDiscussions<
  T extends ProviderDiscussionConversation,
>(threads: T[]) {
  return [...threads].sort(
    (left, right) =>
      (left.path ?? "").localeCompare(right.path ?? "") ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.externalId.localeCompare(right.externalId),
  );
}

/** Returns the latest provider comment, falling back safely for empty threads. */
function latestDiscussionComment(thread: ProviderDiscussionThread) {
  return thread.comments.at(-1);
}

/** Renders one compact PR-wide conversation entry. */
function DiscussionRow({
  onOpen,
  pullRequest,
  resolved,
  thread,
}: {
  onOpen: () => void;
  pullRequest: AiFixPromptPullRequest;
  resolved: boolean;
  thread: ProviderDiscussionThread;
}) {
  const latest = latestDiscussionComment(thread);
  const commentCount = thread.comments.length;
  const [commentExpanded, setCommentExpanded] = useState(false);
  const commentBody =
    latest?.body || "This provider conversation has no visible comments.";
  const canExpandComment =
    commentBody.length > 140 || commentBody.split("\n").length > 2;
  const commentId = `${useId()}-comment`;

  return (
    <article className="group overflow-hidden rounded-xl border border-line bg-surface/65 transition hover:border-cyan/25 hover:bg-surface">
      <div className="flex items-start gap-1 px-2.5 pt-2.5 sm:px-3 sm:pt-3">
        <button
          type="button"
          onClick={onOpen}
          disabled={!thread.unitId}
          aria-label={`Open conversation in ${thread.path} at line ${thread.line}`}
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
          <span
            id={commentId}
            className={cn(
              "text-mist mt-2 whitespace-pre-wrap text-[11px] leading-5",
              commentExpanded ? "block" : "line-clamp-2",
            )}
          >
            {commentBody}
          </span>
        </button>
        {!resolved && (
          <CopyAiFixPromptButton
            className="size-8 rounded-lg"
            subject={`the conversation in ${thread.path} at line ${thread.line}`}
            prompt={() => discussionFixPrompt(pullRequest, thread)}
          />
        )}
        {(thread.webUrl || pullRequest.webUrl) && (
          <a
            href={thread.webUrl || pullRequest.webUrl}
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
      <div className="flex min-h-9 items-center gap-2 border-t border-line/70 px-4 py-2">
        <span className="text-fog min-w-0 flex-1 truncate text-[9px]">
          {latest?.author && <span>{latest.author}</span>}
          {latest?.author && <span aria-hidden="true"> · </span>}
          <span>
            {commentCount} {commentCount === 1 ? "comment" : "comments"}
          </span>
          {latest?.createdAt && <span aria-hidden="true"> · </span>}
          {latest?.createdAt && (
            <time dateTime={latest.createdAt}>
              {discussionTimestamp(latest.createdAt)}
            </time>
          )}
        </span>
        {canExpandComment && (
          <button
            type="button"
            aria-controls={commentId}
            aria-expanded={commentExpanded}
            onClick={() => setCommentExpanded((expanded) => !expanded)}
            className="text-mist hover:text-cloud shrink-0 rounded px-1.5 py-1 text-[9px] font-medium transition hover:bg-surface-hover"
          >
            {commentExpanded ? "Show less" : "Show more"}
          </button>
        )}
        {thread.unitId && (
          <button
            type="button"
            onClick={onOpen}
            className="text-cyan hover:bg-cyan/10 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[9px] font-semibold transition"
          >
            Open
            <ChevronRight className="size-3" aria-hidden="true" />
          </button>
        )}
      </div>
    </article>
  );
}

/** Removes presentation syntax from the thread list while retaining readable text. */
function discussionPreview(body: string, query = "") {
  const text = body
    .replace(/<[^>]+>/gu, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[`#*_>]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const index = query.trim()
    ? text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase())
    : -1;
  return index > 80 ? `…${text.slice(index - 60)}` : text;
}

/** Reads the latest activity time independently of provider comment ordering. */
function discussionActivity(thread: ProviderDiscussionConversation) {
  return Math.max(
    0,
    ...thread.comments.map(({ createdAt }) => Date.parse(createdAt) || 0),
  );
}

/** Highlights literal search terms in compact list previews. */
function DiscussionSearchText({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const term = query.trim();
  const index = term
    ? text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase())
    : -1;
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="bg-cyan/15 rounded-sm text-cloud">
        {text.slice(index, index + term.length)}
      </mark>
      {text.slice(index + term.length)}
    </>
  );
}

/** Browses complete PR-wide conversations in a responsive full-screen dialog. */
export function ReviewDiscussionsPanel({
  error,
  loading,
  onClose,
  onOpenThread,
  onRefresh,
  pullRequest,
  pullRequestComments = emptyPullRequestComments,
  threads,
}: {
  error?: string;
  loading: boolean;
  onClose: () => void;
  onOpenThread: (thread: ProviderDiscussionThread) => void;
  onRefresh: () => void;
  pullRequest: AiFixPromptPullRequest;
  pullRequestComments?: PullRequestComment[];
  threads: ProviderDiscussionThread[];
}) {
  const [status, setStatus] = useState<DiscussionTab | "auto">("auto");
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [author, setAuthor] = useState("");
  const [imagesOnly, setImagesOnly] = useState(false);
  const [sort, setSort] = useState<DiscussionSort>("recent");
  const [selectedId, setSelectedId] = useState<string>();
  const [mobileDetail, setMobileDetail] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const focusAfterNavigation = useRef<"list" | "search" | undefined>(undefined);
  const id = useId();
  const titleId = `${id}-title`;
  const listId = `${id}-threads`;
  const ordered = useMemo(
    () =>
      orderProviderDiscussions<ProviderDiscussionConversation>([
        ...threads,
        ...pullRequestComments.map((comment) => ({
          kind: "pull_request" as const,
          externalId: `pull-request:${comment.externalId}`,
          webUrl: comment.webUrl,
          comments: [comment],
        })),
      ]),
    [threads, pullRequestComments],
  );
  const openCount = ordered.filter(isOpenProviderDiscussion).length;
  const resolvedCount = threads.filter(
    ({ status }) => status === "resolved",
  ).length;
  const totalCount = ordered.length;
  // Searching from the default view includes resolved replies; an explicit status stays put.
  const tab =
    status === "auto"
      ? query.trim() || pullRequestComments.length > 0 || openCount === 0
        ? "all"
        : "open"
      : status;
  const entryName =
    tab === "comments"
      ? "comment"
      : tab === "all" && pullRequestComments.length
        ? "conversation"
        : "thread";
  const term = query.trim().toLocaleLowerCase();
  const indexed = useMemo(
    () =>
      ordered.map((thread) => ({
        thread,
        activity: discussionActivity(thread),
        images: thread.comments.some(({ body }) =>
          providerCommentHasImages(body),
        ),
        text: [
          thread.path,
          ...thread.comments.flatMap(({ author, body }) => [author, body]),
        ]
          .join(" ")
          .toLocaleLowerCase(),
      })),
    [ordered],
  );
  const paths = [...new Set(threads.map(({ path }) => path))];
  const authors = [
    ...new Set(
      ordered
        .flatMap(({ comments }) => comments.map(({ author }) => author))
        .filter(Boolean),
    ),
  ].sort();
  const visible = indexed
    .filter(
      ({ thread, text, images }) =>
        (tab === "all" ||
          (tab === "open"
            ? isOpenProviderDiscussion(thread)
            : tab === "resolved"
              ? thread.status === "resolved"
              : thread.kind === "pull_request")) &&
        (!path || thread.path === path) &&
        (!author ||
          thread.comments.some((comment) => comment.author === author)) &&
        (!imagesOnly || images) &&
        (!term || text.includes(term)),
    )
    .sort((left, right) =>
      sort === "file"
        ? 0
        : sort === "recent"
          ? right.activity - left.activity
          : left.activity - right.activity,
    );
  const selected =
    visible.find(({ thread }) => thread.externalId === selectedId)?.thread ??
    visible[0]?.thread;
  const selectedThreadId = selected?.externalId;
  const hasFilters = Boolean(query || path || author || imagesOnly);
  const providerName = providerLabel(pullRequest.provider);
  const filterClass =
    "border-line bg-surface text-mist focus:border-cyan h-8 min-w-0 rounded-lg border px-2 text-[11px]! outline-none focus-visible:ring-2 focus-visible:ring-cyan/30";

  useEffect(() => {
    if (selectedThreadId) setSelectedId(selectedThreadId);
  }, [selectedThreadId]);

  useEffect(() => {
    if (!mobileDetail && focusAfterNavigation.current) {
      if (focusAfterNavigation.current === "search") {
        searchInput.current?.focus();
        searchInput.current?.select();
      } else if (selectedThreadId) {
        document.getElementById(`${id}-thread-${selectedThreadId}`)?.focus();
      }
      focusAfterNavigation.current = undefined;
    }
  }, [mobileDetail, selectedThreadId, id]);

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (element && !element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
      closeButton.current?.focus();
    }
    return () => {
      document.body.style.overflow = previousOverflow;
      if (element?.open && typeof element.close === "function") element.close();
      previousFocus?.focus();
    };
  }, []);

  /** Restores the default scope and clears every content filter together. */
  function resetFilters() {
    setQuery("");
    setPath("");
    setAuthor("");
    setImagesOnly(false);
    setStatus("auto");
    setMobileDetail(false);
  }

  return (
    <dialog
      ref={dialog}
      id="review-discussions-panel"
      aria-modal="true"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        const [toggleShortcut] = reviewShortcuts.discussions;
        if (
          toggleShortcut &&
          matchesShortcutStroke(event.nativeEvent, toggleShortcut)
        ) {
          event.preventDefault();
          onClose();
          return;
        }
        if (
          event.target instanceof Element &&
          event.target.closest("dialog") !== event.currentTarget
        )
          return;
        if ((event.metaKey || event.ctrlKey) && event.key === "f") {
          event.preventDefault();
          if (mobileDetail) {
            focusAfterNavigation.current = "search";
            setMobileDetail(false);
          } else {
            searchInput.current?.focus();
            searchInput.current?.select();
          }
        }
      }}
      className="bg-panel text-cloud fixed inset-0 z-50 m-0 hidden h-dvh max-h-none w-screen max-w-none flex-col overflow-hidden border-0 p-0 shadow-2xl open:flex backdrop:bg-black/45"
    >
      <header className="border-line flex shrink-0 items-center gap-3 border-b px-4 py-4 sm:px-6">
        <span className="bg-cyan/10 text-cyan grid size-10 shrink-0 place-items-center rounded-xl">
          <MessageSquareText className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id={titleId}
            className="text-cloud text-lg font-semibold tracking-tight"
          >
            Discussions
          </h2>
          <p className="text-fog mt-0.5 truncate text-xs">
            {pullRequest.repositoryOwner}/{pullRequest.repositoryName}
            <span aria-hidden="true"> · </span>#{pullRequest.number}
            <span className="hidden sm:inline"> · {pullRequest.title}</span>
          </p>
        </div>
        <span className="text-fog mr-2 hidden items-center gap-1.5 text-[11px] lg:flex">
          <span className="bg-cyan size-1.5 rounded-full" /> {providerName}{" "}
          discussions
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh pull request discussions"
          title="Refresh discussions"
          className="text-mist hover:text-cloud flex h-9 items-center gap-2 rounded-lg px-2.5 transition hover:bg-surface-hover disabled:cursor-wait disabled:opacity-50"
        >
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          <span className="hidden text-xs sm:inline">Refresh</span>
        </button>
        <span className="bg-line mx-1 h-6 w-px" aria-hidden="true" />
        <button
          ref={closeButton}
          type="button"
          onClick={onClose}
          aria-label="Close pull request discussions"
          className="text-mist hover:text-cloud flex h-9 items-center gap-2 rounded-lg px-2.5 transition hover:bg-surface-hover"
        >
          <span className="hidden text-xs sm:inline">Back to review</span>
          <X className="size-4" />
        </button>
      </header>

      <div
        className={cn(
          "border-line bg-panel shrink-0 border-b px-4 py-4 sm:px-6",
          mobileDetail && selected && "hidden md:block",
        )}
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="border-line bg-surface focus-within:border-cyan flex h-10 min-w-0 flex-[1_1_280px] items-center gap-2.5 rounded-xl border px-3">
            <Search className="text-fog size-4 shrink-0" aria-hidden="true" />
            <input
              ref={searchInput}
              type="search"
              aria-label="Search discussions"
              placeholder="Search threads, replies, people, or files…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setMobileDetail(false);
              }}
              className="text-cloud placeholder:text-fog min-w-0 flex-1 bg-transparent text-xs! outline-none [&::-webkit-search-cancel-button]:hidden"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear discussion search"
                onClick={() => {
                  setQuery("");
                  searchInput.current?.focus();
                }}
                className="text-fog hover:text-cloud"
              >
                <X className="size-3.5" />
              </button>
            ) : (
              <kbd className="text-fog hidden text-[10px] sm:inline">
                ⌘ / Ctrl F
              </kbd>
            )}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <select
              aria-label="Filter discussions by file"
              className={cn(filterClass, "max-w-48")}
              value={path}
              onChange={(event) => {
                setPath(event.target.value);
                setMobileDetail(false);
              }}
            >
              <option value="">All files</option>
              {paths.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter discussions by participant"
              className={cn(filterClass, "max-w-40")}
              value={author}
              onChange={(event) => {
                setAuthor(event.target.value);
                setMobileDetail(false);
              }}
            >
              <option value="">Anyone</option>
              {authors.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-pressed={imagesOnly}
              onClick={() => {
                setImagesOnly((value) => !value);
                setMobileDetail(false);
              }}
              className={cn(
                filterClass,
                "flex items-center gap-1.5",
                imagesOnly && "border-cyan/40 bg-cyan/10 text-cyan",
              )}
            >
              <ImageIcon className="size-3.5" /> With images
            </button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div
            className="flex max-w-full flex-wrap items-center gap-1"
            role="tablist"
            aria-label="Discussion view"
          >
            {(
              [
                ["all", "All", totalCount],
                ["open", "Open", openCount],
                ["resolved", "Resolved", resolvedCount],
                ["comments", "PR comments", pullRequestComments.length],
              ] as const
            ).map(([value, label, count], index) => (
              <button
                key={value}
                id={`${id}-${value}`}
                type="button"
                role="tab"
                aria-label={`${label} ${count}`}
                aria-selected={tab === value}
                aria-controls={listId}
                tabIndex={tab === value ? 0 : -1}
                onClick={() => {
                  setStatus(value);
                  setMobileDetail(false);
                }}
                onKeyDown={(event) => {
                  const next =
                    event.key === "ArrowRight"
                      ? (index + 1) % 4
                      : event.key === "ArrowLeft"
                        ? (index + 3) % 4
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? 3
                            : undefined;
                  if (next === undefined) return;
                  event.preventDefault();
                  const value = (
                    ["all", "open", "resolved", "comments"] as const
                  )[next];
                  if (!value) return;
                  setStatus(value);
                  setMobileDetail(false);
                  document.getElementById(`${id}-${value}`)?.focus();
                }}
                className={cn(
                  "flex h-8 items-center gap-2 rounded-lg px-3 text-xs! font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan",
                  tab === value
                    ? "bg-cyan/10 text-cyan"
                    : "text-mist hover:bg-surface-hover",
                )}
              >
                {label}
                <span
                  className={cn(
                    "rounded-md px-1.5 py-0.5 text-[10px] tabular-nums",
                    tab === value ? "bg-cyan/10" : "bg-surface-subtle text-fog",
                  )}
                >
                  {count}
                </span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            {hasFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="text-cyan text-[11px]! hover:underline"
              >
                Clear filters
              </button>
            )}
            <label className="text-fog flex items-center gap-1.5">
              <ArrowDownWideNarrow className="size-3.5" aria-hidden="true" />
              <select
                aria-label="Sort discussions"
                value={sort}
                onChange={(event) =>
                  setSort(event.target.value as DiscussionSort)
                }
                className="text-mist max-w-36 bg-transparent text-[11px]! outline-none focus-visible:ring-2 focus-visible:ring-cyan"
              >
                <option value="recent">Recently active</option>
                <option value="oldest">Oldest activity</option>
                <option value="file">File and line</option>
              </select>
            </label>
          </div>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="border-coral/20 bg-coral/5 text-mist flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-6 py-2.5 text-xs"
        >
          <span className="text-coral font-medium">
            Couldn’t refresh discussions.
          </span>
          <span>
            {totalCount ? "Showing the last loaded conversations. " : ""}
            {error}
          </span>
          <button
            type="button"
            disabled={loading}
            onClick={onRefresh}
            className="text-cyan ml-auto text-xs! font-medium hover:underline"
          >
            Try again
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside
          id={listId}
          role="tabpanel"
          aria-labelledby={`${id}-${tab}`}
          className={cn(
            "border-line bg-panel flex w-full shrink-0 flex-col md:w-[320px] md:border-r lg:w-[370px]",
            mobileDetail && selected && "hidden md:flex",
          )}
        >
          <div className="text-fog flex shrink-0 items-center justify-between px-5 py-3 text-[11px]">
            <span role="status" aria-live="polite">
              {visible.length} {entryName}
              {visible.length === 1 ? "" : "s"}
              {hasFilters ? ` matching of ${totalCount}` : ""}
            </span>
            {loading && totalCount > 0 && (
              <span className="flex items-center gap-1.5">
                <LoaderCircle className="size-3 animate-spin" /> Refreshing
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
            {loading && totalCount === 0 ? (
              <div
                role="status"
                className="text-mist flex items-center justify-center gap-2 px-4 py-16 text-xs"
              >
                <LoaderCircle className="size-4 animate-spin" /> Loading
                discussions…
              </div>
            ) : visible.length ? (
              <ul aria-label="Discussion threads" className="space-y-1">
                {visible.map(({ thread, images, activity }) => {
                  const first = thread.comments[0];
                  const match = term
                    ? thread.comments.find(({ body }) =>
                        body.toLocaleLowerCase().includes(term),
                      )
                    : undefined;
                  const preview = discussionPreview(
                    (match ?? first)?.body || "No visible comments",
                    query,
                  );
                  const general = thread.kind === "pull_request";
                  const resolved = thread.status === "resolved";
                  const label =
                    thread.kind === "pull_request"
                      ? thread.comments[0]?.kind === "review"
                        ? "Review summary"
                        : "PR comment"
                      : thread.path;
                  return (
                    <li key={thread.externalId}>
                      <button
                        type="button"
                        aria-pressed={
                          selected?.externalId === thread.externalId
                        }
                        id={`${id}-thread-${thread.externalId}`}
                        aria-label={
                          general
                            ? `Read PR comment by ${first?.author ?? "Unknown author"}: ${preview.slice(0, 70)}`
                            : `Read discussion in ${thread.path} at line ${thread.line}`
                        }
                        onClick={() => {
                          setSelectedId(thread.externalId);
                          setMobileDetail(true);
                        }}
                        className={cn(
                          "w-full rounded-xl border p-3.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan",
                          selected?.externalId === thread.externalId
                            ? "border-cyan/25 bg-cyan/[.065]"
                            : "border-transparent hover:border-line hover:bg-surface",
                        )}
                      >
                        <span className="flex items-center gap-2">
                          {general ? (
                            <MessageSquareText className="text-violet size-3.5 shrink-0" />
                          ) : resolved ? (
                            <Check className="text-addition size-3.5 shrink-0" />
                          ) : (
                            <CircleDot className="text-cyan size-3.5 shrink-0" />
                          )}
                          <span
                            title={label}
                            className="text-cloud min-w-0 flex-1 truncate font-mono text-[11px] font-medium"
                          >
                            <DiscussionSearchText text={label} query={query} />
                          </span>
                          {!general && (
                            <span className="text-fog text-[10px]">
                              L{thread.line}
                            </span>
                          )}
                        </span>
                        <span className="text-mist mt-2.5 line-clamp-3 text-xs leading-5">
                          <DiscussionSearchText text={preview} query={query} />
                        </span>
                        <span className="text-fog mt-3 flex items-center gap-2 text-[10px]">
                          <span className="min-w-0 flex-1 truncate">
                            {match?.author ?? first?.author ?? "Unknown author"}
                          </span>
                          {images && (
                            <ImageIcon
                              className="size-3"
                              aria-label="Has image attachments"
                            />
                          )}
                          <span className="flex items-center gap-1">
                            <MessageSquareText
                              className="size-3"
                              aria-hidden="true"
                            />
                            {thread.comments.length}
                          </span>
                        </span>
                        <span className="text-fog mt-1.5 block text-[10px]">
                          {activity
                            ? `Updated ${discussionTimestamp(new Date(activity).toISOString())}`
                            : "Time unavailable"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="text-mist px-5 py-12 text-center">
                <Search className="text-fog mx-auto size-6" />
                <p className="text-cloud mt-4 text-sm font-medium">
                  {hasFilters
                    ? "No matching discussions"
                    : totalCount === 0
                      ? "No discussions yet"
                      : tab === "comments"
                        ? "No PR comments"
                        : `No ${tab} discussions`}
                </p>
                <p className="mt-2 text-xs leading-5">
                  {hasFilters
                    ? "Try another search or broaden your filters."
                    : totalCount === 0
                      ? "PR comments and code discussions will appear here when someone joins the conversation."
                      : "You can still browse the complete conversation history."}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    resetFilters();
                    setStatus("all");
                  }}
                  className="text-cyan mt-4 text-xs! font-medium hover:underline"
                >
                  {hasFilters
                    ? "Clear filters and show all"
                    : "Show all discussions"}
                </button>
              </div>
            )}
          </div>
          <footer className="border-line text-fog shrink-0 border-t px-5 py-3 text-[10px] leading-4">
            {tab === "open"
              ? "Open threads first. Resolved conversations are in All."
              : "PR comments and code discussions are included. Select one to read it in full."}
          </footer>
        </aside>
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1",
            !mobileDetail && "hidden md:block",
          )}
        >
          {selected ? (
            <ReviewDiscussionDetail
              key={selected.externalId}
              thread={selected}
              pullRequest={pullRequest}
              query={query}
              onOpenThread={onOpenThread}
              onBack={() => {
                focusAfterNavigation.current = "list";
                setMobileDetail(false);
              }}
              focusConversation={mobileDetail}
            />
          ) : (
            <div className="bg-surface text-fog grid h-full place-content-center px-8 text-center">
              <MessageSquareText className="mx-auto size-8 opacity-40" />
              <p className="text-cloud mt-5 text-base font-medium">
                {loading
                  ? "Loading conversations"
                  : hasFilters
                    ? "No threads match these filters"
                    : "Your conversation history, in one place"}
              </p>
              <p className="mt-2 max-w-sm text-xs leading-6">
                {hasFilters
                  ? "Clear a filter to see more conversations."
                  : "Read every reply, inspect attachments, and return to the exact line of code when you’re ready."}
              </p>
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}

/** Summarizes active and resolved provider discussions on completion. */
export function ReviewDiscussionSummary({
  onOpenThread,
  pullRequest,
  threads,
}: {
  onOpenThread: (thread: ProviderDiscussionThread) => void;
  pullRequest: AiFixPromptPullRequest;
  threads: ProviderDiscussionThread[];
}) {
  const ordered = useMemo(() => orderProviderDiscussions(threads), [threads]);
  const openThreads = ordered.filter(isOpenProviderDiscussion);
  const resolvedThreads = ordered.filter(
    (thread) => !isOpenProviderDiscussion(thread),
  );
  const providerName = providerLabel(pullRequest.provider);

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
              pullRequest={pullRequest}
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
                pullRequest={pullRequest}
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
