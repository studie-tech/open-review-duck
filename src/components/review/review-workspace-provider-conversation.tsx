"use client";

import {
  Check,
  ChevronRight,
  CircleCheck,
  CircleDot,
  Copy,
  ExternalLink,
  LoaderCircle,
  MessageSquareText,
  Pencil,
  Send,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ShortcutHint } from "~/components/command-center";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import { providerLabel } from "~/lib/provider-labels";
import { reviewShortcuts } from "~/lib/review-shortcuts";
import { cn } from "~/lib/utils";
import type { RouterOutputs } from "~/trpc/react";
import { ProviderCommentBody } from "./review-workspace-markdown";

type WorkspaceData = RouterOutputs["review"]["workspace"];
type ProviderConversationThread =
  RouterOutputs["review"]["providerConversations"]["threads"][number];

/** Gives a provider thread a stable in-workspace navigation anchor. */
export function providerConversationElementId(threadExternalId: string) {
  return `provider-conversation-${encodeURIComponent(threadExternalId)}`;
}

/** Returns the provider pull-request page, falling back to its repository. */
export function reviewProviderWebUrl(input: {
  repositoryWebUrl: string;
  webUrl?: string | null;
}) {
  const pullRequestUrl = input.webUrl?.trim();
  return pullRequestUrl || input.repositoryWebUrl;
}

/**
 * Copies the provider URL from the review title without leaving the review.
 *
 * The full URL is easy to miss in a truncated title line, and opening the
 * provider just to copy it is the expensive part. A check replaces the icon
 * once the clipboard has it, so the click does not need a toast to confirm.
 */
export function CopyRepositoryUrlButton({
  kind = "repository",
  url,
}: {
  kind?: "pull-request" | "repository";
  url: string;
}) {
  const [copied, setCopied] = useState(false);
  const copyLabel =
    kind === "pull-request" ? "Copy pull request URL" : "Copy repository URL";
  const copiedLabel =
    kind === "pull-request"
      ? "Pull request URL copied"
      : "Repository URL copied";
  const copyError =
    kind === "pull-request"
      ? "Could not copy the pull request URL"
      : "Could not copy the repository URL";

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  /** Puts the provider URL on the clipboard. */
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      toast.error(copyError);
    }
  }

  return (
    <button
      type="button"
      aria-label={copied ? copiedLabel : copyLabel}
      title={copied ? "Copied" : copyLabel}
      onClick={() => void copy()}
      className="text-fog hover:text-mist grid size-5 shrink-0 place-items-center rounded transition hover:bg-surface-subtle"
    >
      {copied ? (
        <Check className="size-3" aria-hidden="true" />
      ) : (
        <Copy className="size-3" aria-hidden="true" />
      )}
    </button>
  );
}

/** Formats a provider comment timestamp for the review conversation. */
function conversationTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** The conversation actions a reviewer may take without leaving ReviewDuck. */
export interface ProviderConversationActions {
  onDeleteComment: (commentExternalId: string) => Promise<unknown>;
  onDeleteThread: () => Promise<unknown>;
  onEditComment: (commentExternalId: string, body: string) => Promise<unknown>;
  onReply: (body: string) => Promise<unknown>;
  onResolve: (resolved: boolean) => Promise<unknown>;
}

