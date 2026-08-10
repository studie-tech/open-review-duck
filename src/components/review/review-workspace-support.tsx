"use client";

import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  ExternalLink,
  GitBranch,
  GripVertical,
  LoaderCircle,
  MessageSquareText,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import {
  Fragment,
  forwardRef,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { ShortcutHint } from "~/components/command-center";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import {
  type ImportReference,
  type ImportStatement,
  importReferenceIsUsed,
  type PairedImportStatement,
  pairImportStatements,
} from "~/lib/import-navigation";
import type { KeyboardShortcut } from "~/lib/keyboard-shortcuts";
import type {
  IndexedReviewUnit,
  ReviewHierarchyNode,
} from "~/lib/review-navigation";
import {
  compactSideBySideDiff,
  focusedRowRegions,
  focusedRowSpan,
  sideBySideDiff,
} from "~/lib/side-by-side-diff";
import {
  type HighlightedLine,
  useHighlightedSource,
} from "~/lib/syntax-highlighting";
import { useImportStatements } from "~/lib/tree-sitter-import-navigation";
import { cn } from "~/lib/utils";
import {
  type SupportedLanguage,
  supportedLanguages,
} from "~/server/analysis/types";
import type { RouterOutputs } from "~/trpc/react";
import { ProviderCommentBody } from "./provider-comment-body";

type WorkspaceData = RouterOutputs["review"]["workspace"];
type ReviewUnit = WorkspaceData["units"][number];

type ProviderConversationThread =
  RouterOutputs["review"]["providerConversations"]["threads"][number];

export const INITIAL_PATH_ITEMS = 10;
export const PATH_PAGE_SIZE = 20;
export const CONTEXT_PAGE_LINES = 20;
/**
 * How long a fetched provider conversation snapshot is treated as current.
 *
 * Reading provider conversations costs a live GitHub, GitLab, or Azure DevOps
 * round trip, so this is the one place that decides how old that view of the
 * conversations may become before the workspace refreshes it in the background.
 */
export const PROVIDER_CONVERSATION_REFRESH_MS = 45_000;
const DIFF_CONTEXT_PAGE_LINES = 20;
export const reviewShortcuts = {
  nextUnit: [{ key: "ArrowDown", mod: true }],
  previousUnit: [{ key: "ArrowUp", mod: true }],
  nextConcept: [{ key: "ArrowRight" }],
  previousConcept: [{ key: "ArrowLeft" }],
  scrollUp: [{ key: "ArrowUp" }],
  scrollDown: [{ key: "ArrowDown" }],
  revealContextAbove: [{ key: "ArrowUp", shift: true }],
  revealContextBelow: [{ key: "ArrowDown", shift: true }],
  togglePathPanel: [{ key: "b", mod: true }],
  toggleInsightsPanel: [{ key: "g", mod: true }],
  nextPending: [{ key: "n" }],
  nextReview: [{ key: "n", shift: true }],
  search: [{ key: "f" }],
  askAi: [{ key: "e" }],
  reviewPullRequest: [{ key: "a" }],
  comment: [{ key: "l" }],
  context: [{ key: "c" }],
  signOff: [{ key: "s" }],
  signOffDeletions: [{ key: "d", shift: true }],
  undoReview: [{ key: "u" }],
  awaitResponse: [{ key: "w" }],
  refresh: [{ key: "r" }],
  reset: [{ key: "r", shift: true }],
  loadChanges: [{ key: "r" }],
  dashboard: [{ key: "g" }, { key: "r" }],
  aiSettings: [{ key: "g" }, { key: "a" }],
  postComment: [{ key: "Enter", mod: true }],
} satisfies Record<string, KeyboardShortcut>;

/**
 * Reports whether a member no longer needs the reviewer's attention.
 *
 * A unit whose code changed after it was signed off comes back as "changed",
 * so only a standing sign-off counts as read.
 */
function reviewedMember(unit: ReviewUnit) {
  return unit.status === "signed_off";
}

/**
 * Orders a concept's members by what the reviewer still owes.
 *
 * Members are read in dependency order, which the signed-off ones no longer
 * take part in: they hold that order among themselves but sit below the work
 * that remains, so a part-reviewed concept opens on what is left.
 */
export function conceptMembersInReadingOrder<Member extends { status: string }>(
  members: readonly Member[],
) {
  return [...members].sort(
    (left, right) =>
      Number(left.status === "signed_off") -
      Number(right.status === "signed_off"),
  );
}

/** Renders the shared identity and selection treatment for one concept member. */
export function ReviewConceptMemberHeader({
  unit,
  index,
  count,
  selected,
  onSelect,
  expanded,
  onToggleExpanded,
}: {
  unit: ReviewUnit;
  index: number;
  count: number;
  selected: boolean;
  onSelect?: () => void;
  expanded?: boolean;
  onToggleExpanded?: () => void;
}) {
  const content = (
    <>
      <span className="min-w-0">
        <span className="text-cloud block truncate font-mono text-[10px]">
          {unit.path}
        </span>
        <span className="text-fog mt-0.5 block truncate text-[9px]">
          {unit.name} · {unit.changedLineCount} changed lines
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 text-[9px]">
        <span className="text-fog">
          Unit {index + 1}/{count}
        </span>
        {reviewedMember(unit) && (
          // Green, not the accent: the accent is the colour of the sign-off
          // button, and a marker saying "already done" must not wear the same
          // hue as the control asking for the next sign-off.
          <span className="border-addition/30 bg-addition/10 text-addition flex items-center gap-1 rounded-full border px-2 py-0.5">
            <Check className="size-2.5" aria-hidden />
            Reviewed
          </span>
        )}
        {selected && (
          <span className="border-cyan/25 bg-cyan/10 text-cyan rounded-full border px-2 py-0.5">
            Selected
          </span>
        )}
      </span>
    </>
  );
  return (
    <div
      className={cn(
        "flex items-stretch border-b",
        selected
          ? "bg-cyan/[.035] border-cyan/20"
          : reviewedMember(unit)
            ? "border-addition/25"
            : "border-line",
      )}
    >
      {onToggleExpanded && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${unit.name}`}
          onClick={onToggleExpanded}
          className="hover:bg-surface-subtle text-fog flex shrink-0 items-center px-2 transition"
        >
          <ChevronRight
            className={cn(
              "size-3.5 transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden
          />
        </button>
      )}
      {selected ? (
        <div className="flex min-w-0 flex-1 items-center justify-between gap-3 px-3 py-2 text-left">
          {content}
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Select ${unit.name}`}
          onClick={onSelect}
          className="hover:bg-surface-subtle flex min-w-0 flex-1 items-center justify-between gap-3 px-3 py-2 text-left transition"
        >
          {content}
        </button>
      )}
    </div>
  );
}

