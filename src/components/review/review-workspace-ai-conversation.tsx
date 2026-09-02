"use client";

import {
  ChevronDown,
  GripVertical,
  LoaderCircle,
  MessageSquareText,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ShortcutHint } from "~/components/command-center";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import { providerLabel } from "~/lib/provider-labels";
import { reviewShortcuts } from "~/lib/review-shortcuts";
import type { RouterOutputs } from "~/trpc/react";
import { ProviderCommentBody } from "./review-workspace-markdown";

type WorkspaceData = RouterOutputs["review"]["workspace"];

export interface AiQuestionEntry {
  error: string | null;
  id: string;
  jobId?: string;
  progress?: string;
  question: string | null;
  result: {
    summary: string;
    commentProposals?: Array<{
      body: string;
      line: number;
      path: string;
      published?: boolean;
    }>;
  } | null;
  status:
    | "queued"
    | "running"
    | "waiting_for_provider"
    | "streaming"
    | "completed"
    | "failed"
    | "cancelled";
  threadId?: string;
}

export const AI_QUICK_QUESTIONS = [
  {
    code: "Digit1",
    key: "1",
    label: "What does this code do?",
    question:
      "What does this code do, and how does it contribute to the pull request?",
  },
  {
    code: "Digit2",
    key: "2",
    label: "Why was this changed?",
    question:
      "Why was this code changed, and what behavior is different from before?",
  },
  {
    code: "Digit3",
    key: "3",
    label: "What should I review closely?",
    question:
      "What should I pay closest attention to while reviewing this code?",
  },
] as const;

const AI_CONVERSATION_VISIBILITY_KEY = "reviewduck:ai-conversation-visibility";

interface AiConversationVisibility {
  line: number;
  threadId?: string;
}

