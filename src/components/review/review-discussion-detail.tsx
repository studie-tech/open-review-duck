"use client";

import {
  ArrowLeft,
  Check,
  Code2,
  ExternalLink,
  MessageSquareText,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  type AiFixPromptPullRequest,
  discussionFixPrompt,
} from "~/lib/ai-fix-prompt";
import { providerLabel } from "~/lib/provider-labels";
import { cn } from "~/lib/utils";
import { CopyAiFixPromptButton } from "./copy-ai-fix-prompt-button";
import { ProviderCommentBody } from "./provider-comment-body";
import type {
  ProviderDiscussionConversation,
  ProviderDiscussionThread,
} from "./review-discussions";

/** Formats valid comment times and tolerates incomplete provider metadata. */
export function discussionTimestamp(value: string | undefined) {
  if (!value || Number.isNaN(Date.parse(value))) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** Shows the selected conversation in full, keeping its code context at hand. */
export function ReviewDiscussionDetail({
  thread,
  pullRequest,
  query,
  onOpenThread,
  onBack,
  focusConversation = false,
}: {
  thread: ProviderDiscussionConversation;
  pullRequest: AiFixPromptPullRequest;
  query: string;
  onOpenThread: (thread: ProviderDiscussionThread) => void;
  onBack: () => void;
  focusConversation?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [image, setImage] = useState<{ src: string; alt: string }>();
  const openImage = useCallback((value: { src: string; alt: string }) => {
    setImage(value);
  }, []);
  const resolved = thread.status === "resolved";
  const general = thread.kind === "pull_request";
  const generalLabel =
    thread.kind === "pull_request" && thread.comments[0]?.kind === "review"
      ? "Review summary"
      : "PR comment";
  const authors = new Set(thread.comments.map(({ author }) => author));

  useEffect(() => {
    if (focusConversation) heading.current?.focus();
  }, [focusConversation]);

  return (
    <section
      aria-label="Selected discussion"
      className="bg-surface flex h-full min-w-0 flex-col"
    >
      <header className="border-line bg-panel shrink-0 border-b px-5 py-4 lg:px-8">
        <button
          type="button"
          onClick={onBack}
          className="text-cyan mb-3 flex items-center gap-1.5 text-xs! font-medium md:hidden"
        >
          <ArrowLeft className="size-3.5" /> All threads
        </button>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium",
              general
                ? "border-violet/20 bg-violet/5 text-violet"
                : resolved
                  ? "border-addition/20 bg-addition/5 text-addition"
                  : "border-cyan/20 bg-cyan/5 text-cyan",
            )}
          >
            {resolved ? (
              <Check className="size-3" />
            ) : (
              <MessageSquareText className="size-3" />
            )}
            {general
              ? generalLabel
              : resolved
                ? "Resolved"
                : thread.status === "unknown"
                  ? "Status unavailable"
                  : "Open"}
          </span>
          <span className="text-fog">
            {thread.comments.length}{" "}
            {thread.comments.length === 1 ? "comment" : "comments"}
            <span aria-hidden="true"> · </span>
            {authors.size} {authors.size === 1 ? "participant" : "participants"}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <h3
            ref={heading}
            tabIndex={-1}
            className="text-cloud min-w-0 break-all font-mono text-sm font-medium outline-none"
          >
            {general ? "Pull request conversation" : thread.path}
            {!general && (
              <span className="text-fog ml-2 whitespace-nowrap text-xs font-normal">
                {thread.side === "left" ? "Previous" : "Current"} · L
                {thread.line}
              </span>
            )}
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {thread.kind !== "pull_request" && !resolved && (
              <CopyAiFixPromptButton
                variant="button"
                className="h-8 px-2.5 text-[11px]!"
                subject={`the conversation in ${thread.path} at line ${thread.line}`}
                prompt={() => discussionFixPrompt(pullRequest, thread)}
              />
            )}
            {(thread.webUrl || pullRequest.webUrl) && (
              <a
                href={thread.webUrl || pullRequest.webUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-mist hover:text-cloud flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] transition hover:bg-surface-hover"
              >
                {providerLabel(pullRequest.provider)}{" "}
                <ExternalLink className="size-3" />
              </a>
            )}
            {thread.kind !== "pull_request" && (
              <Button
                size="sm"
                variant="secondary"
                className="text-xs!"
                disabled={!thread.unitId}
                title={
                  !thread.unitId
                    ? "This thread has no matching review unit. Open it on the provider."
                    : undefined
                }
                onClick={() => onOpenThread(thread)}
              >
                <Code2 className="size-3.5" /> View in code
              </Button>
            )}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-6 lg:px-8">
        <div className="mx-auto max-w-[860px]">
          {thread.comments.length === 0 ? (
            <p className="text-mist py-12 text-center text-sm">
              This provider conversation has no visible comments.
            </p>
          ) : (
            <ol aria-label="Conversation comments" className="space-y-5">
              {thread.comments.map((comment, index) => {
                const matches =
                  query.trim() &&
                  `${comment.author} ${comment.body}`
                    .toLocaleLowerCase()
                    .includes(query.trim().toLocaleLowerCase());
                return (
                  <li key={comment.externalId}>
                    <article
                      className={cn(
                        "overflow-hidden rounded-xl border border-line bg-panel",
                        matches && "border-cyan/40",
                      )}
                    >
                      <header className="border-line/65 flex items-center gap-3 border-b px-4 py-3 sm:px-5">
                        <span
                          aria-hidden="true"
                          className={cn(
                            "grid size-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold",
                            index === 0
                              ? "bg-cyan/10 text-cyan"
                              : "bg-violet/10 text-violet",
                          )}
                        >
                          {(comment.author || "?").slice(0, 2).toUpperCase()}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-cloud truncate text-xs font-semibold">
                            {comment.author || "Unknown author"}
                          </p>
                          <time
                            dateTime={comment.createdAt}
                            className="text-fog text-[10px]"
                          >
                            {discussionTimestamp(comment.createdAt) ??
                              "Time unavailable"}
                          </time>
                        </div>
                        {matches && (
                          <span className="text-cyan text-[10px]">
                            Search match
                          </span>
                        )}
                        <span className="text-fog text-[10px]">
                          {general
                            ? generalLabel
                            : index === 0
                              ? "Started this thread"
                              : `Reply ${index}`}
                        </span>
                      </header>
                      <div className="px-4 py-4 sm:px-5">
                        <ProviderCommentBody
                          body={comment.body || "This comment has no text."}
                          className="mt-0 max-w-none"
                          imageMode="preview"
                          imageBaseUrl={pullRequest.webUrl}
                          onOpenImage={openImage}
                        />
                      </div>
                    </article>
                  </li>
                );
              })}
            </ol>
          )}
          <div className="text-fog mt-6 flex items-center justify-center gap-2 pb-3 text-[11px]">
            {resolved ? (
              <Check className="text-addition size-3.5" />
            ) : (
              <MessageSquareText className="size-3.5" />
            )}
            {general
              ? "This comment is part of the pull request conversation."
              : resolved
                ? "This conversation is resolved."
                : "Continue this conversation or manage it in the code view."}
          </div>
        </div>
      </div>
      {image && (
        <DiscussionImageViewer
          image={image}
          onClose={() => setImage(undefined)}
        />
      )}
    </section>
  );
}