/** Renders a selectable, syntax-highlighted atomic member without hiding its code. */
export function ReviewConceptMemberPreview({
  unit,
  index,
  count,
  sourceAvailable,
  onSelect,
}: {
  unit: ReviewUnit;
  index: number;
  count: number;
  sourceAvailable: boolean;
  onSelect: () => void;
}) {
  const source =
    unit.changeType === "deleted"
      ? (unit.previousSource ?? unit.source)
      : unit.source;
  const lines = useHighlightedSource(source, unit.language);
  // A member already signed off opens closed: its header still says what it
  // is and that it is done, and the code behind it is work the reviewer has
  // finished reading.
  const [expanded, setExpanded] = useState(() => !reviewedMember(unit));
  return (
    <article
      data-review-member-id={unit.id}
      className={cn(
        "mx-4 overflow-hidden rounded-xl border",
        // A read member stays legible but stops competing for attention, so
        // the eye lands on what is left to review.
        reviewedMember(unit)
          ? "border-addition/30 bg-addition/[.04]"
          : "border-line bg-surface/30",
      )}
    >
      <ReviewConceptMemberHeader
        unit={unit}
        index={index}
        count={count}
        selected={false}
        onSelect={onSelect}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((open) => !open)}
      />
      {!expanded ? null : !sourceAvailable ? (
        <p className="px-3 py-4 font-sans text-[10px] text-amber-700 dark:text-amber-200">
          Source unavailable. Concept sign-off is blocked.
        </p>
      ) : unit.kind === "binary" ? (
        <p className="text-mist px-3 py-4 font-sans text-[10px]">
          Binary change · explicit acknowledgement required
        </p>
      ) : (
        // A member is read in the page's own scroll rather than in a window of
        // its own: a card that scrolls inside a scrolling page hides how much
        // of a concept is left and takes two gestures to read one unit. Only
        // long lines scroll, and only sideways.
        <div className="overflow-x-auto py-2">
          {lines.map((line, lineIndex) => (
            <div
              key={`${unit.id}-${lineIndex}`}
              className="grid grid-cols-[55px_1fr] px-3 hover:bg-surface-subtle"
            >
              <span className="text-fog flex items-start justify-end pr-3 text-right select-none">
                {unit.startLine + lineIndex}
              </span>
              <pre className="syntax-code overflow-visible text-cloud/80">
                {line.tokens.length
                  ? line.tokens.map((token, tokenIndex) => (
                      <span
                        key={`${tokenIndex}-${token.text.length}`}
                        className={token.className || undefined}
                      >
                        {token.text}
                      </span>
                    ))
                  : " "}
              </pre>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

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

export interface AiConversationVisibility {
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

/** Finds the nearest rendered review line to a vertical pointer coordinate. */
function nearestRenderedReviewLine(
  clientY: number,
  minimumLine: number,
  maximumLine: number,
) {
  let nearest: { distance: number; line: number } | undefined;
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
    const distance = Math.abs(clientY - (bounds.top + bounds.height / 2));
    if (!nearest || distance < nearest.distance) nearest = { distance, line };
  }
  return nearest?.line;
}

/** Renders a line-anchored AI conversation that can move through review scope. */
export function InlineAiQuestion({
  autoFocus = true,
  canAsk,
  draft,
  entries,
  line,
  maximumLine,
  minimumLine,
  onAsk,
  onChange,
  onClose,
  onDeleteThread,
  onMove,
  onPreview,
  onPublishProposal,
  onStep,
  providerName = "provider",
}: {
  autoFocus?: boolean;
  canAsk: boolean;
  draft: string;
  entries: AiQuestionEntry[];
  line: number;
  maximumLine: number;
  minimumLine: number;
  onAsk: (question?: string) => void;
  onChange: (value: string) => void;
  onClose: () => void;
  onDeleteThread?: (jobIds: string[]) => Promise<void>;
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
          onAsk(quickQuestion.question);
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
  }, [canAsk, entries.length, onAsk, onStep, proposals, publishProposal]);

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

    /** Removes global drag listeners and restores document interaction styles. */
    function cleanupDrag() {
      window.removeEventListener("pointermove", previewDrag, true);
      window.removeEventListener("pointerup", finishDrag, true);
      window.removeEventListener("pointercancel", cancelDrag, true);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      clearDragListeners.current = () => undefined;
    }

    /** Previews the closest rendered in-scope line beneath the pointer. */
    function previewDrag(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== pointerId) return;
      pointerEvent.preventDefault();
      const nearest = nearestRenderedReviewLine(
        pointerEvent.clientY,
        minimumLine,
        maximumLine,
      );
      if (nearest === undefined || nearest === previewLine.current) return;
      previewLine.current = nearest;
      onPreview(nearest);
    }

    /** Commits the previewed line after a completed drag. */
    function finishDrag(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== pointerId) return;
      pointerEvent.preventDefault();
      cleanupDrag();
      onPreview(undefined);
      onMove(previewLine.current);
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
      className="border-violet/25 bg-panel relative mx-4 my-3 ml-[71px] overflow-hidden rounded-xl border font-sans shadow-[0_14px_40px_var(--app-shadow)]"
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
          if (canAsk && draft.trim()) onAsk();
        }}
      >
        <textarea
          ref={input}
          aria-label={`Ask AI about line ${line}`}
          value={draft}
          rows={2}
          placeholder="Ask a focused question about this code and its role in the pull request…"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (canAsk && draft.trim()) onAsk();
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
                  onClick={() => onAsk(quickQuestion.question)}
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
function HighlightedDiffTokens({
  line,
}: {
  line: HighlightedLine | undefined;
}) {
  return line?.tokens.length
    ? line.tokens.map((token, index) => (
        <span
          key={`${index}-${token.text.length}`}
          className={token.className || undefined}
        >
          {token.text}
        </span>
      ))
    : " ";
}

/** Renders one syntax-highlighted line without adding a second code block. */
function HighlightedDiffLine({ line }: { line: HighlightedLine | undefined }) {
  return (
    <pre className="syntax-code min-w-0 overflow-visible px-3 whitespace-pre-wrap break-words text-cloud/80">
      <HighlightedDiffTokens line={line} />
    </pre>
  );
}

/** Reveals the next page beyond the unit edge, including any deferred edge gap. */
function DiffEdgeRevealButton({
  direction,
  collapsedRemaining,
  externalRemaining,
  onReveal,
}: {
  direction: -1 | 1;
  collapsedRemaining: number;
  externalRemaining: number;
  onReveal: () => void;
}) {
  const totalRemaining = collapsedRemaining + externalRemaining;
  if (totalRemaining <= 0) return null;
  const pageSize = Math.min(DIFF_CONTEXT_PAGE_LINES, totalRemaining);
  const directionLabel = direction === -1 ? "above" : "below";
  const ariaLabel =
    collapsedRemaining > 0 && externalRemaining > 0
      ? `Show more lines ${directionLabel}`
      : collapsedRemaining > 0
        ? `Show ${pageSize} more lines ${directionLabel}`
        : `Show ${pageSize} lines ${directionLabel}`;
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onReveal}
      className="text-fog hover:text-cloud flex w-full items-center justify-center gap-2 border-y border-line/50 bg-surface-subtle/40 px-3 py-1.5 font-sans text-[10px] transition"
    >
      <ChevronDown className={cn("size-3", direction === -1 && "rotate-180")} />
      {collapsedRemaining > 0 && externalRemaining > 0 ? (
        <>
          Show more {directionLabel}
          <span className="text-mist">
            next {pageSize} of {totalRemaining}
          </span>
        </>
      ) : collapsedRemaining > 0 ? (
        <>
          Show {pageSize} more lines {directionLabel}
          <span className="text-mist">({collapsedRemaining} hidden)</span>
        </>
      ) : (
        <>
          Show {pageSize} lines {directionLabel}
          <span className="text-mist">of {externalRemaining}</span>
        </>
      )}
      <ShortcutHint
        shortcut={
          direction === -1
            ? reviewShortcuts.revealContextAbove
            : reviewShortcuts.revealContextBelow
        }
      />
    </button>
  );
}

/** Reveals another page from an unchanged region inside the focused unit. */
function DiffCollapsedContextButton({
  count,
  revealed,
  onReveal,
}: {
  count: number;
  revealed: number;
  onReveal: () => void;
}) {
  const remaining = count - revealed;
  const pageSize = Math.min(DIFF_CONTEXT_PAGE_LINES, remaining);
  return (
    <button
      type="button"
      aria-label={`Show ${pageSize} more unchanged lines`}
      onClick={onReveal}
      className="text-fog hover:text-cloud flex w-full items-center justify-center gap-2 border-y border-line/70 bg-surface-subtle/55 px-3 py-2 font-sans text-[10px] transition"
    >
      <ChevronDown className="size-3" />
      Show {pageSize} more unchanged lines
      <span className="text-mist">({remaining} hidden)</span>
    </button>
  );
}

export interface SideBySideUnitDiffHandle {
  revealContext: (direction: -1 | 1) => boolean;
}

interface SideBySideUnitDiffProps {
  previousSource: string;
  currentSource: string;
  language: string;
  previousStartLine: number;
  currentStartLine: number;
  previousFocusRanges?: Array<{ startLine: number; endLine: number }>;
  currentFocusRanges?: Array<{ startLine: number; endLine: number }>;
  previousFocusStartLine?: number | null;
  previousFocusEndLine?: number | null;
  currentFocusStartLine?: number | null;
  currentFocusEndLine?: number | null;
  selectedLine?: number;
  keyboardLine?: number;
  onSelectReviewLine: (line: number) => void;
  renderLineDetails?: (line: number) => ReactNode;
}

/** Separates the reviewed unit from surrounding source context. */
export function ReviewScopeMarker({
  edge,
  line,
}: {
  edge: "start" | "end";
  line: number;
}) {
  const label = edge === "start" ? "Unit starts" : "Unit ends";
  return (
    <div
      data-review-scope-edge={edge}
      className="my-2 flex items-center gap-3 px-4 font-sans"
    >
      <span className="text-cyan w-[55px] shrink-0 text-right text-[9px]">
        Review scope
      </span>
      <span className="h-px flex-1 bg-cyan/25" />
      <span className="border-cyan/20 bg-cyan/[.06] text-cyan rounded-full border px-2.5 py-1 text-[9px] whitespace-nowrap">
        {label} · line {line}
      </span>
    </div>
  );
}

/** Shows a focused base/head diff with aligned lines and provider comment actions. */
export const SideBySideUnitDiff = forwardRef<
  SideBySideUnitDiffHandle,
  SideBySideUnitDiffProps
>(function SideBySideUnitDiff(
  {
    previousSource,
    currentSource,
    language,
    previousStartLine,
    currentStartLine,
    previousFocusRanges,
    currentFocusRanges,
    previousFocusStartLine,
    previousFocusEndLine,
    currentFocusStartLine,
    currentFocusEndLine,
    selectedLine,
    keyboardLine,
    onSelectReviewLine,
    renderLineDetails,
  },
  ref,
) {
  const previousLines = useHighlightedSource(previousSource, language);
  const currentLines = useHighlightedSource(currentSource, language);
  const rows = useMemo(
    () => sideBySideDiff(previousSource, currentSource),
    [currentSource, previousSource],
  );
  const focusRange = useMemo(() => {
    const previousRanges =
      previousFocusRanges ??
      (previousFocusStartLine === null
        ? []
        : [
            {
              startLine: previousFocusStartLine ?? previousStartLine,
              endLine:
                previousFocusEndLine ??
                previousStartLine + Math.max(0, previousLines.length - 1),
            },
          ]);
    const currentRanges =
      currentFocusRanges ??
      (currentFocusStartLine === null
        ? []
        : [
            {
              startLine: currentFocusStartLine ?? currentStartLine,
              endLine:
                currentFocusEndLine ??
                currentStartLine + Math.max(0, currentLines.length - 1),
            },
          ]);
    const previousStart =
      previousRanges.length > 0
        ? Math.min(...previousRanges.map(({ startLine }) => startLine))
        : undefined;
    const previousEnd =
      previousRanges.length > 0
        ? Math.max(...previousRanges.map(({ endLine }) => endLine))
        : undefined;
    const currentStart =
      currentRanges.length > 0
        ? Math.min(...currentRanges.map(({ startLine }) => startLine))
        : undefined;
    const currentEnd =
      currentRanges.length > 0
        ? Math.max(...currentRanges.map(({ endLine }) => endLine))
        : undefined;
    const span = focusedRowSpan({
      rows,
      previousStartLine,
      currentStartLine,
      previousRanges,
      currentRanges,
      multiRange:
        previousFocusRanges !== undefined || currentFocusRanges !== undefined,
    });
    return {
      start: span.start,
      end: span.end,
      previousStart,
      previousEnd,
      currentStart,
      currentEnd,
      previousRanges,
      currentRanges,
      // Only a declaration stating several ranges leaves gaps holding other
      // declarations; a single range has none, and asking for its regions
      // would collapse the surrounding source a reviewer paged in.
      ownRegions:
        previousFocusRanges !== undefined || currentFocusRanges !== undefined
          ? focusedRowRegions({
              rows,
              previousStartLine,
              currentStartLine,
              previousRanges,
              currentRanges,
            })
          : undefined,
    };
  }, [
    currentFocusEndLine,
    currentFocusRanges,
    currentFocusStartLine,
    currentLines.length,
    currentStartLine,
    previousFocusEndLine,
    previousFocusRanges,
    previousFocusStartLine,
    previousLines.length,
    previousStartLine,
    rows,
  ]);
  const [contextBeforeRows, setContextBeforeRows] = useState(0);
  const [contextAfterRows, setContextAfterRows] = useState(0);
  const visibleRowStart = Math.max(0, focusRange.start - contextBeforeRows);
  const visibleRowEnd = Math.min(
    rows.length,
    focusRange.end + contextAfterRows,
  );
  const visibleRows = useMemo(
    () => rows.slice(visibleRowStart, visibleRowEnd),
    [rows, visibleRowEnd, visibleRowStart],
  );
  const hasExplicitFocus =
    previousFocusRanges !== undefined ||
    currentFocusRanges !== undefined ||
    previousFocusStartLine !== undefined ||
    previousFocusEndLine !== undefined ||
    currentFocusStartLine !== undefined ||
    currentFocusEndLine !== undefined;
  const focusedRows = rows.slice(focusRange.start, focusRange.end);
  const explicitFocusHasDiff = focusedRows.some(
    (row) => row.kind !== "unchanged",
  );
  const compactRows = useMemo(() => {
    const focusStart = Math.max(0, focusRange.start - visibleRowStart);
    const focusEnd = Math.min(
      visibleRows.length,
      Math.max(focusStart, focusRange.end - visibleRowStart),
    );
    const hasFocusWindow = hasExplicitFocus && focusEnd > focusStart;
    return compactSideBySideDiff(visibleRows, 3, {
      // Keep undiffed focus windows fully expanded.
      requiredRange:
        hasFocusWindow && !explicitFocusHasDiff
          ? { start: focusStart, end: focusEnd }
          : undefined,
      // Never recollapse paged surrounding file context — that yanks scroll.
      collapseWithin: hasFocusWindow
        ? { start: focusStart, end: focusEnd }
        : undefined,
      // Keep unit edges visible so trail compact never stacks with "show below".
      pinRangeEnds: hasFocusWindow && explicitFocusHasDiff ? 2 : 0,
      ownRegions: focusRange.ownRegions?.map(({ start, end }) => ({
        start: start - visibleRowStart,
        end: end - visibleRowStart,
      })),
    });
  }, [
    explicitFocusHasDiff,
    focusRange.end,
    focusRange.ownRegions,
    focusRange.start,
    hasExplicitFocus,
    visibleRowStart,
    visibleRows,
  ]);
  const [revealedGapLines, setRevealedGapLines] = useState<Map<string, number>>(
    () => new Map(),
  );
  const revealEdge = useCallback(
    (direction: -1 | 1) => {
      const collapsedGaps = compactRows.filter(
        (
          item,
        ): item is Extract<
          (typeof compactRows)[number],
          { kind: "collapsed" }
        > => item.kind === "collapsed",
      );
      // Expand the collapse nearest the edge being scrolled, so pinned unit
      // ends still let ArrowUp/Down unfold the interior toward that edge.
      const gap = direction === -1 ? collapsedGaps[0] : collapsedGaps.at(-1);
      if (gap) {
        const key = `${visibleRowStart + gap.rowStart}-${visibleRowStart + gap.rowEnd}`;
        const revealed = revealedGapLines.get(key) ?? 0;
        if (revealed < gap.count) {
          setRevealedGapLines((current) => {
            const next = new Map(current);
            next.set(
              key,
              Math.min(
                gap.count,
                (current.get(key) ?? 0) + DIFF_CONTEXT_PAGE_LINES,
              ),
            );
            return next;
          });
          return true;
        }
      }
      if (direction === -1 && visibleRowStart > 0) {
        setContextBeforeRows((current) =>
          Math.min(focusRange.start, current + DIFF_CONTEXT_PAGE_LINES),
        );
        return true;
      }
      if (direction === 1 && visibleRowEnd < rows.length) {
        setContextAfterRows((current) =>
          Math.min(
            rows.length - focusRange.end,
            current + DIFF_CONTEXT_PAGE_LINES,
          ),
        );
        return true;
      }
      return false;
    },
    [
      compactRows,
      focusRange.end,
      focusRange.start,
      revealedGapLines,
      rows.length,
      visibleRowEnd,
      visibleRowStart,
    ],
  );
  // File-context paging only — unit interior uses in-flow collapse buttons.
  const leadingCollapsedRemaining = 0;
  const trailingCollapsedRemaining = 0;
  useImperativeHandle(
    ref,
    () => ({
      revealContext(direction) {
        return revealEdge(direction);
      },
    }),
    [revealEdge],
  );
  const displayItems = useMemo(
    () =>
      compactRows.flatMap((item) => {
        if (item.kind === "row") return [item];
        const key = `${visibleRowStart + item.rowStart}-${visibleRowStart + item.rowEnd}`;
        const revealed = Math.min(revealedGapLines.get(key) ?? 0, item.count);
        if (revealed === 0) return [item];
        if (revealed === item.count) {
          return visibleRows
            .slice(item.rowStart, item.rowEnd)
            .map((row, index) => ({
              kind: "row" as const,
              row,
              rowIndex: item.rowStart + index,
            }));
        }

        // Expand from the side nearest the change neighborhood defaults
        // kept: reveal symmetrically inside unit interior collapses.
        const revealedBefore = Math.ceil(revealed / 2);
        const revealedAfter = Math.floor(revealed / 2);
        const before = visibleRows
          .slice(item.rowStart, item.rowStart + revealedBefore)
          .map((row, index) => ({
            kind: "row" as const,
            row,
            rowIndex: item.rowStart + index,
          }));
        const afterStart = item.rowEnd - revealedAfter;
        const after = visibleRows
          .slice(afterStart, item.rowEnd)
          .map((row, index) => ({
            kind: "row" as const,
            row,
            rowIndex: afterStart + index,
          }));
        return [...before, item, ...after];
      }),
    [compactRows, revealedGapLines, visibleRowStart, visibleRows],
  );
  const additionOnly =
    focusedRows.length > 0 && focusedRows.every((row) => row.kind === "added");
  const scopeStartLine = focusRange.currentStart ?? focusRange.previousStart;
  const scopeEndLine = focusRange.currentEnd ?? focusRange.previousEnd;
  const showsContextBefore = visibleRowStart < focusRange.start;
  const showsContextAfter = visibleRowEnd > focusRange.end;

  /** Returns the provider-commentable line represented by one focused row. */
  function reviewLineForRow(row: (typeof rows)[number]) {
    const currentLine =
      row.currentIndex === undefined
        ? undefined
        : currentStartLine + row.currentIndex;
    if (
      currentLine !== undefined &&
      focusRange.currentRanges.some(
        ({ startLine, endLine }) =>
          currentLine >= startLine && currentLine <= endLine,
      )
    ) {
      return currentLine;
    }
    const previousLine =
      row.previousIndex === undefined
        ? undefined
        : previousStartLine + row.previousIndex;
    return previousLine !== undefined &&
      focusRange.previousRanges.some(
        ({ startLine, endLine }) =>
          previousLine >= startLine && previousLine <= endLine,
      )
      ? previousLine
      : undefined;
  }
  const renderedDetailLines = new Set<number>();

  if (additionOnly) {
    return (
      <section
        aria-label="Added code diff"
        className="overflow-hidden rounded-b-xl border border-line"
      >
        {visibleRowStart > 0 || leadingCollapsedRemaining > 0 ? (
          <DiffEdgeRevealButton
            direction={-1}
            collapsedRemaining={leadingCollapsedRemaining}
            externalRemaining={visibleRowStart}
            onReveal={() => {
              revealEdge(-1);
            }}
          />
        ) : null}
        {displayItems.map((item) => {
          if (item.kind === "collapsed") {
            const absoluteStart = visibleRowStart + item.rowStart;
            const absoluteEnd = visibleRowStart + item.rowEnd;
            const key = `${absoluteStart}-${absoluteEnd}`;
            const revealed = revealedGapLines.get(key) ?? 0;
            return (
              <DiffCollapsedContextButton
                key={`gap-${key}`}
                count={item.count}
                revealed={revealed}
                onReveal={() =>
                  setRevealedGapLines((current) => {
                    const next = new Map(current);
                    next.set(
                      key,
                      Math.min(
                        item.count,
                        (current.get(key) ?? 0) + DIFF_CONTEXT_PAGE_LINES,
                      ),
                    );
                    return next;
                  })
                }
              />
            );
          }
          const { row } = item;
          const lineNumber =
            row.currentIndex === undefined
              ? undefined
              : currentStartLine + row.currentIndex;
          const line =
            row.currentIndex === undefined
              ? undefined
              : currentLines[row.currentIndex];
          const reviewLine = reviewLineForRow(row);
          const rendersLineDetails =
            reviewLine !== undefined && !renderedDetailLines.has(reviewLine);
          if (rendersLineDetails) renderedDetailLines.add(reviewLine);
          const interactive = reviewLine !== undefined;
          const absoluteRowIndex = visibleRowStart + item.rowIndex;
          const isContextRow = reviewLine === undefined;
          const startsScope =
            showsContextBefore &&
            absoluteRowIndex === focusRange.start &&
            scopeStartLine !== undefined;
          const endsScope =
            showsContextAfter &&
            absoluteRowIndex === focusRange.end - 1 &&
            scopeEndLine !== undefined;
          const LineContainer = interactive ? "button" : "div";
          return (
            <Fragment
              key={`${item.rowIndex}-${row.currentIndex ?? "x"}-${row.previousIndex ?? "x"}`}
            >
              {startsScope && (
                <ReviewScopeMarker edge="start" line={scopeStartLine} />
              )}
              <LineContainer
                {...(interactive
                  ? {
                      type: "button" as const,
                      "aria-label": `Comment on current line ${reviewLine}`,
                      title: "Comment on this pull-request line",
                      onClick: () => onSelectReviewLine(reviewLine),
                    }
                  : {})}
                id={
                  !rendersLineDetails ? undefined : `review-line-${reviewLine}`
                }
                data-review-scope={isContextRow ? "context" : "unit"}
                className={cn(
                  "group grid w-full grid-cols-[50px_minmax(0,1fr)] text-left",
                  row.kind === "added"
                    ? "bg-addition/[.085]"
                    : "bg-surface-subtle/20",
                  interactive &&
                    "cursor-pointer transition hover:bg-addition/[.13] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
                  selectedLine === reviewLine && "bg-violet/[.055]",
                  keyboardLine === reviewLine &&
                    "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
                  isContextRow &&
                    "bg-surface-subtle/15 opacity-55 transition-opacity hover:opacity-80",
                )}
              >
                <span className="flex items-center justify-end gap-1 border-r border-line/60 px-2 text-addition transition select-none group-hover:text-violet">
                  {interactive && (
                    <MessageSquareText
                      className={cn(
                        "size-3 transition-opacity",
                        selectedLine === reviewLine ||
                          keyboardLine === reviewLine
                          ? "text-cyan opacity-100"
                          : "opacity-0 group-hover:opacity-100",
                      )}
                    />
                  )}
                  {lineNumber}
                </span>
                <span className="syntax-code min-w-0 overflow-visible px-3 whitespace-pre-wrap break-words text-cloud/80">
                  <HighlightedDiffTokens line={line} />
                </span>
              </LineContainer>
              {rendersLineDetails && renderLineDetails?.(reviewLine)}
              {endsScope && (
                <ReviewScopeMarker edge="end" line={scopeEndLine} />
              )}
            </Fragment>
          );
        })}
        {visibleRowEnd < rows.length || trailingCollapsedRemaining > 0 ? (
          <DiffEdgeRevealButton
            direction={1}
            collapsedRemaining={trailingCollapsedRemaining}
            externalRemaining={Math.max(0, rows.length - visibleRowEnd)}
            onReveal={() => {
              revealEdge(1);
            }}
          />
        ) : null}
      </section>
    );
  }

  return (
    <section
      aria-label="Side-by-side code diff"
      className="overflow-hidden rounded-b-xl border border-line"
    >
      <div className="text-fog sticky top-0 z-10 hidden grid-cols-2 border-b border-line bg-panel/95 font-sans text-[9px] font-semibold tracking-[.12em] uppercase backdrop-blur sm:grid">
        <div className="border-r border-line px-4 py-2">Base</div>
        <div className="px-4 py-2">Pull request</div>
      </div>
      <div className="text-fog sticky top-0 z-10 border-b border-line bg-panel/95 px-4 py-2 font-sans text-[9px] font-semibold tracking-[.12em] uppercase backdrop-blur sm:hidden">
        Changes
      </div>
      {visibleRowStart > 0 || leadingCollapsedRemaining > 0 ? (
        <DiffEdgeRevealButton
          direction={-1}
          collapsedRemaining={leadingCollapsedRemaining}
          externalRemaining={visibleRowStart}
          onReveal={() => {
            revealEdge(-1);
          }}
        />
      ) : null}
      {displayItems.map((item) => {
        if (item.kind === "collapsed") {
          const key = `${visibleRowStart + item.rowStart}-${visibleRowStart + item.rowEnd}`;
          const revealed = revealedGapLines.get(key) ?? 0;
          return (
            <DiffCollapsedContextButton
              key={`gap-${key}`}
              count={item.count}
              revealed={revealed}
              onReveal={() =>
                setRevealedGapLines((current) => {
                  const next = new Map(current);
                  next.set(
                    key,
                    Math.min(
                      item.count,
                      (current.get(key) ?? 0) + DIFF_CONTEXT_PAGE_LINES,
                    ),
                  );
                  return next;
                })
              }
            />
          );
        }
        const { row, rowIndex } = item;
        const previousLineNumber =
          row.previousIndex === undefined
            ? undefined
            : previousStartLine + row.previousIndex;
        const currentLineNumber =
          row.currentIndex === undefined
            ? undefined
            : currentStartLine + row.currentIndex;
        const previousLine =
          row.previousIndex === undefined
            ? undefined
            : previousLines[row.previousIndex];
        const currentLine =
          row.currentIndex === undefined
            ? undefined
            : currentLines[row.currentIndex];
        const reviewLine = reviewLineForRow(row);
        const rendersLineDetails =
          reviewLine !== undefined && !renderedDetailLines.has(reviewLine);
        if (rendersLineDetails) renderedDetailLines.add(reviewLine);
        const currentIsReviewLine =
          reviewLine !== undefined &&
          currentLineNumber !== undefined &&
          reviewLine === currentLineNumber &&
          focusRange.currentRanges.some(
            ({ startLine, endLine }) =>
              currentLineNumber >= startLine && currentLineNumber <= endLine,
          );
        const previousIsReviewLine =
          reviewLine !== undefined &&
          previousLineNumber !== undefined &&
          reviewLine === previousLineNumber &&
          !currentIsReviewLine;
        const absoluteRowIndex = visibleRowStart + rowIndex;
        const isContextRow = reviewLine === undefined;
        const startsScope =
          showsContextBefore &&
          absoluteRowIndex === focusRange.start &&
          scopeStartLine !== undefined;
        const endsScope =
          showsContextAfter &&
          absoluteRowIndex === focusRange.end - 1 &&
          scopeEndLine !== undefined;
        const key = `${rowIndex}-${row.previousIndex ?? "x"}-${row.currentIndex ?? "x"}`;
        return (
          <Fragment key={key}>
            {startsScope && (
              <ReviewScopeMarker edge="start" line={scopeStartLine} />
            )}
            {rendersLineDetails && (
              <span
                id={`review-line-${reviewLine}`}
                className="block h-0"
                aria-hidden="true"
              />
            )}
            <div
              data-review-scope={isContextRow ? "context" : "unit"}
              className={cn(
                "hidden grid-cols-[42px_minmax(0,1fr)_42px_minmax(0,1fr)] sm:grid",
                isContextRow &&
                  "bg-surface-subtle/15 opacity-55 transition-opacity hover:opacity-80",
              )}
            >
              {previousIsReviewLine ? (
                <button
                  type="button"
                  aria-label={`Comment on deleted line ${reviewLine}`}
                  title="Comment on this deleted pull-request line"
                  onClick={() => onSelectReviewLine(reviewLine)}
                  className={cn(
                    "group col-span-2 grid min-w-0 cursor-pointer grid-cols-[42px_minmax(0,1fr)] bg-red-400/[.07] text-left transition hover:bg-red-400/[.12] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
                    selectedLine === reviewLine && "bg-violet/[.055]",
                    keyboardLine === reviewLine &&
                      "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
                  )}
                >
                  <span className="flex items-center justify-end gap-1 border-r border-line/60 bg-red-400/10 px-2 text-red-700 transition select-none group-hover:text-violet dark:text-red-200">
                    <MessageSquareText
                      className={cn(
                        "size-3 transition-opacity",
                        selectedLine === reviewLine ||
                          keyboardLine === reviewLine
                          ? "text-cyan opacity-100"
                          : "opacity-0 group-hover:opacity-100",
                      )}
                    />
                    {previousLineNumber}
                  </span>
                  <HighlightedDiffLine line={previousLine} />
                </button>
              ) : (
                <>
                  <span
                    className={cn(
                      "flex justify-end border-r border-line/60 px-2 text-fog select-none",
                      (row.kind === "deleted" || row.kind === "modified") &&
                        "bg-red-400/10 text-red-700 dark:text-red-200",
                    )}
                  >
                    {previousLineNumber}
                  </span>
                  <div
                    className={cn(
                      "min-w-0 border-r border-line",
                      (row.kind === "deleted" || row.kind === "modified") &&
                        "bg-red-400/[.07]",
                    )}
                  >
                    <HighlightedDiffLine line={previousLine} />
                  </div>
                </>
              )}
              {currentLineNumber === undefined ? (
                <span className="col-span-2" />
              ) : !currentIsReviewLine ? (
                <div
                  className={cn(
                    "col-span-2 grid min-w-0 grid-cols-[42px_minmax(0,1fr)] text-fog",
                    (row.kind === "added" || row.kind === "modified") &&
                      "bg-addition/[.085]",
                  )}
                >
                  <span
                    className={cn(
                      "flex justify-end border-r border-line/60 px-2 select-none",
                      (row.kind === "added" || row.kind === "modified") &&
                        "bg-addition/12 text-addition",
                    )}
                  >
                    {currentLineNumber}
                  </span>
                  <span className="syntax-code min-w-0 overflow-visible px-3 whitespace-pre-wrap break-words text-cloud/80">
                    <HighlightedDiffTokens line={currentLine} />
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  aria-label={`Comment on current line ${reviewLine}`}
                  title="Comment on this pull-request line"
                  onClick={() => onSelectReviewLine(reviewLine)}
                  className={cn(
                    "group col-span-2 grid min-w-0 cursor-pointer grid-cols-[42px_minmax(0,1fr)] text-left text-fog transition hover:bg-cyan/[.045] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
                    (row.kind === "added" || row.kind === "modified") &&
                      "bg-addition/[.085] hover:bg-addition/[.13]",
                    selectedLine === reviewLine && "bg-violet/[.055]",
                    keyboardLine === reviewLine &&
                      "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
                  )}
                >
                  <span
                    className={cn(
                      "flex items-center justify-end gap-1 border-r border-line/60 px-2 transition select-none group-hover:text-violet",
                      (row.kind === "added" || row.kind === "modified") &&
                        "bg-addition/12 text-addition",
                    )}
                  >
                    <MessageSquareText
                      className={cn(
                        "size-3 transition-opacity",
                        selectedLine === reviewLine ||
                          keyboardLine === reviewLine
                          ? "text-cyan opacity-100"
                          : "opacity-0 group-hover:opacity-100",
                      )}
                    />
                    {currentLineNumber}
                  </span>
                  <span className="syntax-code min-w-0 overflow-visible px-3 whitespace-pre-wrap break-words text-cloud/80">
                    <HighlightedDiffTokens line={currentLine} />
                  </span>
                </button>
              )}
            </div>
            <div
              data-review-scope={isContextRow ? "context" : "unit"}
              className={cn(
                "sm:hidden",
                isContextRow &&
                  "bg-surface-subtle/15 opacity-55 transition-opacity hover:opacity-80",
              )}
            >
              {row.kind === "unchanged" ? (
                <div
                  className={cn(
                    "grid grid-cols-[42px_42px_minmax(0,1fr)]",
                    selectedLine === reviewLine && "bg-violet/[.055]",
                    keyboardLine === reviewLine &&
                      "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
                  )}
                >
                  <span className="text-fog border-r border-line/60 px-2 text-right select-none">
                    {previousLineNumber}
                  </span>
                  {currentIsReviewLine ? (
                    <button
                      type="button"
                      aria-label={`Comment on current line ${reviewLine}`}
                      title="Comment on this pull-request line"
                      onClick={() => onSelectReviewLine(reviewLine)}
                      className="group col-span-2 grid min-w-0 cursor-pointer grid-cols-[42px_minmax(0,1fr)] text-left text-fog transition hover:bg-cyan/[.045] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan"
                    >
                      <span className="flex items-center justify-end gap-1 border-r border-line/60 px-2 transition select-none group-hover:text-violet">
                        <MessageSquareText
                          className={cn(
                            "size-3 transition-opacity",
                            selectedLine === reviewLine ||
                              keyboardLine === reviewLine
                              ? "text-cyan opacity-100"
                              : "opacity-0 group-hover:opacity-100",
                          )}
                        />
                        {currentLineNumber}
                      </span>
                      <span className="syntax-code min-w-0 overflow-visible px-3 whitespace-pre-wrap break-words text-cloud/80">
                        <HighlightedDiffTokens line={currentLine} />
                      </span>
                    </button>
                  ) : (
                    <>
                      <span className="text-fog border-r border-line/60 px-2 text-right select-none">
                        {currentLineNumber}
                      </span>
                      <span className="syntax-code min-w-0 overflow-visible px-3 whitespace-pre-wrap break-words text-cloud/80">
                        <HighlightedDiffTokens line={currentLine} />
                      </span>
                    </>
                  )}
                </div>
              ) : (
                <>
                  {previousLine &&
                    (previousIsReviewLine ? (
                      <button
                        type="button"
                        aria-label={`Comment on deleted line ${reviewLine}`}
                        title="Comment on this deleted pull-request line"
                        onClick={() => onSelectReviewLine(reviewLine)}
                        className={cn(
                          "group grid w-full cursor-pointer grid-cols-[42px_42px_minmax(0,1fr)] bg-red-400/[.07] text-left transition hover:bg-red-400/[.12] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
                          selectedLine === reviewLine && "bg-violet/[.055]",
                          keyboardLine === reviewLine &&
                            "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
                        )}
                      >
                        <span className="bg-red-400/10 px-2 text-right text-red-700 select-none dark:text-red-200">
                          {previousLineNumber}
                        </span>
                        <span className="flex items-center justify-center gap-1 border-x border-line/60 px-2 text-red-700 transition select-none group-hover:text-violet dark:text-red-200">
                          <MessageSquareText
                            className={cn(
                              "size-3 transition-opacity",
                              selectedLine === reviewLine ||
                                keyboardLine === reviewLine
                                ? "text-cyan opacity-100"
                                : "opacity-0 group-hover:opacity-100",
                            )}
                          />
                          −
                        </span>
                        <HighlightedDiffLine line={previousLine} />
                      </button>
                    ) : (
                      <div className="grid grid-cols-[42px_42px_minmax(0,1fr)] bg-red-400/[.07]">
                        <span className="bg-red-400/10 px-2 text-right text-red-700 select-none dark:text-red-200">
                          {previousLineNumber}
                        </span>
                        <span className="border-x border-line/60 px-2 text-center text-red-700 select-none dark:text-red-200">
                          −
                        </span>
                        <HighlightedDiffLine line={previousLine} />
                      </div>
                    ))}
                  {currentLine &&
                    (currentIsReviewLine ? (
                      <button
                        type="button"
                        aria-label={`Comment on current line ${reviewLine}`}
                        title="Comment on this pull-request line"
                        onClick={() => onSelectReviewLine(reviewLine)}
                        className={cn(
                          "group grid w-full cursor-pointer grid-cols-[42px_42px_minmax(0,1fr)] bg-addition/[.085] text-left transition hover:bg-addition/[.13] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan",
                          selectedLine === reviewLine && "bg-violet/[.055]",
                          keyboardLine === reviewLine &&
                            "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
                        )}
                      >
                        <span className="px-2 text-right text-addition select-none">
                          {currentLineNumber}
                        </span>
                        <span className="flex items-center justify-center gap-1 border-x border-line/60 px-2 text-addition transition select-none group-hover:text-violet">
                          <MessageSquareText
                            className={cn(
                              "size-3 transition-opacity",
                              selectedLine === reviewLine ||
                                keyboardLine === reviewLine
                                ? "text-cyan opacity-100"
                                : "opacity-0 group-hover:opacity-100",
                            )}
                          />
                          +
                        </span>
                        <span className="syntax-code min-w-0 overflow-visible px-3 whitespace-pre-wrap break-words text-cloud/80">
                          <HighlightedDiffTokens line={currentLine} />
                        </span>
                      </button>
                    ) : (
                      <div className="grid grid-cols-[42px_42px_minmax(0,1fr)] bg-addition/[.085]">
                        <span className="px-2 text-right text-addition select-none">
                          {currentLineNumber}
                        </span>
                        <span className="border-x border-line/60 px-2 text-center text-addition select-none">
                          +
                        </span>
                        <span className="syntax-code min-w-0 overflow-visible px-3 whitespace-pre-wrap break-words text-cloud/80">
                          <HighlightedDiffTokens line={currentLine} />
                        </span>
                      </div>
                    ))}
                </>
              )}
            </div>
            {rendersLineDetails && renderLineDetails?.(reviewLine)}
            {endsScope && <ReviewScopeMarker edge="end" line={scopeEndLine} />}
          </Fragment>
        );
      })}
      {visibleRowEnd < rows.length || trailingCollapsedRemaining > 0 ? (
        <DiffEdgeRevealButton
          direction={1}
          collapsedRemaining={trailingCollapsedRemaining}
          externalRemaining={Math.max(0, rows.length - visibleRowEnd)}
          onReveal={() => {
            revealEdge(1);
          }}
        />
      ) : null}
    </section>
  );
});

/** Displays a normalized error when an AI job cannot be started. */
export function showAiStartError(error: { message: string }) {
  if (error.message !== "Configure an AI provider first") {
    toast.error(error.message);
    return;
  }

  toast.error(error.message, {
    description: (
      <Link
        href="/settings/ai"
        className="text-lime hover:text-cloud mt-1 inline-flex items-center gap-2 font-medium underline underline-offset-4"
      >
        Set up provider
        <ShortcutHint shortcut={reviewShortcuts.aiSettings} />
      </Link>
    ),
    duration: 15_000,
  });
}

/** Renders the review path unit interface. */
export function ReviewPathUnit({
  entry,
  active,
  onSelect,
}: {
  entry: IndexedReviewUnit<ReviewUnit>;
  active: boolean;
  onSelect: (index: number) => void;
}) {
  const { unit, index } = entry;
  const fileName = unit.path.split("/").at(-1) ?? unit.path;
  const statusLabel =
    unit.status === "signed_off"
      ? "reviewed"
      : unit.status === "waiting"
        ? "waiting for response"
        : "not reviewed";

  return (
    <button
      type="button"
      aria-current={active ? "step" : undefined}
      aria-label={`${unit.name}, ${statusLabel}, dependency depth ${unit.depth}`}
      title={unit.path}
      onClick={() => onSelect(index)}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition",
        active ? "bg-surface-hover" : "hover:bg-surface-subtle",
      )}
      style={{ paddingLeft: `${12 + Math.min(unit.depth, 4) * 5}px` }}
    >
      <span
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-full",
          unit.status === "signed_off"
            ? "bg-lime text-accent-foreground"
            : unit.status === "waiting"
              ? "border border-cyan/35 bg-cyan/10 text-cyan"
              : active
                ? "bg-cyan/15 text-cyan"
                : unit.status === "changed"
                  ? "border border-amber-500/45 bg-amber-400/10"
                  : "border border-line-strong",
        )}
      >
        {unit.status === "signed_off" && (
          <Check className="size-2.5" strokeWidth={3} />
        )}
        {unit.status === "waiting" && <Clock3 className="size-2.5" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-mono text-[11px]">
          {unit.name}
        </span>
        <span className="text-fog mt-0.5 block truncate text-[9px] capitalize">
          {fileName} · {unit.kind} · depth {unit.depth}
        </span>
      </span>
    </button>
  );
}