/** Reads the last explicit visibility state for a unit's AI conversation. */
export function aiConversationVisibility(
  storage: Pick<Storage, "getItem">,
  pullRequestId: string,
  unitId: string,
) {
  try {
    const stored = storage.getItem(
      `${AI_CONVERSATION_VISIBILITY_KEY}:${pullRequestId}`,
    );
    if (!stored) return undefined;
    const value = JSON.parse(stored) as Record<string, unknown>;
    if (!Object.hasOwn(value, unitId)) return undefined;
    const visibility = value[unitId];
    if (visibility === null) return null;
    if (
      typeof visibility === "object" &&
      "line" in visibility &&
      typeof visibility.line === "number" &&
      Number.isInteger(visibility.line) &&
      visibility.line > 0 &&
      (!("threadId" in visibility) ||
        visibility.threadId === undefined ||
        typeof visibility.threadId === "string")
    ) {
      return visibility as AiConversationVisibility;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Persists whether and where a unit's AI conversation is open. */
export function rememberAiConversationVisibility(
  storage: Pick<Storage, "getItem" | "setItem">,
  pullRequestId: string,
  unitId: string,
  line: number | null,
  threadId?: string,
) {
  try {
    const key = `${AI_CONVERSATION_VISIBILITY_KEY}:${pullRequestId}`;
    const stored = storage.getItem(key);
    const value = stored
      ? (JSON.parse(stored) as Record<
          string,
          AiConversationVisibility | number | null
        >)
      : {};
    value[unitId] = line === null ? null : { line, threadId };
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Browser privacy settings can make local storage unavailable.
  }
}

/** Drops persisted AI questions that a thread delete just removed. */
export function withoutDeletedAiQuestions<
  T extends { id: string; jobId?: string },
>(
  questions: readonly T[] | undefined,
  jobIds: readonly string[],
): T[] | undefined {
  if (!questions) return questions;
  const deleted = new Set(jobIds);
  return questions.filter(
    (question) =>
      !deleted.has(question.id) &&
      (question.jobId === undefined || !deleted.has(question.jobId)),
  );
}

/** Drops optimistic live entries that belonged to a deleted conversation. */
export function withoutDeletedLiveAiQuestions<
  T extends { id: string; jobId?: string },
>(questions: readonly T[], jobIds: readonly string[]): T[] {
  const deleted = new Set(jobIds);
  return questions.filter(
    (question) =>
      !deleted.has(question.id) &&
      (question.jobId === undefined || !deleted.has(question.jobId)),
  );
}

type MeasuredReviewLine = { center: number; line: number };

/** Measures every rendered in-scope review line, ordered top to bottom. */
function measureRenderedReviewLines(
  minimumLine: number,
  maximumLine: number,
): MeasuredReviewLine[] {
  const measured: MeasuredReviewLine[] = [];
  const seen = new Set<number>();
  for (const element of document.querySelectorAll<HTMLElement>(
    '[id^="review-line-"]',
  )) {
    const line = Number(element.id.replace("review-line-", ""));
    if (
      !Number.isInteger(line) ||
      line < minimumLine ||
      line > maximumLine ||
      seen.has(line)
    ) {
      continue;
    }
    seen.add(line);
    const bounds = element.getBoundingClientRect();
    measured.push({ center: bounds.top + bounds.height / 2, line });
  }
  return measured.sort((left, right) => left.center - right.center);
}

/** Finds the measured line closest to a vertical pointer coordinate. */
function nearestMeasuredReviewLine(
  measured: readonly MeasuredReviewLine[],
  clientY: number,
) {
  let low = 0;
  let high = measured.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    const candidate = measured[middle];
    if (candidate && candidate.center < clientY) low = middle + 1;
    else high = middle;
  }
  const below = measured[low];
  if (!below) return undefined;
  const above = measured[low - 1];
  if (
    above &&
    Math.abs(clientY - above.center) <= Math.abs(clientY - below.center)
  ) {
    return above.line;
  }
  return below.line;
}

/** Renders the line-anchored composer for one inline provider comment. */
export function InlineCommentComposer({
  initialDraft,
  line,
  onCancel,
  onDraftChange,
  onPost,
  path,
  pending,
  posting,
  provider,
}: {
  initialDraft: string;
  line: number;
  onCancel: () => void;
  onDraftChange: (value: string) => void;
  onPost: (body: string) => void;
  path: string;
  pending: boolean;
  posting: boolean;
  provider: WorkspaceData["pullRequest"]["provider"];
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  // The composer keeps the comment text so a keystroke never re-renders the
  // workspace tree; the parent only stores it so an unmount it did not ask
  // for, such as a wait that failed, keeps what the reviewer already typed.
  const [draft, setDraft] = useState(initialDraft);

  useEffect(() => {
    input.current?.focus();
  }, []);

  return (
    <div className="border-cyan/20 bg-panel mx-4 my-2 ml-[82px] rounded-xl border p-3 font-sans shadow-xl">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <p className="text-cloud flex shrink-0 items-center gap-2 text-xs font-medium">
          <MessageSquareText className="text-cyan size-3.5" />
          Comment on {providerLabel(provider)} · line {line}
        </p>
        <span className="text-fog min-w-0 truncate text-right font-mono text-[9px]">
          {path}
        </span>
      </div>
      <textarea
        ref={input}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          onDraftChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            draft.trim() &&
            !pending
          ) {
            event.preventDefault();
            onPost(draft);
          }
        }}
        placeholder={`Write an inline ${providerLabel(provider)} comment…`}
        rows={3}
        className="bg-surface text-cloud focus:border-cyan/45 mt-3 w-full resize-y rounded-lg border border-line px-3 py-2 text-xs leading-5 outline-none"
      />
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-fog flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] leading-4">
          <span>Posts immediately to {providerLabel(provider)}.</span>
          <span className="flex items-center gap-1">
            <ShortcutHint shortcut={reviewShortcuts.postComment} />
            post
          </span>
          <span>· Esc cancels</span>
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!draft.trim() || pending}
            onClick={() => onPost(draft)}
          >
            {posting ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <Send className="size-3" />
            )}
            {posting ? "Posting…" : `Post to ${providerLabel(provider)}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Renders a line-anchored AI conversation that can move through review scope. */
export function InlineAiQuestion({
  autoFocus = true,
  canAsk,
  entries,
  initialDraft,
  line,
  maximumLine,
  minimumLine,
  onAsk,
  onClose,
  onDeleteThread,
  onDraftChange,
  onMove,
  onPreview,
  onPublishProposal,
  onStep,
  providerName = "provider",
}: {
  autoFocus?: boolean;
  canAsk: boolean;
  entries: AiQuestionEntry[];
  initialDraft: string;
  line: number;
  maximumLine: number;
  minimumLine: number;
  onAsk: (question: string) => boolean;
  onClose: () => void;
  onDeleteThread?: (jobIds: string[]) => Promise<void>;
  onDraftChange: (value: string) => void;
  onMove: (line: number) => void;
  onPreview: (line?: number) => void;
  onPublishProposal?: (input: {
    aiCommentIndex: number;
    aiJobId: string;
    body: string;
    line: number;
  }) => Promise<void>;
  onStep: (direction: -1 | 1) => void;
  providerName?: string;
}) {
  const previewLine = useRef(line);
  const input = useRef<HTMLTextAreaElement>(null);
  const clearDragListeners = useRef<() => void>(() => undefined);
  // The composer keeps the question text so a keystroke never re-renders the
  // workspace tree; the parent only stores it so a line move, which remounts
  // this card, keeps what the reviewer already typed.
  const [draft, setDraft] = useState(initialDraft);
  const [proposalDrafts, setProposalDrafts] = useState<Record<string, string>>(
    {},
  );
  const [publishingProposal, setPublishingProposal] = useState<string>();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingThread, setDeletingThread] = useState(false);
  const threadInFlight = entries.some(({ status }) =>
    ["queued", "running", "streaming"].includes(status),
  );
  const proposalSource = useMemo(
    () =>
      [...entries]
        .reverse()
        .find((entry) => (entry.result?.commentProposals?.length ?? 0) > 0),
    [entries],
  );
  const proposals = useMemo(
    () =>
      (proposalSource?.result?.commentProposals ?? []).map(
        (proposal, index) => ({
          ...proposal,
          aiCommentIndex: index,
          aiJobId: proposalSource?.jobId,
          key: `${proposalSource?.jobId ?? proposalSource?.id ?? "question"}:${index}`,
        }),
      ),
    [proposalSource],
  );

  useEffect(() => {
    if (autoFocus) input.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  useEffect(() => {
    setProposalDrafts((current) => {
      const next = { ...current };
      for (const proposal of proposals) {
        if (!(proposal.key in next)) next[proposal.key] = proposal.body;
      }
      return next;
    });
  }, [proposals]);

  /** Publishes one editable structured proposal through the provider workflow. */
  const publishProposal = useCallback(
    async (proposal: (typeof proposals)[number] | undefined) => {
      if (
        !proposal ||
        proposal.published ||
        !proposal.aiJobId ||
        !onPublishProposal ||
        publishingProposal
      ) {
        return;
      }
      const body = (proposalDrafts[proposal.key] ?? proposal.body).trim();
      if (!body) return;
      setPublishingProposal(proposal.key);
      try {
        await onPublishProposal({
          aiCommentIndex: proposal.aiCommentIndex,
          aiJobId: proposal.aiJobId,
          body,
          line: proposal.line,
        });
      } finally {
        setPublishingProposal(undefined);
      }
    },
    [onPublishProposal, proposalDrafts, publishingProposal],
  );

  /** Empties the composer only after its question is accepted upstream. */
  const submitQuestion = useCallback(
    (question: string) => {
      if (!onAsk(question)) return;
      setDraft("");
      onDraftChange("");
    },
    [onAsk, onDraftChange],
  );

  useEffect(() => {
    /** Handles line movement and explicitly modified quick questions. */
    function handleComposerShortcuts(event: KeyboardEvent) {
      const quickQuestion = AI_QUICK_QUESTIONS.find(
        ({ code }) => code === event.code,
      );
      if (
        quickQuestion &&
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey &&
        (entries.length > 0 || canAsk)
      ) {
        const target = event.target;
        const editingElsewhere =
          target instanceof HTMLElement &&
          (target.matches("input, textarea, select, [contenteditable=true]") ||
            target.isContentEditable) &&
          !target.closest("#inline-ai-question");
        if (editingElsewhere) return;
        event.preventDefault();
        event.stopPropagation();
        if (entries.length === 0) {
          submitQuestion(quickQuestion.question);
        } else {
          void publishProposal(proposals[Number(quickQuestion.key) - 1]);
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      event.stopPropagation();
      onStep(event.key === "ArrowUp" ? -1 : 1);
    }

    window.addEventListener("keydown", handleComposerShortcuts, true);
    return () =>
      window.removeEventListener("keydown", handleComposerShortcuts, true);
  }, [
    canAsk,
    entries.length,
    onStep,
    proposals,
    publishProposal,
    submitQuestion,
  ]);

  useEffect(
    () => () => {
      clearDragListeners.current();
    },
    [],
  );

  /** Begins a window-tracked drag so the handle remains responsive off-target. */
  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    clearDragListeners.current();
    previewLine.current = line;
    onPreview(line);
    const pointerId = event.pointerId;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    // The pane does not scroll during the gesture, so one measuring pass at
    // pointerdown keeps every later move free of layout reads.
    const measuredLines = measureRenderedReviewLines(minimumLine, maximumLine);
    let pendingClientY: number | undefined;
    let previewFrame: number | undefined;

    /** Removes global drag listeners and restores document interaction styles. */
    function cleanupDrag() {
      if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
      previewFrame = undefined;
      window.removeEventListener("pointermove", previewDrag, true);
      window.removeEventListener("pointerup", finishDrag, true);
      window.removeEventListener("pointercancel", cancelDrag, true);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      clearDragListeners.current = () => undefined;
    }

    /** Previews the in-scope line closest to the latest pointer position. */
    function applyPendingPreview() {
      previewFrame = undefined;
      if (pendingClientY === undefined) return;
      const nearest = nearestMeasuredReviewLine(measuredLines, pendingClientY);
      if (nearest === undefined || nearest === previewLine.current) return;
      previewLine.current = nearest;
      onPreview(nearest);
    }

    /** Records the pointer position and previews it on the next frame. */
    function previewDrag(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== pointerId) return;
      pointerEvent.preventDefault();
      pendingClientY = pointerEvent.clientY;
      previewFrame ??= requestAnimationFrame(applyPendingPreview);
    }

    /** Commits the line under the pointer after a completed drag. */
    function finishDrag(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== pointerId) return;
      pointerEvent.preventDefault();
      const nearest = nearestMeasuredReviewLine(
        measuredLines,
        pointerEvent.clientY,
      );
      cleanupDrag();
      onPreview(undefined);
      onMove(nearest ?? previewLine.current);
    }

    /** Cancels the gesture without changing the question's anchor. */
    function cancelDrag(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== pointerId) return;
      cleanupDrag();
      onPreview(undefined);
    }

    clearDragListeners.current = cleanupDrag;
    window.addEventListener("pointermove", previewDrag, true);
    window.addEventListener("pointerup", finishDrag, true);
    window.addEventListener("pointercancel", cancelDrag, true);
  }

  return (
    <article
      id="inline-ai-question"
      className="border-violet/25 bg-panel relative mx-4 my-3 ml-[82px] overflow-hidden rounded-xl border font-sans shadow-[0_14px_40px_var(--app-shadow)]"
    >
      <span className="bg-violet absolute inset-y-0 left-0 w-0.5" />
      <header className="flex items-center gap-2 border-b border-violet/15 px-3 py-2">
        <span className="bg-violet/10 text-violet grid size-6 place-items-center rounded-md">
          <Sparkles className="size-3.5" aria-hidden="true" />
        </span>
        <span className="text-cloud text-[10px] font-medium">
          Ask AI about line {line}
        </span>
        <button
          type="button"
          aria-label="Drag AI question to another line"
          title="Drag up or down to focus another in-scope line"
          className="text-fog hover:bg-violet/10 hover:text-violet ml-auto flex touch-none cursor-ns-resize items-center gap-1 rounded-md px-2 py-1 text-[9px] transition"
          onPointerDown={beginDrag}
        >
          <span className="hidden sm:inline">Drag</span>
          <GripVertical className="size-3.5" />
        </button>
        <div className="flex items-center">
          <button
            type="button"
            aria-label="Move AI question one line up"
            disabled={line <= minimumLine}
            onClick={() => onStep(-1)}
            className="text-fog hover:text-cloud rounded p-1 transition disabled:opacity-30"
          >
            <ChevronDown className="size-3 rotate-180" />
          </button>
          <button
            type="button"
            aria-label="Move AI question one line down"
            disabled={line >= maximumLine}
            onClick={() => onStep(1)}
            className="text-fog hover:text-cloud rounded p-1 transition disabled:opacity-30"
          >
            <ChevronDown className="size-3" />
          </button>
        </div>
        {entries.length > 0 && onDeleteThread && (
          <button
            type="button"
            aria-label="Delete AI conversation"
            title={
              threadInFlight
                ? "Wait for the current answer to finish"
                : "Delete AI conversation"
            }
            disabled={threadInFlight}
            onClick={() => setDeleteDialogOpen(true)}
            className="text-fog hover:bg-red-500/10 hover:text-red-600 rounded p-1 transition disabled:cursor-not-allowed disabled:opacity-30 dark:hover:text-red-300"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          aria-label="Close AI question"
          onClick={onClose}
          className="text-fog hover:text-cloud rounded p-1 transition"
        >
          <X className="size-3.5" />
        </button>
      </header>
      {entries.length > 0 && (
        <div className="grid gap-4 border-b border-violet/15 px-3 py-3">
          {entries.map((entry) => (
            <div key={entry.id} className="grid gap-3">
              <div className="flex justify-end">
                <p className="bg-surface-subtle text-cloud max-w-[88%] rounded-xl rounded-br-sm px-3 py-2 text-[11px] leading-5">
                  {entry.question}
                </p>
              </div>
              <div
                aria-live="polite"
                className="text-mist flex min-w-0 items-start gap-2.5 text-[11px] leading-5"
              >
                <span className="bg-violet/10 text-violet mt-0.5 grid size-6 shrink-0 place-items-center rounded-md">
                  <Sparkles className="size-3.5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-cloud text-[10px] font-medium">
                      ReviewDuck AI
                    </span>
                    {entry.status !== "completed" &&
                      entry.status !== "failed" && (
                        <span className="text-violet flex items-center gap-1.5 text-[9px]">
                          <LoaderCircle className="size-2.5 animate-spin" />
                          {entry.progress ?? "Reading review context…"}
                        </span>
                      )}
                  </div>
                  {entry.result?.summary ? (
                    <div className="relative">
                      <ProviderCommentBody
                        body={entry.result.summary}
                        className="mt-0 max-w-none text-[11px] leading-5"
                      />
                      {entry.status === "streaming" && (
                        <>
                          <span
                            aria-hidden="true"
                            className="bg-violet ml-0.5 inline-block h-3.5 w-0.5 animate-pulse align-[-2px]"
                          />
                          <span className="sr-only">AI is writing</span>
                        </>
                      )}
                    </div>
                  ) : entry.status === "failed" ? (
                    <div className="border-red-500/20 bg-red-500/[.045] rounded-lg border px-3 py-2 text-red-700 dark:text-red-200">
                      <p className="font-medium">Answer interrupted</p>
                      <p className="mt-0.5 text-[10px] opacity-85">
                        {entry.error ??
                          "The AI question could not be answered."}
                      </p>
                    </div>
                  ) : (
                    <div className="grid max-w-xl gap-1.5 py-1">
                      <span className="bg-violet/10 h-2 w-[78%] animate-pulse rounded-full" />
                      <span className="bg-violet/[.07] h-2 w-[58%] animate-pulse rounded-full [animation-delay:120ms]" />
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {proposals.length > 0 && (
        <section
          aria-label="Suggested pull request comments"
          className="grid gap-2 border-b border-violet/15 bg-violet/[.025] px-3 py-3"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-violet text-[9px] font-semibold tracking-[.12em] uppercase">
                Suggested PR comments
              </p>
              <p className="text-fog mt-0.5 text-[9px]">
                ReviewDuck found something concrete enough to raise with the
                author.
              </p>
            </div>
            <Badge>{proposals.length}</Badge>
          </div>
          {proposals.map((proposal, index) => {
            const publishing = publishingProposal === proposal.key;
            const body = proposalDrafts[proposal.key] ?? proposal.body;
            return (
              <article
                key={proposal.key}
                className="border-violet/15 bg-surface/60 rounded-lg border p-2.5"
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-cloud text-[10px] font-medium">
                    Comment {index + 1} · line {proposal.line}
                  </p>
                  {index < 3 && !proposal.published && (
                    <ShortcutHint
                      shortcut={[
                        {
                          key: String(index + 1),
                          mod: true,
                          shift: true,
                        },
                      ]}
                    />
                  )}
                </div>
                <textarea
                  aria-label={`Edit suggested PR comment ${index + 1}`}
                  value={body}
                  disabled={proposal.published || publishing}
                  rows={3}
                  onChange={(event) =>
                    setProposalDrafts((current) => ({
                      ...current,
                      [proposal.key]: event.target.value,
                    }))
                  }
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      (event.metaKey || event.ctrlKey)
                    ) {
                      event.preventDefault();
                      void publishProposal(proposal);
                    }
                  }}
                  className="bg-panel text-cloud focus:border-violet/40 w-full resize-y rounded-lg border border-line px-3 py-2 text-[11px] leading-5 outline-none disabled:opacity-65"
                />
                <div className="mt-2 flex items-center justify-between gap-3">
                  <p className="text-fog text-[9px]">
                    Editable · posts inline to {providerName}
                  </p>
                  {proposal.published ? (
                    <Badge className="border-lime/20 bg-lime/8 text-lime">
                      Published
                    </Badge>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={
                        !proposal.aiJobId ||
                        !onPublishProposal ||
                        !body.trim() ||
                        Boolean(publishingProposal)
                      }
                      onClick={() => void publishProposal(proposal)}
                    >
                      {publishing ? (
                        <LoaderCircle className="size-3 animate-spin" />
                      ) : (
                        <Send className="size-3" />
                      )}
                      {publishing ? "Posting…" : `Post to ${providerName}`}
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </section>
      )}
      <form
        className="p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canAsk && draft.trim()) submitQuestion(draft);
        }}
      >
        <textarea
          ref={input}
          aria-label={`Ask AI about line ${line}`}
          value={draft}
          rows={2}
          placeholder="Ask a focused question about this code and its role in the pull request…"
          onChange={(event) => {
            setDraft(event.target.value);
            onDraftChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          className="bg-surface/70 text-cloud placeholder:text-fog min-h-16 w-full resize-y rounded-lg border border-line px-3 py-2 text-xs leading-5 outline-none transition focus:border-violet/40"
        />
        {entries.length === 0 && (
          <div className="mt-2">
            <p className="text-fog mb-1.5 text-[9px] font-medium">
              Quick questions
            </p>
            <div className="grid gap-1.5 sm:grid-cols-3">
              {AI_QUICK_QUESTIONS.map((quickQuestion) => (
                <button
                  key={quickQuestion.key}
                  type="button"
                  disabled={!canAsk}
                  aria-label={`Quick question ${quickQuestion.key}: ${quickQuestion.label}`}
                  onClick={() => submitQuestion(quickQuestion.question)}
                  className="border-line bg-surface/40 text-mist hover:border-violet/30 hover:bg-violet/[.06] hover:text-cloud flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[10px] transition disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ShortcutHint
                    shortcut={[
                      { key: quickQuestion.key, mod: true, shift: true },
                    ]}
                    className="shrink-0"
                  />
                  <span className="truncate">{quickQuestion.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-fog text-[9px]">
            ↑ / ↓ move focus · The answer uses this unit and the full PR
            context.
          </p>
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={!canAsk || !draft.trim()}
          >
            <Send className="size-3" />
            Ask
            <ShortcutHint shortcut={[{ key: "Enter" }]} />
          </Button>
        </div>
      </form>
      {deleteDialogOpen && (
        <ConfirmationDialog
          title="Delete this AI conversation?"
          description={
            <>
              The questions, answers, and unpublished suggestions in this
              line-focused conversation will be permanently deleted. Comments
              already published to {providerName} will remain.
            </>
          }
          confirmLabel="Delete conversation"
          confirmVariant="danger"
          icon={<Trash2 className="size-5" />}
          iconClassName="bg-red-500/10 text-red-600 dark:text-red-300"
          pending={deletingThread}
          pendingLabel={
            <>
              <LoaderCircle className="size-3 animate-spin" />
              Deleting…
            </>
          }
          onCancel={() => setDeleteDialogOpen(false)}
          onConfirm={() => {
            if (deletingThread || !onDeleteThread) return;
            setDeletingThread(true);
            void onDeleteThread(
              entries.flatMap(({ jobId }) => (jobId ? [jobId] : [])),
            )
              .then(() => setDeleteDialogOpen(false))
              .catch(() => undefined)
              .finally(() => setDeletingThread(false));
          }}
        />
      )}
    </article>
  );
}

/** Renders reusable syntax-highlighted tokens for static and interactive rows. */
