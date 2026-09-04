"use client";

import {
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileCode2,
  MessageSquareText,
  PanelLeftOpen,
  PanelRightOpen,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Undo2,
} from "lucide-react";
import type { CommandCenterItem } from "~/components/command-center";
import { providerLabel } from "~/lib/provider-labels";
import type { ReviewMode } from "~/lib/review-files";
import { reviewShortcuts } from "~/lib/review-shortcuts";
import type { RouterOutputs } from "~/trpc/react";

type WorkspaceData = RouterOutputs["review"]["workspace"];
type ReviewUnit = WorkspaceData["units"][number];

const unitCommandIcon = <FileCode2 className="size-4" />;

interface CommandMutationState {
  isPending: boolean;
}

export interface ReviewCommandState {
  activeConceptCardIndex: number;
  activeConceptFileCards: readonly unknown[];
  activeConceptMembers: readonly unknown[];
  activeConceptPathIndex: number;
  activeSignOffPending: boolean;
  activeUnit?: ReviewUnit;
  activeUnitAnswered: boolean;
  aiConfiguration: { data?: { mode?: string } };
  aiQuestionLine?: number;
  availableAfter: number;
  availableBefore: number;
  canAwaitUnit: boolean;
  canSignOffConcept: boolean;
  canSignOffDeletedFiles: boolean;
  canStopWaiting: boolean;
  canUndoSignOff: boolean;
  canUsePrimaryAction: boolean;
  cardActionAvailable: boolean;
  contextAfter: number;
  contextAvailable: boolean;
  contextBefore: number;
  contextRevealed: boolean;
  deepReviewAvailable: boolean;
  deletedUnitsToSignOff: readonly unknown[];
  externalSyncPending: boolean;
  fileWaitingUnitIds: readonly string[];
  filteredReviewActive: boolean;
  initialData: Pick<WorkspaceData, "concepts" | "pullRequest">;
  nextQueueEntry?: { index: number; unit: { name: string } };
  nextReview?: {
    number: number;
    repositoryName: string;
    repositoryOwner: string;
  };
  outstandingCardMembers: readonly unknown[];
  pendingConceptSignOffIds: ReadonlySet<string>;
  pendingUndoCount: number;
  primaryIsContinue: boolean;
  primaryScopeLabel: string;
  resetReview: CommandMutationState;
  reviewCaughtUp: boolean;
  reviewComplete: boolean;
  reviewMode: ReviewMode;
  reviewRunning: boolean;
  sideBySideVisible: boolean;
  signOffQueue: { ids: ReadonlySet<string> };
  undoSignOff: CommandMutationState;
  undoableSignOff?: { entry: { label: string } };
  updateAvailable: boolean;
  visibleFindings: readonly unknown[];
  waitingCount: number;
}

export interface ReviewCommandActions {
  awaitActiveUnit: () => void;
  beginKeyboardComment: () => void;
  focusReviewSearch: () => void;
  loadAvailableChanges: () => void;
  navigate: (href: string) => void;
  navigateConcept: (direction: -1 | 1) => void;
  navigateConceptCard: (direction: -1 | 1) => void;
  openAiQuestion: () => void;
  openCentredInlineComment: () => void;
  openNextReview: () => void;
  openPullRequests: () => void;
  revealContextAbove: () => void;
  revealContextBelow: () => void;
  runPrimaryAction: () => void;
  scrollCode: (direction: -1 | 1) => void;
  selectConceptPath: (index: number) => void;
  setAiReviewDialogOpen: (open: boolean) => void;
  setResetDialogOpen: (open: boolean) => void;
  setWaitingCompletionOpen: (open: boolean) => void;
  signOffActiveConcept: () => void;
  signOffDeletedFiles: () => void;
  stepAiQuestion: (direction: -1 | 1) => void;
  stepFinding: (direction: -1 | 1) => void;
  stopWaitingOnActive: () => void;
  syncExternalData: () => Promise<void>;
  toggleContext: () => void;
  toggleInsightsPanel: () => void;
  togglePathPanel: () => void;
  undoLastSignOff: () => Promise<void>;
  unreviewActiveUnit: () => void;
}