/** Returns the display name for a connected code provider. */
export function providerLabel(
  provider: WorkspaceData["pullRequest"]["provider"],
) {
  if (provider === "azure_devops") return "Azure DevOps";
  if (provider === "gitlab") return "GitLab";
  return "GitHub";
}

/** Formats a provider comment timestamp for the review conversation. */
function conversationTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** Renders the provider conversation interface. */
export function ProviderConversation({
  className,
  onReply,
  provider,
  replying,
  thread,
  publishedByReviewDuck,
}: {
  className?: string;
  onReply: (body: string) => Promise<unknown>;
  provider: WorkspaceData["pullRequest"]["provider"];
  replying: boolean;
  thread: ProviderConversationThread;
  publishedByReviewDuck: boolean;
}) {
  const [expanded, setExpanded] = useState(thread.status !== "resolved");
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const replyInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (replyOpen) replyInputRef.current?.focus();
  }, [replyOpen]);

  useEffect(() => {
    setExpanded(thread.status !== "resolved");
    setReplyOpen(false);
  }, [thread.status]);

  /** Publishes the draft while preserving it if the provider rejects the reply. */
  async function submitReply() {
    const body = replyBody.trim();
    if (!body || replying) return;
    try {
      await onReply(body);
      setReplyBody("");
      setReplyOpen(false);
    } catch {
      // The mutation owns the user-facing error; retain the draft for retry.
    }
  }

  return (
    <article
      className={cn(
        "border-cyan/20 bg-panel mx-4 my-2 ml-[71px] overflow-hidden rounded-xl border font-sans shadow-lg",
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
        {thread.webUrl && (
          <a
            href={thread.webUrl}
            target="_blank"
            rel="noreferrer"
            className="text-mist hover:text-cloud flex shrink-0 items-center gap-1 text-[9px] transition"
          >
            Open on {providerLabel(provider)}
            <ExternalLink className="size-3" />
          </a>
        )}
      </header>
      {expanded && (
        <>
          <div className="divide-y divide-line">
            {thread.comments.map((comment, index) => (
              <div
                key={comment.externalId}
                className={cn(
                  "px-4 py-4 sm:px-5",
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
                    <span className="text-cyan ml-auto text-[8px] font-semibold tracking-wider uppercase">
                      Reply
                    </span>
                  )}
                </div>
                <ProviderCommentBody body={comment.body} />
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
    </article>
  );
}

/** Groups provider conversations while surfacing unresolved work by default. */
export function ProviderConversationHistory({
  children,
  threads,
}: {
  children: ReactNode;
  threads: ProviderConversationThread[];
}) {
  const hasUnresolved = threads.some((thread) => thread.status !== "resolved");
  const [expanded, setExpanded] = useState(hasUnresolved);

  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="group mt-3 rounded-xl border border-line bg-surface/30 font-sans"
    >
      <summary className="text-mist hover:bg-surface-hover flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2.5 text-[10px] font-medium transition [&::-webkit-details-marker]:hidden">
        <MessageSquareText className="text-cyan size-3.5" />
        <span className="flex-1">Conversation history</span>
        <Badge>{threads.length}</Badge>
        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-line p-3">{children}</div>
    </details>
  );
}
/** Checks whether syntax highlighting supports a language identifier. */
export function supportedLanguage(language: string) {
  if (supportedLanguages.includes(language as SupportedLanguage))
    return language as SupportedLanguage;
  throw new Error(`Unsupported review language: ${language}`);
}

/** Renders the explanation loader interface. */
export function ExplanationLoader({ unitKind }: { unitKind: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="border-violet/20 bg-violet/[.045] relative mt-4 overflow-hidden rounded-xl border p-4"
    >
      <div
        aria-hidden="true"
        className="bg-violet/10 absolute inset-x-0 top-0 h-px animate-pulse"
      />
      <div className="flex items-start gap-3">
        <span className="bg-violet/10 grid size-8 shrink-0 place-items-center rounded-full">
          <LoaderCircle className="text-violet size-4 animate-spin" />
        </span>
        <div className="min-w-0">
          <p className="text-cloud text-xs font-medium">
            Analyzing this {unitKind}
          </p>
          <p className="text-mist mt-1 text-[10px] leading-4">
            Reading its logic and dependencies to prepare a focused explanation.
          </p>
        </div>
      </div>
      <div aria-hidden="true" className="mt-4 space-y-2">
        <div className="bg-violet/10 h-1.5 w-full animate-pulse rounded-full" />
        <div className="bg-violet/10 h-1.5 w-[86%] animate-pulse rounded-full [animation-delay:120ms]" />
        <div className="bg-violet/10 h-1.5 w-[62%] animate-pulse rounded-full [animation-delay:240ms]" />
      </div>
    </div>
  );
}

/** Renders file imports as relevance-aware context for the active unit. */
export function UnitImportContext({
  fileSource,
  previousFileSource,
  unitSource,
  language,
  unitId,
  visibleStartLine,
  visibleEndLine,
  previousVisibleStartLine,
  previousVisibleEndLine,
  resolvingImport,
  onFollow,
}: {
  fileSource: string;
  previousFileSource?: string;
  unitSource: string;
  language: string;
  unitId: string;
  visibleStartLine: number;
  visibleEndLine: number;
  previousVisibleStartLine?: number;
  previousVisibleEndLine?: number;
  resolvingImport?: string;
  onFollow: (reference: ImportReference) => void;
}) {
  const currentStatements = useImportStatements(fileSource, language);
  const previousStatements = useImportStatements(
    previousFileSource ?? "",
    language,
  );
  const pairs = useMemo(() => {
    const previousStart = previousVisibleStartLine ?? visibleStartLine;
    const previousEnd = previousVisibleEndLine ?? visibleEndLine;
    return pairImportStatements(previousStatements, currentStatements).filter(
      (pair) => {
        if (pair.kind === "deleted") {
          return (
            pair.previous.endLine < previousStart ||
            pair.previous.startLine > previousEnd
          );
        }
        return (
          pair.current.endLine < visibleStartLine ||
          pair.current.startLine > visibleEndLine
        );
      },
    );
  }, [
    currentStatements,
    previousStatements,
    previousVisibleEndLine,
    previousVisibleStartLine,
    visibleEndLine,
    visibleStartLine,
  ]);
  const usedReferences = useMemo(
    () =>
      new Set(
        currentStatements
          .flatMap(({ references }) => references)
          .filter((reference) => importReferenceIsUsed(reference, unitSource))
          .map((reference) => `${reference.from}:${reference.to}`),
      ),
    [currentStatements, unitSource],
  );
  if (pairs.length === 0) return null;

  return (
    <section aria-label="Imports for this unit" className="mb-3">
      {pairs.map((pair) => (
        <ImportContextPair
          key={importPairKey(pair)}
          pair={pair}
          language={language}
          unitId={unitId}
          usedReferences={usedReferences}
          resolvingImport={resolvingImport}
          onFollow={onFollow}
        />
      ))}
    </section>
  );
}

/** Stable React key for one paired import context entry. */
function importPairKey(pair: PairedImportStatement) {
  if (pair.kind === "deleted") {
    return `deleted:${pair.previous.from}:${pair.previous.to}`;
  }
  return `${pair.kind}:${pair.current.from}:${pair.current.to}`;
}

/** Renders one import statement, including before/after lines for rewrites. */
function ImportContextPair({
  pair,
  language,
  unitId,
  usedReferences,
  resolvingImport,
  onFollow,
}: {
  pair: PairedImportStatement;
  language: string;
  unitId: string;
  usedReferences: ReadonlySet<string>;
  resolvingImport?: string;
  onFollow: (reference: ImportReference) => void;
}) {
  if (pair.kind === "deleted") {
    return (
      <ImportContextStatement
        statement={pair.previous}
        language={language}
        unitId={unitId}
        tone="deleted"
        usedReferences={usedReferences}
        interactive={false}
        resolvingImport={resolvingImport}
        onFollow={onFollow}
      />
    );
  }
  return (
    <>
      {pair.previous && pair.kind === "modified" && (
        <ImportContextStatement
          statement={pair.previous}
          language={language}
          unitId={unitId}
          tone="deleted"
          usedReferences={usedReferences}
          interactive={false}
          resolvingImport={resolvingImport}
          onFollow={onFollow}
        />
      )}
      <ImportContextStatement
        statement={pair.current}
        language={language}
        unitId={unitId}
        tone={pair.kind === "unchanged" ? "context" : "added"}
        usedReferences={usedReferences}
        interactive
        resolvingImport={resolvingImport}
        onFollow={onFollow}
      />
    </>
  );
}

/** Renders a single import statement line block with optional change styling. */
function ImportContextStatement({
  statement,
  language,
  unitId,
  tone,
  usedReferences,
  interactive,
  resolvingImport,
  onFollow,
}: {
  statement: ImportStatement;
  language: string;
  unitId: string;
  tone: "context" | "added" | "deleted";
  usedReferences: ReadonlySet<string>;
  interactive: boolean;
  resolvingImport?: string;
  onFollow: (reference: ImportReference) => void;
}) {
  const highlightedLines = useHighlightedSource(statement.source, language);
  return (
    <>
      {highlightedLines.map((line, lineIndex) => {
        const lineNumber = statement.startLine + lineIndex;
        return (
          <div
            key={`${statement.from}-${tone}-${lineIndex}`}
            className={cn(
              "group grid grid-cols-[55px_1fr] border-l-2 px-4",
              tone === "added" &&
                "border-l-addition/45 bg-addition/[.075] hover:bg-addition/[.105]",
              tone === "deleted" &&
                "border-l-red-400/45 bg-red-400/[.07] hover:bg-red-400/[.1]",
              tone === "context" &&
                "border-transparent bg-surface-subtle/15 hover:bg-surface-subtle",
            )}
          >
            <span
              className={cn(
                "flex items-center justify-end pr-3 text-right opacity-55 select-none group-hover:opacity-80",
                tone === "added" && "text-addition opacity-80",
                tone === "deleted" &&
                  "text-red-700 opacity-80 dark:text-red-200",
                tone === "context" && "text-fog",
              )}
            >
              {lineNumber}
            </span>
            <pre
              className={cn(
                "syntax-code overflow-visible text-cloud/80",
                tone === "deleted" && "line-through opacity-80",
              )}
            >
              {line.tokens.length
                ? line.tokens.map((token, tokenIndex) => {
                    const reference = statement.references.find(
                      (candidate) =>
                        candidate.from - statement.from >= token.from &&
                        candidate.to - statement.from <= token.to,
                    );
                    if (!interactive || !reference) {
                      return (
                        <span
                          key={`${tokenIndex}-${token.text.length}`}
                          className={cn(
                            token.className,
                            tone === "context" &&
                              "opacity-55 transition-opacity group-hover:opacity-80",
                          )}
                        >
                          {token.text}
                        </span>
                      );
                    }
                    const referenceKey = `${reference.from}:${reference.to}`;
                    const resolutionKey = `${unitId}:${referenceKey}`;
                    const used = usedReferences.has(referenceKey);
                    return (
                      <button
                        type="button"
                        key={`${tokenIndex}-${token.text.length}`}
                        aria-label={`Open ${reference.local} from ${reference.specifier}`}
                        title={
                          used
                            ? `Used by this unit · open ${reference.specifier}`
                            : `Not used by this unit · open ${reference.specifier}`
                        }
                        disabled={resolvingImport === resolutionKey}
                        onClick={() => onFollow(reference)}
                        className={cn(
                          "decoration-cyan/55 hover:bg-cyan/[.09] cursor-pointer rounded-sm underline decoration-dotted underline-offset-4 transition",
                          token.className,
                          used
                            ? "text-cyan opacity-100"
                            : "opacity-55 hover:opacity-80",
                          resolvingImport === resolutionKey &&
                            "animate-pulse cursor-wait",
                        )}
                      >
                        {token.text}
                      </button>
                    );
                  })
                : " "}
            </pre>
          </div>
        );
      })}
    </>
  );
}

/** Counts unique display nodes within one hierarchy branch. */
function hierarchyNodeCount(node: ReviewHierarchyNode<ReviewUnit>): number {
  return (
    1 +
    node.children.reduce((total, child) => total + hierarchyNodeCount(child), 0)
  );
}

/** Checks whether a hierarchy branch contains a review unit. */
function hierarchyContains(
  node: ReviewHierarchyNode<ReviewUnit>,
  unitId: string,
): boolean {
  return (
    node.unit.id === unitId ||
    node.children.some((child) => hierarchyContains(child, unitId))
  );
}

/** Renders dependency rows nested beneath a hierarchy concept root. */
function HierarchyDependencyRows({
  nodes,
  level,
  activeUnitId,
  onSelect,
}: {
  nodes: ReviewHierarchyNode<ReviewUnit>[];
  level: number;
  activeUnitId: string;
  onSelect: (index: number) => void;
}) {
  return nodes.map((node) => {
    const active = node.unit.id === activeUnitId;
    const fileName = node.unit.path.split("/").at(-1) ?? node.unit.path;
    return (
      <Fragment key={node.unit.id}>
        <button
          type="button"
          aria-current={active ? "step" : undefined}
          onClick={() => onSelect(node.index)}
          className={cn(
            "group relative flex w-full min-w-0 items-center gap-2.5 rounded-lg py-2 pr-2 text-left transition",
            active ? "bg-cyan/[.075]" : "hover:bg-surface-subtle",
          )}
          style={{ paddingLeft: `${12 + Math.min(level, 8) * 16}px` }}
        >
          {level > 0 && (
            <span
              aria-hidden="true"
              className="absolute top-0 bottom-0 border-l border-line"
              style={{ left: `${18 + Math.min(level - 1, 7) * 16}px` }}
            />
          )}
          <span
            className={cn(
              "z-10 size-2 shrink-0 rounded-full border",
              node.unit.status === "signed_off"
                ? "border-lime bg-lime"
                : node.unit.status === "waiting"
                  ? "border-cyan bg-cyan/25"
                  : node.unit.status === "changed"
                    ? "border-amber-400 bg-amber-400/30"
                    : "border-line-strong bg-panel",
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="text-cloud block truncate font-mono text-[10px]">
              {node.unit.name}
            </span>
            <span className="text-fog mt-0.5 block truncate text-[9px] capitalize">
              {fileName} · {node.unit.kind.replace("_", " ")} · depth{" "}
              {node.unit.depth}
            </span>
          </span>
          <ChevronRight className="text-fog size-3 shrink-0 opacity-0 transition group-hover:opacity-100" />
        </button>
        {node.children.length > 0 && (
          <HierarchyDependencyRows
            nodes={node.children}
            level={level + 1}
            activeUnitId={activeUnitId}
            onSelect={onSelect}
          />
        )}
      </Fragment>
    );
  });
}

/** Renders the compact dependency hierarchy dialog. */
export function ReviewHierarchyDialog({
  roots,
  activeUnitId,
  onSelect,
  onClose,
}: {
  roots: ReviewHierarchyNode<ReviewUnit>[];
  activeUnitId: string;
  onSelect: (index: number) => void;
  onClose: () => void;
}) {
  const activeRoot = roots.find((root) =>
    hierarchyContains(root, activeUnitId),
  );
  const [expandedRoots, setExpandedRoots] = useState(
    () => new Set(activeRoot ? [activeRoot.unit.id] : []),
  );
  useEffect(() => {
    /** Closes the hierarchy dialog from the keyboard. */
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-hierarchy-title"
      className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="bg-panel flex max-h-[82dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-4 sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="bg-cyan/10 grid size-9 shrink-0 place-items-center rounded-xl">
              <GitBranch className="text-cyan size-4" />
            </span>
            <div className="min-w-0">
              <h2
                id="review-hierarchy-title"
                className="text-cloud text-sm font-medium"
              >
                Review hierarchy
              </h2>
              <p className="text-fog mt-1 text-[10px] leading-4">
                {roots.length} coherent concepts. Prerequisites are nested below
                each concept root; review proceeds from the deepest leaf upward.
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close review hierarchy"
            onClick={onClose}
            className="text-mist hover:text-cloud grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-surface-subtle"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3 sm:p-4">
          {roots.map((root, conceptIndex) => {
            const expanded = expandedRoots.has(root.unit.id);
            const active = hierarchyContains(root, activeUnitId);
            const fileName = root.unit.path.split("/").at(-1) ?? root.unit.path;
            return (
              <section
                key={root.unit.id}
                className={cn(
                  "overflow-hidden rounded-xl border",
                  active ? "border-cyan/30 bg-cyan/[.025]" : "border-line",
                )}
              >
                <div className="flex items-center gap-1 p-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(root.index);
                      onClose();
                    }}
                    className="hover:bg-surface-subtle flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left transition"
                  >
                    <span className="text-cyan grid size-6 shrink-0 place-items-center rounded-md bg-cyan/10 font-mono text-[9px]">
                      {conceptIndex + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-cloud block truncate font-mono text-[11px]">
                        {root.unit.name}
                      </span>
                      <span className="text-fog mt-0.5 block truncate text-[9px]">
                        {fileName} · {hierarchyNodeCount(root)} units
                      </span>
                    </span>
                    {active && (
                      <Badge className="border-cyan/20 bg-cyan/[.07] text-cyan">
                        Current
                      </Badge>
                    )}
                  </button>
                  {root.children.length > 0 && (
                    <button
                      type="button"
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${root.unit.name} hierarchy`}
                      aria-expanded={expanded}
                      onClick={() =>
                        setExpandedRoots((current) => {
                          const next = new Set(current);
                          if (next.has(root.unit.id)) next.delete(root.unit.id);
                          else next.add(root.unit.id);
                          return next;
                        })
                      }
                      className="text-mist hover:text-cloud grid size-9 shrink-0 place-items-center rounded-lg transition hover:bg-surface-subtle"
                    >
                      <ChevronDown
                        className={cn(
                          "size-3.5 transition-transform",
                          !expanded && "-rotate-90",
                        )}
                      />
                    </button>
                  )}
                </div>
                {expanded && root.children.length > 0 && (
                  <div className="border-t border-line/70 px-1.5 py-1.5">
                    <HierarchyDependencyRows
                      nodes={root.children}
                      level={1}
                      activeUnitId={activeUnitId}
                      onSelect={(index) => {
                        onSelect(index);
                        onClose();
                      }}
                    />
                  </div>
                )}
              </section>
            );
          })}
        </div>
        <footer className="text-fog flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-[9px] sm:px-5">
          <span>Shared dependencies appear under their first concept.</span>
          <span className="shrink-0">Esc closes</span>
        </footer>
      </div>
    </div>
  );
}