/** Enlarges an attachment in a nested native modal with its own Escape handling. */
function DiscussionImageViewer({
  image,
  onClose,
}: {
  image: { src: string; alt: string };
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    if (element && !element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
      close.current?.focus();
    }
    return () => {
      if (element?.open && typeof element.close === "function") element.close();
      previousFocus?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={`Image preview: ${image.alt}`}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      className="bg-panel border-line fixed inset-0 m-auto hidden max-h-[94dvh] w-[min(1100px,94vw)] max-w-none flex-col overflow-hidden rounded-xl border p-0 text-cloud shadow-2xl open:flex backdrop:bg-black/70"
    >
      <header className="border-line flex items-center gap-3 border-b px-5 py-3">
        <p className="min-w-0 flex-1 truncate text-sm">{image.alt}</p>
        <a
          href={image.src}
          target="_blank"
          rel="noopener noreferrer"
          className="text-cyan flex items-center gap-1.5 text-xs"
        >
          Open original <ExternalLink className="size-3" />
        </a>
        <button
          ref={close}
          type="button"
          aria-label="Close image preview"
          onClick={onClose}
          className="hover:bg-surface-hover grid size-8 place-items-center rounded-lg"
        >
          <X className="size-4" />
        </button>
      </header>
      <div className="bg-code min-h-0 overflow-auto p-4">
        {/* biome-ignore lint/performance/noImgElement: load the original provider attachment directly */}
        <img
          src={image.src}
          alt={image.alt}
          referrerPolicy="no-referrer"
          className="mx-auto max-h-[78dvh] max-w-full object-contain"
        />
      </div>
    </dialog>
  );
}