/** Renders the provider conversation interface. */
export function ProviderConversation({
  className,
  managing = false,
  newSince,
  onDeleteComment,
  onDeleteThread,
  onEditComment,
  onReply,
  onResolve,
  provider,
  replying,
  thread,
  publishedByReviewDuck,
}: ProviderConversationActions & {
  className?: string;
  managing?: boolean;
  /** Marks comments after this moment as the activity a wait was paused for. */
  newSince?: Date | null;
  provider: WorkspaceData["pullRequest"]["provider"];
  replying: boolean;
  thread: ProviderConversationThread;
  publishedByReviewDuck: boolean;
}) {
  /** Reports whether one comment arrived after the reviewer began waiting. */
  const isNewComment = (createdAt: string) =>
    Boolean(newSince && new Date(createdAt) > newSince);
  // A resolved conversation normally starts collapsed, but the one a wait was
  // paused for holds the answer the reviewer came back to read.
  const hasNewComments = thread.comments.some(({ createdAt }) =>
    isNewComment(createdAt),
  );
  const [expanded, setExpanded] = useState(
    thread.status !== "resolved" || hasNewComments,
  );
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [editing, setEditing] = useState<string>();
  const [editBody, setEditBody] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState<
    { kind: "thread" } | { kind: "comment"; externalId: string }
  >();
  const replyInputRef = useRef<HTMLTextAreaElement>(null);
  const editInputRef = useRef<HTMLTextAreaElement>(null);
  // `managing` only reaches this component on the render after a mutation
  // starts, so a second activation in the same frame would send twice.
  const inFlight = useRef(false);
  const [resolving, setResolving] = useState(false);
  const resolved = thread.status === "resolved";
  // Deleting a conversation takes every comment in it, so one belonging to
  // someone else puts the whole conversation out of this reviewer's reach.
  const holdsAnotherReviewersComment = thread.comments.some(
    ({ publishedByAnotherReviewer }) => publishedByAnotherReviewer,
  );

  useEffect(() => {
    if (replyOpen) replyInputRef.current?.focus();
  }, [replyOpen]);

  useEffect(() => {
    if (editing) editInputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    setExpanded(thread.status !== "resolved" || hasNewComments);
    setReplyOpen(false);
  }, [thread.status, hasNewComments]);

  /** Publishes the draft while preserving it if the provider rejects the reply. */
  async function submitReply() {
    const body = replyBody.trim();
    if (!body || replying || inFlight.current) return;
    inFlight.current = true;
    try {
      await onReply(body);
      setReplyBody("");
      setReplyOpen(false);
    } catch {
      // The mutation owns the user-facing error; retain the draft for retry.
    } finally {
      inFlight.current = false;
    }
  }

  /** Saves an edited comment, keeping the draft open if the provider says no. */
  async function submitEdit(commentExternalId: string) {
    const body = editBody.trim();
    if (!body || managing || inFlight.current) return;
    inFlight.current = true;
    try {
      await onEditComment(commentExternalId, body);
      setEditing(undefined);
      setEditBody("");
    } catch {
      // The mutation owns the user-facing error; retain the draft for retry.
    } finally {
      inFlight.current = false;
    }
  }

  /** Resolves or reopens the conversation, leaving the error to the mutation. */
  async function submitResolution(resolve: boolean) {
    if (managing || inFlight.current) return;
    inFlight.current = true;
    setResolving(true);
    try {
      await onResolve(resolve);
    } catch {
      // The mutation owns the user-facing error, and the header keeps showing
      // the resolution the provider still reports.
    } finally {
      inFlight.current = false;
      setResolving(false);
    }
  }

  /** Carries out the deletion the reviewer just confirmed. */
  async function confirmDelete() {
    const target = confirmingDelete;
    if (!target || managing || inFlight.current) return;
    inFlight.current = true;
    try {
      await (target.kind === "thread"
        ? onDeleteThread()
        : onDeleteComment(target.externalId));
      setConfirmingDelete(undefined);
    } catch {
      // The mutation owns the user-facing error; the dialog stays for a retry.
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <article
      id={providerConversationElementId(thread.externalId)}
      className={cn(
        "border-cyan/20 bg-panel mx-4 my-2 ml-[82px] overflow-hidden rounded-xl border font-sans shadow-lg",
        className,
      )}
    >
      <header
        className={cn(
          "bg-cyan/[.035] flex items-center justify-between gap-2 px-3 py-2.5",
          expanded && "border-b border-line",
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${providerLabel(provider)} conversation`}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn(
              "text-cyan size-3.5 shrink-0 transition-transform",
              expanded && "rotate-90",
            )}
          />
          <MessageSquareText className="text-cyan size-3.5 shrink-0" />
          <span className="text-cloud truncate text-[10px] font-medium">
            {providerLabel(provider)} conversation
          </span>
          {publishedByReviewDuck && (
            <Badge className="border-cyan/20 bg-cyan/8 text-cyan">
              Posted here
            </Badge>
          )}
          {thread.status === "resolved" && (
            <Badge className="border-lime/20 bg-lime/8 text-lime">
              Resolved
            </Badge>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={managing}
            aria-label={
              resolved
                ? "Reopen this conversation"
                : "Resolve this conversation"
            }
            title={
              resolved
                ? `Reopen this conversation on ${providerLabel(provider)}`
                : `Resolve this conversation on ${providerLabel(provider)}`
            }
            onClick={() => void submitResolution(!resolved)}
            className={cn(
              "flex items-center gap-1 rounded-md px-1.5 py-1 text-[9px] transition disabled:opacity-50",
              resolved
                ? "text-mist hover:text-cloud hover:bg-surface-subtle"
                : "text-lime hover:bg-lime/10",
            )}
          >
            {resolving ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : resolved ? (
              <CircleDot className="size-3.5" />
            ) : (
              <CircleCheck className="size-3.5" />
            )}
            <span className="hidden sm:inline">
              {resolving
                ? resolved
                  ? "Reopening…"
                  : "Resolving…"
                : resolved
                  ? "Reopen"
                  : "Resolve"}
            </span>
          </button>
          <button
            type="button"
            disabled={managing || holdsAnotherReviewersComment}
            aria-label="Delete this conversation"
            title={
              holdsAnotherReviewersComment
                ? "Another reviewer published a comment in this conversation"
                : `Delete this conversation on ${providerLabel(provider)}`
            }
            onClick={() => setConfirmingDelete({ kind: "thread" })}
            className="text-mist grid size-6 place-items-center rounded-md transition hover:bg-red-500/10 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="size-3.5" />
          </button>
          {thread.webUrl && (
            <a
              href={thread.webUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open this conversation on ${providerLabel(provider)}`}
              className="text-mist hover:text-cloud grid size-6 place-items-center rounded-md transition hover:bg-surface-subtle"
            >
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
      </header>
      {expanded && (
        <>
          <div className="divide-y divide-line">
            {thread.comments.map((comment, index) => (
              <div
                key={comment.externalId}
                className={cn(
                  "group/comment px-4 py-4 sm:px-5",
                  index > 0 && "bg-surface-subtle/45 sm:pl-8",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="bg-cyan/10 text-cyan grid size-6 shrink-0 place-items-center rounded-full text-[9px] font-semibold uppercase">
                    {comment.author.slice(0, 1)}
                  </span>
                  <span className="text-cloud truncate text-[11px] font-medium">
                    {comment.author}
                  </span>
                  <time
                    dateTime={comment.createdAt}
                    className="text-fog shrink-0 text-[10px]"
                  >
                    {conversationTimestamp(comment.createdAt)}
                  </time>
                  {index > 0 && (
                    <span className="text-cyan text-[8px] font-semibold tracking-wider uppercase">
                      Reply
                    </span>
                  )}
                  {isNewComment(comment.createdAt) && (
                    <span className="border-lime/25 bg-lime/10 text-lime rounded-full border px-1.5 py-px text-[8px] font-semibold tracking-wider uppercase">
                      New
                    </span>
                  )}
                  {/* One workspace connection speaks for every member, so
                      the provider would allow this and only ReviewDuck knows
                      whose words they are. A control the reviewer may not use
                      is not offered at all. */}
                  {!comment.publishedByAnotherReviewer && (
                    <span className="ml-auto flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100">
                      <button
                        type="button"
                        disabled={managing}
                        aria-label={`Edit the comment by ${comment.author}`}
                        title="Edit this comment"
                        onClick={() => {
                          setEditing(comment.externalId);
                          setEditBody(comment.body);
                        }}
                        className="text-mist hover:text-cyan grid size-6 place-items-center rounded-md transition hover:bg-surface-subtle disabled:opacity-50"
                      >
                        <Pencil className="size-3" />
                      </button>
                      <button
                        type="button"
                        disabled={managing}
                        aria-label={`Delete the comment by ${comment.author}`}
                        title="Delete this comment"
                        onClick={() =>
                          setConfirmingDelete({
                            kind: "comment",
                            externalId: comment.externalId,
                          })
                        }
                        className="text-mist grid size-6 place-items-center rounded-md transition hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </span>
                  )}
                </div>
                {editing === comment.externalId ? (
                  <div className="mt-2">
                    <textarea
                      ref={editInputRef}
                      aria-label={`Edit the comment by ${comment.author} on ${providerLabel(provider)}`}
                      value={editBody}
                      onChange={(event) => setEditBody(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setEditing(undefined);
                        } else if (
                          event.key === "Enter" &&
                          (event.metaKey || event.ctrlKey)
                        ) {
                          event.preventDefault();
                          void submitEdit(comment.externalId);
                        }
                      }}
                      rows={3}
                      className="bg-surface text-cloud focus:border-cyan/45 w-full resize-y rounded-lg border border-line px-3 py-2 text-xs leading-5 outline-none"
                    />
                    <div className="mt-2 flex items-center justify-end gap-2">
                      <span className="text-fog mr-auto flex items-center gap-1 text-[9px]">
                        <ShortcutHint shortcut={reviewShortcuts.postComment} />
                        save · Esc cancels
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={managing}
                        onClick={() => setEditing(undefined)}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={
                          managing ||
                          !editBody.trim() ||
                          editBody.trim() === comment.body.trim()
                        }
                        onClick={() => void submitEdit(comment.externalId)}
                      >
                        {managing ? (
                          <LoaderCircle className="size-3 animate-spin" />
                        ) : (
                          <Check className="size-3" />
                        )}
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <ProviderCommentBody body={comment.body} />
                )}
              </div>
            ))}
          </div>
          <footer className="border-t border-line bg-surface-subtle/25 px-4 py-3 sm:px-5">
            {replyOpen ? (
              <div>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-cloud text-[11px] font-medium">
                    Reply on {providerLabel(provider)}
                  </p>
                  <span className="text-fog flex items-center gap-1 text-[9px]">
                    <ShortcutHint shortcut={reviewShortcuts.postComment} />
                    post
                  </span>
                </div>
                <textarea
                  ref={replyInputRef}
                  value={replyBody}
                  onChange={(event) => setReplyBody(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setReplyOpen(false);
                    } else if (
                      event.key === "Enter" &&
                      (event.metaKey || event.ctrlKey)
                    ) {
                      event.preventDefault();
                      void submitReply();
                    }
                  }}
                  placeholder="Continue this conversation…"
                  rows={3}
                  className="bg-surface text-cloud focus:border-cyan/45 mt-2 w-full resize-y rounded-lg border border-line px-3 py-2 text-xs leading-5 outline-none"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={replying}
                    onClick={() => setReplyOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!replyBody.trim() || replying}
                    onClick={() => void submitReply()}
                  >
                    {replying ? (
                      <LoaderCircle className="size-3 animate-spin" />
                    ) : (
                      <Send className="size-3" />
                    )}
                    {replying ? "Posting…" : "Reply"}
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setReplyOpen(true)}
                className="text-mist hover:text-cyan flex items-center gap-2 text-[10px] font-medium transition"
              >
                <MessageSquareText className="size-3.5" />
                Reply on {providerLabel(provider)}
              </button>
            )}
          </footer>
        </>
      )}
      {confirmingDelete && (
        <ConfirmationDialog
          confirmLabel="Delete"
          confirmVariant="danger"
          icon={<Trash2 className="text-coral size-5" />}
          title={
            confirmingDelete.kind === "thread"
              ? "Delete this conversation?"
              : "Delete this comment?"
          }
          description={
            confirmingDelete.kind === "thread"
              ? `This removes all ${thread.comments.length} ${thread.comments.length === 1 ? "comment" : "comments"} from ${providerLabel(provider)}. It cannot be undone.`
              : `This removes the comment from ${providerLabel(provider)}. It cannot be undone.`
          }
          pending={managing}
          pendingLabel={
            <>
              <LoaderCircle className="size-3 animate-spin" />
              Deleting…
            </>
          }
          onCancel={() => setConfirmingDelete(undefined)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </article>
  );
}

/** Checks whether syntax highlighting supports a language identifier. */