/** Builds search-only commands for every review unit. */
export function buildReviewUnitCommands(
  units: readonly ReviewUnit[],
  activeIndex: number,
  selectUnit: (index: number) => void,
) {
  return units.map(
    (unit, index): CommandCenterItem => ({
      id: `unit-${unit.id}`,
      label: `Open ${unit.name}`,
      description: `${unit.path} · ${unit.kind.replace("_", " ")} · ${unit.status.replace("_", " ")}`,
      group: "Review units",
      keywords: [unit.path, unit.kind, unit.status, String(index + 1)],
      icon: unitCommandIcon,
      disabled: index === activeIndex,
      searchOnly: true,
      onSelect: () => selectUnit(index),
    }),
  );
}

/** Builds the command registry from a typed snapshot of workspace state. */
export function buildReviewWorkspaceCommands(
  state: ReviewCommandState,
  actions: ReviewCommandActions,
  unitCommands: CommandCenterItem[],
) {
  const {
    activeConceptCardIndex,
    activeConceptFileCards,
    activeConceptMembers,
    activeConceptPathIndex,
    activeSignOffPending,
    activeUnit,
    activeUnitAnswered,
    aiConfiguration,
    aiQuestionLine,
    availableAfter,
    availableBefore,
    canAwaitUnit,
    canSignOffConcept,
    canSignOffDeletedFiles,
    canStopWaiting,
    canUndoSignOff,
    canUsePrimaryAction,
    cardActionAvailable,
    contextAfter,
    contextAvailable,
    contextBefore,
    contextRevealed,
    deepReviewAvailable,
    deletedUnitsToSignOff,
    externalSyncPending,
    fileWaitingUnitIds,
    filteredReviewActive,
    initialData,
    nextQueueEntry,
    nextReview,
    outstandingCardMembers,
    pendingConceptSignOffIds,
    pendingUndoCount,
    primaryIsContinue,
    primaryScopeLabel,
    resetReview,
    reviewCaughtUp,
    reviewComplete,
    reviewMode,
    reviewRunning,
    sideBySideVisible,
    signOffQueue,
    undoSignOff,
    undoableSignOff,
    updateAvailable,
    visibleFindings,
    waitingCount,
  } = state;
  const {
    awaitActiveUnit,
    beginKeyboardComment,
    focusReviewSearch,
    loadAvailableChanges,
    navigate,
    navigateConcept,
    navigateConceptCard,
    openAiQuestion,
    openCentredInlineComment,
    openNextReview,
    openPullRequests,
    revealContextAbove,
    revealContextBelow,
    runPrimaryAction,
    scrollCode,
    selectConceptPath,
    setAiReviewDialogOpen,
    setResetDialogOpen,
    setWaitingCompletionOpen,
    signOffActiveConcept,
    signOffDeletedFiles,
    stepAiQuestion,
    stepFinding,
    stopWaitingOnActive,
    syncExternalData,
    toggleContext,
    toggleInsightsPanel,
    togglePathPanel,
    undoLastSignOff,
    unreviewActiveUnit,
  } = actions;
  const reviewPullRequestCommand: CommandCenterItem = {
    id: "review-pull-request-with-ai",
    label: "Review the full pull request",
    description:
      aiConfiguration.data?.mode === "off"
        ? "Enable AI assistance in settings first"
        : "Inspect every changed file and surface actionable findings",
    group: "Review actions",
    icon: <Sparkles className="size-4" />,
    shortcut: reviewShortcuts.reviewPullRequest,
    disabled: reviewRunning || aiConfiguration.data?.mode === "off",
    onSelect: () => setAiReviewDialogOpen(true),
  };
  const reviewCommands: CommandCenterItem[] = [
    {
      id: "toggle-review-path",
      label: "Toggle review path",
      description: "Show or hide the left review navigation panel",
      group: "Review navigation",
      icon: <PanelLeftOpen className="size-4" />,
      shortcut: reviewShortcuts.togglePathPanel,
      onSelect: togglePathPanel,
    },
    {
      id: "toggle-ai-assistance",
      label: "Toggle AI assistance",
      description: "Show or hide the right explanation and usage panel",
      group: "Review navigation",
      icon: <PanelRightOpen className="size-4" />,
      shortcut: reviewShortcuts.toggleInsightsPanel,
      onSelect: toggleInsightsPanel,
    },
    {
      id: "scroll-code-down",
      label:
        aiQuestionLine === undefined
          ? "Scroll code down"
          : "Move AI question down",
      description:
        aiQuestionLine === undefined
          ? "Move down through the code view"
          : "Focus the next visible in-scope line",
      group: "Review navigation",
      icon: <ChevronDown className="size-4" />,
      shortcut: reviewShortcuts.scrollDown,
      onSelect: () =>
        aiQuestionLine === undefined ? scrollCode(1) : stepAiQuestion(1),
    },
    {
      id: "scroll-code-up",
      label:
        aiQuestionLine === undefined ? "Scroll code up" : "Move AI question up",
      description:
        aiQuestionLine === undefined
          ? "Move up through the code view"
          : "Focus the previous visible in-scope line",
      group: "Review navigation",
      icon: <ChevronDown className="size-4 rotate-180" />,
      shortcut: reviewShortcuts.scrollUp,
      onSelect: () =>
        aiQuestionLine === undefined ? scrollCode(-1) : stepAiQuestion(-1),
    },
    {
      id: "reveal-context-below",
      label: "Show more lines below",
      description: "Reveal the source that follows the reviewed unit",
      group: "Review navigation",
      icon: <ChevronDown className="size-4" />,
      shortcut: reviewShortcuts.revealContextBelow,
      disabled:
        !sideBySideVisible &&
        (!contextAvailable || contextAfter >= availableAfter),
      onSelect: revealContextBelow,
    },
    {
      id: "reveal-context-above",
      label: "Show more lines above",
      description: "Reveal the source that precedes the reviewed unit",
      group: "Review navigation",
      icon: <ChevronDown className="size-4 rotate-180" />,
      shortcut: reviewShortcuts.revealContextAbove,
      disabled:
        !sideBySideVisible &&
        (!contextAvailable || contextBefore >= availableBefore),
      onSelect: revealContextAbove,
    },
    {
      id: "next-unit",
      label: "Select next card",
      description:
        reviewMode === "files"
          ? "Select the next changed file"
          : "Select the next file card in this concept",
      group: "Review navigation",
      icon: <ChevronDown className="size-4" />,
      shortcut: reviewShortcuts.nextUnit,
      disabled: activeConceptCardIndex >= activeConceptFileCards.length - 1,
      onSelect: () => navigateConceptCard(1),
    },
    {
      id: "previous-unit",
      label: "Select previous card",
      description:
        reviewMode === "files"
          ? "Select the previous changed file"
          : "Select the previous file card in this concept",
      group: "Review navigation",
      icon: <ChevronRight className="size-4 -rotate-90" />,
      shortcut: reviewShortcuts.previousUnit,
      disabled: activeConceptCardIndex <= 0,
      onSelect: () => navigateConceptCard(-1),
    },
    {
      id: "next-concept",
      label: "Open next concept",
      description: "Move to the next concept in the review path",
      group: "Review navigation",
      icon: <ChevronRight className="size-4" />,
      shortcut: reviewShortcuts.nextConcept,
      disabled: activeConceptPathIndex >= initialData.concepts.length - 1,
      onSelect: () => navigateConcept(1),
    },
    {
      id: "previous-concept",
      label: "Open previous concept",
      description: "Move to the previous concept in the review path",
      group: "Review navigation",
      icon: <ChevronRight className="size-4 rotate-180" />,
      shortcut: reviewShortcuts.previousConcept,
      disabled: activeConceptPathIndex <= 0,
      onSelect: () => navigateConcept(-1),
    },
    {
      id: "next-pending-unit",
      label: "Resume the review queue",
      description: nextQueueEntry
        ? `Open ${nextQueueEntry.unit.name}, the first pending unit`
        : "No other pending units",
      group: "Review navigation",
      icon: <FileCode2 className="size-4" />,
      shortcut: reviewShortcuts.nextPending,
      disabled: !nextQueueEntry,
      onSelect: () => {
        if (nextQueueEntry) selectConceptPath(nextQueueEntry.index);
      },
    },
    {
      id: "search-review-path",
      label: "Search the review path",
      description: "Find a symbol or file in this pull request",
      group: "Review navigation",
      icon: <Search className="size-4" />,
      shortcut: reviewShortcuts.search,
      onSelect: focusReviewSearch,
    },
    {
      id: "ask-ai-inline",
      label: "Ask AI about this code",
      description:
        aiConfiguration.data?.mode === "off"
          ? "Enable AI assistance in settings first"
          : "Open a line-anchored question beside the nearest in-scope code",
      group: "Review actions",
      icon: <MessageSquareText className="size-4" />,
      shortcut: reviewShortcuts.askAi,
      disabled:
        aiConfiguration.data?.mode === "off" ||
        !activeUnit ||
        activeUnit.kind === "binary",
      onSelect: openAiQuestion,
    },
    // Omitted rather than disabled when the plan cannot run a deep review:
    // `useCommandCenterBindings` reads this same array, so leaving the entry in
    // would keep its keyboard shortcut live for an account `ai.start` refuses.
    ...(deepReviewAvailable ? [reviewPullRequestCommand] : []),
    // Registered here rather than on a listener of their own so they inherit
    // the command center's editable-target and suspended guards, which already
    // cover the line picker, the import preview and the three dialogs.
    {
      id: "next-finding",
      label: "Next finding",
      description: "Open the next deep-review finding beside its code",
      group: "Review actions",
      icon: <Sparkles className="size-4" />,
      shortcut: reviewShortcuts.nextFinding,
      disabled: visibleFindings.length === 0,
      onSelect: () => stepFinding(1),
    },
    {
      id: "previous-finding",
      label: "Previous finding",
      description: "Open the previous deep-review finding beside its code",
      group: "Review actions",
      icon: <Sparkles className="size-4" />,
      shortcut: reviewShortcuts.previousFinding,
      disabled: visibleFindings.length === 0,
      onSelect: () => stepFinding(-1),
    },
    {
      id: "comment-on-line",
      label: "Comment on a line",
      description: "Choose a line with the keyboard, then write feedback",
      group: "Review actions",
      icon: <MessageSquareText className="size-4" />,
      shortcut: reviewShortcuts.comment,
      disabled: !activeUnit || activeUnit.kind === "binary",
      onSelect: beginKeyboardComment,
    },
    {
      id: "comment-here",
      label: "Comment here",
      description: `Write a ${providerLabel(initialData.pullRequest.provider)} comment on the line in the middle of the view`,
      group: "Review actions",
      icon: <MessageSquareText className="size-4" />,
      shortcut: reviewShortcuts.commentHere,
      disabled: !activeUnit || activeUnit.kind === "binary",
      onSelect: openCentredInlineComment,
    },
    {
      id: "undo-sign-off",
      label: "Undo sign-off",
      description: undoableSignOff
        ? `Return ${undoableSignOff.entry.label} to the review path`
        : "Return the most recent sign-off to the review path",
      group: "Review actions",
      icon: <Undo2 className="size-4" />,
      shortcut: reviewShortcuts.undoSignOff,
      disabled: !canUndoSignOff,
      onSelect: undoLastSignOff,
    },
    {
      id: "toggle-context",
      label: contextRevealed ? "Hide surrounding context" : "Show context",
      description: contextRevealed
        ? "Return to the focused review unit"
        : "Reveal nearby lines without expanding the review scope",
      group: "Review actions",
      icon: <FileCode2 className="size-4" />,
      shortcut: reviewShortcuts.context,
      disabled: !contextAvailable || sideBySideVisible,
      onSelect: toggleContext,
    },
    {
      id: "primary-review-action",
      // The same scope the footer advertises, because this entry carries the
      // same key: a multi-unit file card is recorded as one reading action.
      label: reviewCaughtUp
        ? `View ${waitingCount} waiting ${waitingCount === 1 ? "unit" : "units"}`
        : primaryIsContinue
          ? filteredReviewActive
            ? "Continue to next match"
            : "Continue review"
          : primaryScopeLabel,
      description: reviewCaughtUp
        ? "See what must receive a reply or code change before this review can finish"
        : primaryIsContinue
          ? filteredReviewActive
            ? "Continue through the matching review units in planned order"
            : "Open the next unit that still needs review"
          : cardActionAvailable
            ? `Remember all ${outstandingCardMembers.length} outstanding units in this file card and open the next card`
            : "Remember this unit at the current revision and open the next one",
      group: "Review actions",
      icon: reviewCaughtUp ? (
        <Clock3 className="size-4" />
      ) : (
        <Check className="size-4" />
      ),
      shortcut: reviewCaughtUp ? undefined : reviewShortcuts.signOff,
      disabled: reviewCaughtUp ? false : !canUsePrimaryAction,
      onSelect: reviewCaughtUp
        ? () => setWaitingCompletionOpen(true)
        : runPrimaryAction,
    },
    {
      id: "sign-off-concept",
      label: `Sign off concept (${activeConceptMembers.length})`,
      description: "Remember every member of this concept at once",
      group: "Review actions",
      icon: <CheckCheck className="size-4" />,
      shortcut: reviewShortcuts.signOffConcept,
      disabled: !canSignOffConcept,
      onSelect: signOffActiveConcept,
    },
    {
      id: "sign-off-deleted-files",
      label: "Sign off deletes",
      description:
        deletedUnitsToSignOff.length === 1
          ? "Sign off the remaining unit from files deleted in this pull request"
          : `Sign off ${deletedUnitsToSignOff.length} remaining units from files deleted in this pull request`,
      group: "Review actions",
      icon: <CheckCheck className="size-4" />,
      shortcut: reviewShortcuts.signOffDeletions,
      disabled: !canSignOffDeletedFiles,
      onSelect: signOffDeletedFiles,
    },
    {
      // One entry rather than two, because the binding runs the first command
      // its shortcut matches and would stop at a disabled twin. Waiting and
      // signed off never hold at once, so the state picks the wording.
      id: "unreview-unit",
      label: canStopWaiting
        ? fileWaitingUnitIds.length > 1
          ? `Resume waiting (${fileWaitingUnitIds.length})`
          : activeUnitAnswered
            ? "Resume review"
            : "Stop waiting"
        : "Undo review",
      description: canStopWaiting
        ? fileWaitingUnitIds.length > 1
          ? "Take back the waits in this file and return them to the review path"
          : "Take back the wait and return this work to your review path"
        : "Return this unit to the review queue",
      group: "Review actions",
      icon: canStopWaiting ? (
        <Clock3 className="size-4" />
      ) : (
        <Undo2 className="size-4" />
      ),
      shortcut: reviewShortcuts.undoReview,
      disabled: canStopWaiting
        ? false
        : activeUnit?.status !== "signed_off" ||
          activeSignOffPending ||
          undoSignOff.isPending,
      onSelect: canStopWaiting ? stopWaitingOnActive : unreviewActiveUnit,
    },
    {
      id: "await-response",
      label: "Await unit",
      description: "Pause this unit until its code or conversation changes",
      group: "Review actions",
      icon: <Clock3 className="size-4" />,
      shortcut: reviewShortcuts.awaitResponse,
      disabled: !canAwaitUnit,
      onSelect: awaitActiveUnit,
    },

    {
      id: "sync-provider-data",
      label: updateAvailable ? "Load code changes" : "Sync",
      description: updateAvailable
        ? "Load the synced revision and preserve unaffected sign-offs"
        : "Poll for the latest code and conversations",
      group: "Review actions",
      icon: <RefreshCw className="size-4" />,
      shortcut: updateAvailable
        ? reviewShortcuts.loadChanges
        : reviewShortcuts.refresh,
      disabled:
        resetReview.isPending || (!updateAvailable && externalSyncPending),
      onSelect: updateAvailable
        ? loadAvailableChanges
        : () => void syncExternalData(),
    },
    {
      id: "reset-review",
      label: "Reset review",
      description: "Sync the latest code and clear all of your sign-offs",
      group: "Review actions",
      icon: <RotateCcw className="size-4" />,
      shortcut: reviewShortcuts.reset,
      disabled:
        signOffQueue.ids.size > 0 ||
        pendingConceptSignOffIds.size > 0 ||
        pendingUndoCount > 0 ||
        externalSyncPending ||
        resetReview.isPending,
      onSelect: () => setResetDialogOpen(true),
    },
    {
      id: "next-pull-request",
      label: "Review the next pull request",
      description: nextReview
        ? `Continue with ${nextReview.repositoryOwner}/${nextReview.repositoryName} #${nextReview.number}`
        : "No other prepared pull request is waiting for review",
      group: "Navigate",
      icon: <ChevronRight className="size-4" />,
      shortcut: reviewShortcuts.nextReview,
      // The caught-up end state offers the same jump: everything reviewable is
      // done even though waiting units keep the review itself unfinished.
      disabled: (!reviewComplete && !reviewCaughtUp) || !nextReview,
      onSelect: openNextReview,
    },
    {
      id: "return-pull-requests",
      label: "Return to pull requests",
      group: "Navigate",
      icon: <ArrowLeft className="size-4" />,
      shortcut: reviewShortcuts.dashboard,
      onSelect: openPullRequests,
    },
    {
      id: "configure-ai",
      label: "Configure AI provider",
      description: "Manage assistance, providers, and model options",
      group: "Navigate",
      icon: <Sparkles className="size-4" />,
      shortcut: reviewShortcuts.aiSettings,
      onSelect: () => navigate("/settings/ai"),
    },
    ...unitCommands,
  ];
  return reviewCommands;
}
