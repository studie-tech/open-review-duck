"use client";

import {
  ArrowLeft,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  CornerUpLeft,
  ExternalLink,
  FileCode2,
  FolderInput,
  GitBranch,
  Info,
  Keyboard,
  LoaderCircle,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type CSSProperties,
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";
import {
  CommandCenter,
  type CommandCenterMode,
  ShortcutAlternatives,
  ShortcutHint,
  ShortcutSequenceIndicator,
  useCommandCenterBindings,
} from "~/components/command-center";
import { usePendingNavigation } from "~/components/navigation-progress";
import { ContextRevealControl } from "~/components/review/context-reveal-control";
import { ThemeToggle } from "~/components/theme-toggle";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import {
  LinkNavigationStatus,
  LinkPendingSpinner,
} from "~/components/ui/link-status";
import { aiErrorPresentation } from "~/lib/ai-errors";
import { lockDocumentScroll } from "~/lib/document-scroll-lock";
import {
  findImportedDeclarationLine,
  findImportTargetUnit,
  type ImportReference,
} from "~/lib/import-navigation";
import { commandMenuShortcut } from "~/lib/keyboard-shortcuts";
import { providerLabel } from "~/lib/provider-labels";
import { followPendingProviderLifecycle } from "~/lib/provider-lifecycle";
import {
  FILES_VIEWER_PAGE_SIZE,
  FILES_VIEWER_PREFETCH_RADIUS,
  FILES_VIEWER_PREVIEW_RADIUS,
  nearbyReviewFilePaths,
  nextOutstandingReviewFile,
  outstandingReviewFileUnits,
  type ReviewFileEntry,
  type ReviewMode,
  rememberReviewMode,
  reviewFileCardsInTreeOrder,
  reviewFileEntries,
  storedReviewMode,
  waitingReviewFileUnits,
  windowReviewFileCards,
} from "~/lib/review-files";
import {
  buildReviewHierarchy,
  deepReviewFindingTarget,
  deletedFileSignOffUnits,
  nextPendingReviewIndex,
  nextPendingReviewIndexPreferring,
  optimisticallySignOffReviewUnits,
  optimisticallyUnreviewReviewUnits,
  resetSignedOffReviewUnits,
  restoreReviewUnitAfterFailedSignOff,
  reviewAvailability,
  reviewPathSearchMatches,
  reviewPathSections,
} from "~/lib/review-navigation";
import { reviewFoundationPriority } from "~/lib/review-priority";
import {
  acknowledgedReviewRevision,
  acknowledgeReviewRevision,
  type ReviewRevision,
  rememberedReviewPosition,
  rememberReviewPosition,
  shortRevision,
} from "~/lib/review-revision";
import { reviewShortcuts } from "~/lib/review-shortcuts";
import {
  isHeavyReviewSource,
  reviewFileCardStartsExpanded,
  reviewSourceByteLength,
  reviewSourceLineCount,
} from "~/lib/review-source-display";
import {
  currentChangedLineIndexes,
  sideBySideDiff,
  sourceByteOffsetLine,
  sourceEndLine,
  sourceStartLine,
} from "~/lib/side-by-side-diff";
import {
  createSignOffQueue,
  nextSignOffBatchSize,
  reviewFooterSaveState,
  signOffQueueReducer,
} from "~/lib/sign-off-queue";
import {
  nextUndoableSignOff,
  type ReviewViewSnapshot,
  rememberSignOff,
  type SignOffUndoEntry,
  signOffUndoTarget,
} from "~/lib/sign-off-undo";
import { isPeekableToken, symbolPeekAttributes } from "~/lib/symbol-peek";
import {
  preloadSyntaxLanguage,
  useHighlightedSource,
} from "~/lib/syntax-highlighting";
import { formatTokenCount } from "~/lib/token-usage";
import { useImportReferences } from "~/lib/tree-sitter-import-navigation";
import { useSettledValue } from "~/lib/use-settled-value";
import { cn } from "~/lib/utils";
import { api, type RouterInputs, type RouterOutputs } from "~/trpc/react";
import {
  DeepReviewFindingChip,
  DeepReviewFindingRow,
  DeepReviewInlineFinding,
  deepReviewFacetCounts,
  deepReviewItemStateCopy,
  deepReviewTerminalCopy,
  findingCategories,
  findingSeverities,
  findingSeverityChipLabel,
  findingSeverityStyle,
  reviewFailureClassCopy,
} from "./deep-review-findings";
import { HighlightedTokens } from "./highlighted-tokens";
import { ProviderLifecycle } from "./provider-lifecycle";
import { ProviderReviewDecision } from "./provider-review-decision";
import { findNextReview, ReviewCompletion } from "./review-completion";
import {
  isOpenProviderDiscussion,
  type ProviderDiscussionThread,
  ReviewDiscussionSummary,
  ReviewDiscussionsPanel,
} from "./review-discussions";
import {
  actionableReviewCardMember,
  ReviewFileCardHeader,
  ReviewFileUnitMarker,
  relatedReviewRanges,
  reviewCardRanges,
  reviewedFileCard,
  reviewUnitStartsCollapsed,
} from "./review-file-card";
import { ReviewFilesPanel } from "./review-files-panel";
import { ReviewBinaryPreview } from "./review-image-preview";
import { ReviewModeSwitch } from "./review-mode-switch";
import {
  REVIEW_INSIGHTS_PANEL_WIDTHS,
  REVIEW_PATH_PANEL_WIDTHS,
  ReviewPanelResizeHandle,
} from "./review-panel-resize-handle";
import {
  overviewMarksFromDiffRows,
  overviewRangeFromDiffRows,
  ReviewScrollOverviewStrip,
  useReviewCodeOverview,
} from "./review-scroll-overview";
import {
  initialReviewSessionState,
  reviewSessionReducer,
} from "./review-session-machine";
import { ReviewWaitingCompletion } from "./review-waiting-completion";
import {
  aiConversationVisibility,
  InlineAiQuestion,
  InlineCommentComposer,
  rememberAiConversationVisibility,
  withoutDeletedAiQuestions,
} from "./review-workspace-ai-conversation";
import {
  buildReviewUnitCommands,
  buildReviewWorkspaceCommands,
} from "./review-workspace-commands";
import {
  CONTEXT_PAGE_LINES,
  INITIAL_PATH_ITEMS,
  PATH_PAGE_SIZE,
  PROVIDER_CONVERSATION_REFRESH_MS,
} from "./review-workspace-constants";
import {
  ConceptMoveDialog,
  ExplanationLoader,
  knownLanguage,
  PullRequestDetailsDialog,
  ReviewHierarchyDialog,
  supportedLanguage,
  UnitImportContext,
} from "./review-workspace-dialogs";
import {
  AskAiLineButton,
  ReviewPathUnit,
  ReviewScopeMarker,
  SideBySideUnitDiff,
  type SideBySideUnitDiffHandle,
  showAiStartError,
} from "./review-workspace-diff";
import {
  aiJobActive,
  reviewCardPinTarget,
  useReviewExitPrefetch,
  useReviewFileAdvance,
  useTerminalReviewRefetch,
} from "./review-workspace-hooks";
import { ProviderCommentBody } from "./review-workspace-markdown";
import {
  CopyRepositoryUrlButton,
  ProviderConversation,
  providerConversationElementId,
  reviewProviderWebUrl,
} from "./review-workspace-provider-conversation";
import {
  conceptFileCardsInReadingOrder,
  conceptMembersInReadingOrder,
  lineWithinReviewRanges,
  nextAnchorableLine,
  ReviewCodeViewSwitch,
  ReviewConceptFileCardPreview,
  ReviewFileCardSourcePlaceholder,
  ReviewRevisionLoadedNotice,
  ReviewUnitViewOptions,
  reviewCardMemberForLine,
  SplitActionButton,
} from "./review-workspace-source";
import { liveConceptStatus } from "./review-workspace-stream";
import {
  SourceLineWindow,
  WORKSPACE_SOURCE_ROW_HEIGHT_PX,
} from "./source-line-window";
import {
  SymbolPeekCard,
  SymbolPeekMessage,
  symbolPeekNotice,
  useSymbolPeek,
} from "./symbol-peek";
import { useAiQuestionStreamController } from "./use-ai-question-stream-controller";
import { useDeepReviewFindingController } from "./use-deep-review-finding-controller";
import {
  closestReviewLine,
  useInlineAiQuestionController,
} from "./use-inline-ai-question-controller";
import { usePrivateWorkspaceSourceHydration } from "./use-private-workspace-source-hydration";
import { useProviderConversationController } from "./use-provider-conversation-controller";
import { useReviewDialogController } from "./use-review-dialog-controller";
import { useReviewPanelController } from "./use-review-panel-controller";
import { useReviewSynchronizationController } from "./use-review-synchronization-controller";
import { useReviewWaitController } from "./use-review-wait-controller";

type WorkspaceData = RouterOutputs["review"]["workspace"];
type ReviewUnit = WorkspaceData["units"][number];
type ReviewConcept = WorkspaceData["concepts"][number];
type ImportTarget = RouterOutputs["review"]["importTarget"];
type ImportPreview = Extract<ImportTarget, { kind: "preview" }>;
type SignOffInput = RouterInputs["review"]["signOff"];
type DeepReviewRun = NonNullable<RouterOutputs["review"]["deepReviewFindings"]>;
type DeepReviewFinding = DeepReviewRun["findings"][number];

interface SignOffRollback {
  contextAfter: number;
  contextBefore: number;
  pathSearch: string;
  scrollTop: number;
  searchLimit: number;
  showDiff: boolean;
  unit: ReviewUnit;
  unitIndex: number;
}

interface QueuedSignOff {
  input: SignOffInput;
  rollback: SignOffRollback;
}

/** Matches the `h-5` spacer above the selected card so its header is never flush. */
const SELECTED_REVIEW_CARD_GUTTER_PX = 20;

// The per-line indexes below are read once for every rendered line of a unit,
// so the misses share one bucket rather than allocating an empty one each.
const NO_GROUPED_ENTRIES: never[] = [];
const NO_QUESTION_GROUPS = new Map<string, never>();

/** Reads one bucket out of a grouped index. */
function groupedEntries<Key, Entry>(
  index: Map<Key, Entry[]>,
  key: Key,
): Entry[] {
  return index.get(key) ?? NO_GROUPED_ENTRIES;
}

/** Reads one line's AI conversations, grouped by the thread they belong to. */
function questionGroupsAt<Entry>(
  index: Map<number, Map<string, Entry>>,
  line: number,
): Map<string, Entry> {
  return index.get(line) ?? NO_QUESTION_GROUPS;
}

/** Renders the review workspace interface. */
export function ReviewWorkspace({
  initialData,
}: {
  initialData: WorkspaceData;
}) {
  const router = useRouter();
  const { navigate, pending: navigationPending } = usePendingNavigation();
  const [layoutRefreshing, startLayoutRefresh] = useTransition();
  const [reviewSession, sendReviewSession] = useReducer(
    reviewSessionReducer,
    initialReviewSessionState,
  );
  useLayoutEffect(() => lockDocumentScroll(document), []);
  // The workspace opens on work the reviewer can act on. A wait is a
  // property of one unit, so a pending sibling remains a valid first landing.
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(
      0,
      initialData.units.findIndex(
        (unit) => unit.status !== "signed_off" && unit.status !== "waiting",
      ),
    ),
  );
  const [sourcePinRequest, setSourcePinRequest] = useState<{
    kind: "file" | "unit";
    unitId: string;
  }>();
  const {
    fileContexts,
    hydratedUnitIds,
    settledUnitIds,
    setUnits,
    sourceHydrationPending,
    units,
  } = usePrivateWorkspaceSourceHydration(initialData, activeIndex);
  const unitsRef = useRef(units);
  unitsRef.current = units;
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [reviewMode, setReviewMode] = useState<ReviewMode>("files");
  const [filesViewerAbove, setFilesViewerAbove] = useState(
    FILES_VIEWER_PAGE_SIZE,
  );
  const [filesViewerBelow, setFilesViewerBelow] = useState(
    FILES_VIEWER_PAGE_SIZE,
  );
  const [fileSourceReveal, setFileSourceReveal] = useState<{
    expanded: boolean;
    path: string;
    reviewed: boolean;
  }>();
  const [completedBrowsing, setCompletedBrowsing] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const unreviewRollbacks = useRef(new Map<string, ReviewUnit[]>());
  const [showDiff, setShowDiff] = useState(true);
  const [importContextUnitIds, setImportContextUnitIds] = useState(
    () => new Set<string>(),
  );
  const [fullFileUnitIds, setFullFileUnitIds] = useState(
    () => new Set<string>(),
  );
  const [unitFoldOverrides, setUnitFoldOverrides] = useState(
    () => new Map<string, boolean>(),
  );
  const [pathSearch, setPathSearch] = useState("");
  const [queueLimit, setQueueLimit] = useState(INITIAL_PATH_ITEMS);
  const [searchLimit, setSearchLimit] = useState(INITIAL_PATH_ITEMS);
  const [reviewedLimit, setReviewedLimit] = useState(INITIAL_PATH_ITEMS);
  const [reviewedExpanded, setReviewedExpanded] = useState(false);
  const [waitingLimit, setWaitingLimit] = useState(INITIAL_PATH_ITEMS);
  const [waitingExpanded, setWaitingExpanded] = useState(true);
  const {
    hideInsightsPanel,
    hidePathPanel,
    insightsPanelCollapsed,
    insightsPanelOpen,
    insightsPanelWidth,
    pathPanelCollapsed,
    pathPanelOpen,
    pathPanelWidth,
    setInsightsPanelCollapsed,
    setInsightsPanelOpen,
    setInsightsPanelWidth,
    setPathPanelCollapsed,
    setPathPanelOpen,
    setPathPanelWidth,
    showInsightsPanel,
    showPathPanel,
    toggleInsightsPanel,
    togglePathPanel,
  } = useReviewPanelController();
  const [discussionsOpen, setDiscussionsOpen] = useState(false);
  // A ref, not state: the composer owns the draft while it is mounted, so
  // this only carries the text across an unmount the reviewer did not ask
  // for, such as a wait that failed.
  const commentDraft = useRef("");
  // Keys the composer, so a draft handed to it from outside reaches the
  // textarea even when the composer already stands open on that line.
  const [draftRevision, setDraftRevision] = useState(0);
  const [selectedLine, setSelectedLine] = useState<number>();
  const [pendingCommentLine, setPendingCommentLine] = useState<{
    line: number;
    unitId: string;
  }>();
  const [pendingProviderThread, setPendingProviderThread] = useState<{
    externalId: string;
    line: number;
    unitId: string;
  }>();
  const [pendingAiQuestionLine, setPendingAiQuestionLine] = useState<{
    line: number;
    unitId: string;
  }>();
  const [keyboardLine, setKeyboardLine] = useState<number>();
  const [contextBefore, setContextBefore] = useState(0);
  const [contextAfter, setContextAfter] = useState(0);
  const [commandCenterMode, setCommandCenterMode] =
    useState<CommandCenterMode>();
  useEffect(() => {
    setReviewMode(storedReviewMode(window.localStorage));
  }, []);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [explanationLine, setExplanationLine] = useState<number>();
  // A ref, not state: the composer owns the draft while it is mounted, and a
  // line move remounts it, so this only carries the text across that remount.
  const aiQuestionDraft = useRef("");
  const [revisionNotice, setRevisionNotice] = useState<{
    previous?: ReviewRevision;
  }>();
  const [signOffUndoHistory, setSignOffUndoHistory] = useState<
    SignOffUndoEntry[]
  >([]);
  const [importPreview, setImportPreview] = useState<ImportPreview>();
  const [resolvingImport, setResolvingImport] = useState<string>();
  const [importReturn, setImportReturn] = useState<{
    index: number;
    unitName: string;
    importedName: string;
  }>();
  const {
    aiReviewDialogOpen,
    commandBindingsSuspended,
    conceptGroupingDialogOpen,
    hierarchyOpen,
    moveMemberDialogOpen,
    pullRequestDetailsOpen,
    resetDialogOpen,
    setAiReviewDialogOpen,
    setConceptGroupingDialogOpen,
    setHierarchyOpen,
    setMoveMemberDialogOpen,
    setPullRequestDetailsOpen,
    setResetDialogOpen,
    setSplitConceptDialogOpen,
    splitConceptDialogOpen,
  } = useReviewDialogController({
    importPreviewOpen: importPreview !== undefined,
    linePickerOpen: keyboardLine !== undefined,
  });
  const pathSearchRef = useRef<HTMLInputElement>(null);
  const codeScrollRef = useRef<HTMLDivElement>(null);
  const clearFindingLineRef = useRef<() => void>(() => undefined);
  const dismissedAiQuestionUnits = useRef(new Set<string>());
  // Units of a multi-unit undo whose own success is not worth a toast.
  const quietUndoUnitIds = useRef(new Set<string>());
  const undoInFlight = useRef(false);
  const [undoPending, setUndoPending] = useState(false);
  const diffContextRef = useRef<SideBySideUnitDiffHandle>(null);
  const reviewUnitStartRef = useRef<HTMLDivElement>(null);
  const reviewCardsAboveRef = useRef<HTMLDivElement>(null);
  const codeOverviewRef = useRef<HTMLDivElement>(null);
  const [selectedCardStuck, setSelectedCardStuck] = useState(false);
  const importPreviewFocusRef = useRef<HTMLDivElement>(null);
  const [sessionId, setSessionId] = useState<string>();
  const [signOffQueue, dispatchSignOffQueue] = useReducer(
    signOffQueueReducer,
    undefined,
    createSignOffQueue,
  );
  const [pendingConceptSignOffIds, setPendingConceptSignOffIds] = useState(
    () => new Set<string>(),
  );
  const queuedSignOffs = useRef<QueuedSignOff[]>([]);
  const signOffDrainRunning = useRef(false);
  const utils = api.useUtils();
  const activeUnit = units[activeIndex];
  const activeUnitId = activeUnit?.id;
  const restoredPositionSnapshotId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const snapshotId = initialData.snapshot?.id;
    if (!snapshotId || units.length === 0) return;
    if (restoredPositionSnapshotId.current !== snapshotId) {
      restoredPositionSnapshotId.current = snapshotId;
      const rememberedUnitId = rememberedReviewPosition(
        window.localStorage,
        initialData.pullRequest.id,
        snapshotId,
      );
      const rememberedIndex = units.findIndex(
        (unit) =>
          unit.id === rememberedUnitId &&
          unit.status !== "signed_off" &&
          unit.status !== "waiting",
      );
      if (rememberedIndex >= 0) {
        if (rememberedIndex !== activeIndex) setActiveIndex(rememberedIndex);
        return;
      }
    }
    if (!activeUnitId) return;
    rememberReviewPosition(
      window.localStorage,
      initialData.pullRequest.id,
      snapshotId,
      activeUnitId,
    );
  }, [
    activeIndex,
    activeUnitId,
    initialData.pullRequest.id,
    initialData.snapshot?.id,
    units,
  ]);
  const unitsById = useMemo(
    () => new Map(units.map((unit) => [unit.id, unit])),
    [units],
  );
  const unitIndexById = useMemo(
    () => new Map(units.map((unit, index) => [unit.id, index])),
    [units],
  );
  const conceptByMemberId = useMemo(() => {
    const owners = new Map<string, ReviewConcept>();
    for (const concept of initialData.concepts) {
      for (const memberId of concept.memberIds) {
        if (!owners.has(memberId)) owners.set(memberId, concept);
      }
    }
    return owners;
  }, [initialData.concepts]);
  const activeConcept = activeUnitId
    ? conceptByMemberId.get(activeUnitId)
    : undefined;
  const activeConceptProgress = useMemo(
    () =>
      activeConcept ? liveConceptStatus(activeConcept, unitsById) : undefined,
    [activeConcept, unitsById],
  );
  const conceptLayoutLocked = Boolean(
    initialData.conceptLayout?.locked ||
      units.some(({ status }) => status === "signed_off"),
  );
  const activeConceptMembers = useMemo(
    () => conceptMembersInReadingOrder(activeConceptProgress?.members ?? []),
    [activeConceptProgress],
  );
  const reviewFiles = useMemo(
    () => reviewFileEntries(initialData.files, units),
    [initialData.files, units],
  );
  const conceptFileCards = useMemo(() => {
    const cards = conceptFileCardsInReadingOrder(activeConceptMembers);
    return activeUnit &&
      !cards.some(({ members }) =>
        members.some(({ id }) => id === activeUnit.id),
      )
      ? [{ path: activeUnit.path, members: [activeUnit] }, ...cards]
      : cards;
  }, [activeConceptMembers, activeUnit]);
  const activeConceptFileCards = useMemo(
    () =>
      reviewMode === "files"
        ? reviewFileCardsInTreeOrder(reviewFiles)
        : conceptFileCards,
    [conceptFileCards, reviewFiles, reviewMode],
  );
  const activeFileCard = activeUnit
    ? activeConceptFileCards.find(({ members }) =>
        members.some(({ id }) => id === activeUnit.id),
      )
    : undefined;
  const activeFileCardMembers = useMemo(
    () =>
      reviewMode === "files" && activeUnit
        ? units.filter(({ path }) => path === activeUnit.path)
        : (activeFileCard?.members ?? []),
    [activeFileCard?.members, activeUnit, reviewMode, units],
  );
  const activeConceptCardIndex = activeFileCard
    ? activeConceptFileCards.indexOf(activeFileCard)
    : -1;
  const viewerCardWindow = useMemo(() => {
    if (reviewMode !== "files" || activeConceptCardIndex < 0) {
      return {
        start: 0,
        cards: activeConceptFileCards,
        hiddenAbove: 0,
        hiddenBelow: 0,
      };
    }
    return windowReviewFileCards(
      activeConceptFileCards,
      activeConceptCardIndex,
      filesViewerAbove,
      filesViewerBelow,
    );
  }, [
    activeConceptCardIndex,
    activeConceptFileCards,
    filesViewerAbove,
    filesViewerBelow,
    reviewMode,
  ]);
  const selectedWindowOffset = Math.max(
    0,
    activeConceptCardIndex - viewerCardWindow.start,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: recenter when the open file or projection changes, not when the reviewer expands the window
  useEffect(() => {
    setFilesViewerAbove(FILES_VIEWER_PAGE_SIZE);
    setFilesViewerBelow(FILES_VIEWER_PAGE_SIZE);
  }, [activeUnit?.path, reviewMode]);
  const deletedFilePaths = useMemo(
    () =>
      new Set(
        fileContexts
          .filter(({ changeType }) => changeType === "deleted")
          .map(({ path }) => path),
      ),
    [fileContexts],
  );
  const activeFileIsDeleted = activeUnit
    ? deletedFilePaths.has(activeUnit.path)
    : false;
  const activeSourceAvailable = Boolean(
    activeUnit && hydratedUnitIds.has(activeUnit.id),
  );
  const activeSourceHydrationPending = Boolean(
    sourceHydrationPending && activeUnit && !settledUnitIds.has(activeUnit.id),
  );
  const activeFileCardHydrationPending = Boolean(
    sourceHydrationPending &&
      activeFileCardMembers.some(({ id }) => !settledUnitIds.has(id)),
  );
  const settledActiveUnitId = useSettledValue(activeUnitId, 200);
  const previousActiveUnitId = useRef(activeUnitId);
  const activeUnitFoundation = activeUnit
    ? reviewFoundationPriority(activeUnit)
    : undefined;
  const updateSelectedCardChrome = useCallback(() => {
    const pane = codeScrollRef.current;
    const card = reviewUnitStartRef.current;
    if (!pane || !card) {
      setSelectedCardStuck((current) => (current ? false : current));
      return;
    }
    // The stuck chrome is only for when this card has scrolled under its own
    // sticky header. Landing on a later file must keep a complete card top,
    // even if earlier cards left the pane scrolled.
    const next =
      card.getBoundingClientRect().top < pane.getBoundingClientRect().top - 1;
    setSelectedCardStuck((current) => (current === next ? current : next));
  }, []);
  const selectedCardPinKey = `${reviewMode}:${activeConceptCardIndex}:${activeUnit?.id ?? ""}:${activeUnit?.startLine ?? ""}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin after the selected file hydrates so the card has its real height
  useLayoutEffect(() => {
    if (!activeUnit?.id || !selectedCardPinKey) return;
    const pane = codeScrollRef.current;
    if (!pane) return;
    const focusLine = activeUnit.startLine;
    const focusUnitId = activeUnit.id;
    const pinToFileTop =
      reviewMode === "files" &&
      sourcePinRequest?.kind === "file" &&
      sourcePinRequest.unitId === focusUnitId;

    /** Pins file-tree selections to the card top and unit navigation to its work. */
    const pinSelectedCard = () => {
      const card = reviewUnitStartRef.current;
      if (!card) {
        pane.scrollTo({ top: 0, behavior: "auto" });
        setSelectedCardStuck(false);
        return;
      }
      const unitStart = card.querySelector(
        `[data-review-unit-start="${focusUnitId}"]`,
      );
      const unitLine = document.getElementById(`review-line-${focusLine}`);
      const target = reviewCardPinTarget({
        card,
        pinToFileTop,
        unitLine: unitLine instanceof HTMLElement ? unitLine : undefined,
        unitStart: unitStart instanceof HTMLElement ? unitStart : undefined,
      });
      const paneTop = pane.getBoundingClientRect().top;
      const targetTop = target.getBoundingClientRect().top;
      const stickyHeader =
        target === card ? null : card.querySelector(".sticky");
      const stickyOffset =
        stickyHeader instanceof HTMLElement
          ? stickyHeader.getBoundingClientRect().height
          : 0;
      pane.scrollTo({
        top: Math.max(
          0,
          pane.scrollTop +
            targetTop -
            paneTop -
            stickyOffset -
            SELECTED_REVIEW_CARD_GUTTER_PX,
        ),
        behavior: "auto",
      });
      updateSelectedCardChrome();
    };

    pinSelectedCard();
    const cardsAbove = reviewCardsAboveRef.current;
    if (!cardsAbove) return;
    const observer = new ResizeObserver(pinSelectedCard);
    observer.observe(cardsAbove);
    // Previous-card previews can grow after first paint. Re-pin only while
    // that layout is still settling so a later manual scroll is not yanked.
    const settleId = window.setTimeout(() => observer.disconnect(), 400);
    return () => {
      observer.disconnect();
      window.clearTimeout(settleId);
    };
  }, [
    activeFileCardHydrationPending,
    activeUnit?.id,
    activeUnit?.startLine,
    reviewMode,
    selectedCardPinKey,
    sourcePinRequest,
    updateSelectedCardChrome,
  ]);
  useEffect(() => {
    const previousUnitId = previousActiveUnitId.current;
    previousActiveUnitId.current = activeUnitId;
    if (!previousUnitId || previousUnitId === activeUnitId) return;
    void Promise.all([
      utils.ai.status.cancel({
        pullRequestId: initialData.pullRequest.id,
        unitId: previousUnitId,
      }),
      utils.review.unitDiscussion.cancel({ unitId: previousUnitId }),
    ]);
  }, [activeUnitId, initialData.pullRequest.id, utils]);
  useEffect(() => {
    if (!pathPanelOpen && !insightsPanelOpen) return;

    /** Closes an overlay panel without interfering with form input. */
    function closeOverlayPanel(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setPathPanelOpen(false);
      setInsightsPanelOpen(false);
    }

    document.addEventListener("keydown", closeOverlayPanel);
    return () => document.removeEventListener("keydown", closeOverlayPanel);
  }, [
    insightsPanelOpen,
    pathPanelOpen,
    setPathPanelOpen,
    setInsightsPanelOpen,
  ]);
  useEffect(() => {
    const persistentPath = window.matchMedia("(min-width: 1536px)");
    const persistentInsights = window.matchMedia("(min-width: 1280px)");

    /** Clears overlay-only state when either panel becomes persistent. */
    function settlePersistentPanels() {
      if (persistentPath.matches) setPathPanelOpen(false);
      if (persistentInsights.matches) setInsightsPanelOpen(false);
    }

    persistentPath.addEventListener("change", settlePersistentPanels);
    persistentInsights.addEventListener("change", settlePersistentPanels);
    return () => {
      persistentPath.removeEventListener("change", settlePersistentPanels);
      persistentInsights.removeEventListener("change", settlePersistentPanels);
    };
  }, [setInsightsPanelOpen, setPathPanelOpen]);
  // A concept whose members are all absent is dropped, which compacts the
  // list. Entry and lookup are therefore derived from one array, so that the
  // index a reviewer clicks names the concept they are looking at.
  const conceptPathEntries = useMemo(
    () =>
      initialData.concepts.flatMap((concept) => {
        const progress = liveConceptStatus(concept, unitsById);
        const anchor = progress.members[0];
        if (!anchor) return [];
        return [
          {
            concept,
            unit: {
              ...anchor,
              name: concept.title,
              status:
                progress.status === "signed_off" ||
                progress.status === "changed"
                  ? progress.status
                  : progress.members.every(
                        ({ status }) =>
                          status === "signed_off" || status === "waiting",
                      ) &&
                      progress.members.some(
                        ({ status }) => status === "waiting",
                      )
                    ? ("waiting" as const)
                    : ("pending" as const),
              waitingSince:
                progress.members.find(({ waitingSince }) => waitingSince)
                  ?.waitingSince ?? null,
            } satisfies ReviewUnit,
          },
        ];
      }),
    [initialData.concepts, unitsById],
  );
  const conceptPathUnits = useMemo(
    () => conceptPathEntries.map(({ unit }) => unit),
    [conceptPathEntries],
  );
  const activeConceptPathIndex = activeConcept
    ? Math.max(
        0,
        conceptPathEntries.findIndex(
          ({ concept }) => concept.id === activeConcept.id,
        ),
      )
    : 0;
  const pathSections = useMemo(
    () => reviewPathSections(conceptPathUnits, activeConceptPathIndex),
    [activeConceptPathIndex, conceptPathUnits],
  );
  const nextUnitToPreload = pathSearch.trim()
    ? (pathSections.upcoming.find(({ unit }) =>
        reviewPathSearchMatches(unit, pathSearch),
      )?.unit ?? pathSections.upcoming[0]?.unit)
    : pathSections.upcoming[0]?.unit;
  useEffect(() => {
    const nearbyFiles =
      reviewMode === "files"
        ? nearbyReviewFilePaths(
            reviewFiles,
            activeUnit?.path,
            FILES_VIEWER_PREVIEW_RADIUS + FILES_VIEWER_PREFETCH_RADIUS,
          )
        : undefined;
    const languages = nearbyFiles
      ? [
          ...new Set(
            units
              .filter(
                (unit) => unit.kind !== "binary" && nearbyFiles.has(unit.path),
              )
              .map((unit) => unit.language),
          ),
        ]
      : nextUnitToPreload && nextUnitToPreload.kind !== "binary"
        ? [nextUnitToPreload.language]
        : [];
    if (languages.length === 0) return;
    /** Prepares nearby highlighted source outside the input event. */
    const preload = () => {
      for (const language of languages) {
        void preloadSyntaxLanguage(language);
      }
    };
    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(preload, { timeout: 400 });
      return () => window.cancelIdleCallback(idleId);
    }
    const timeoutId = window.setTimeout(preload, 0);
    return () => window.clearTimeout(timeoutId);
  }, [activeUnit?.path, nextUnitToPreload, reviewFiles, reviewMode, units]);
  const reviewHierarchy = useMemo(() => buildReviewHierarchy(units), [units]);
  const searchResults = useMemo(() => {
    if (!pathSearch.trim()) return [];
    return units
      .map((unit, index) => ({ unit, index }))
      .filter(
        ({ unit, index }) =>
          index !== activeIndex && reviewPathSearchMatches(unit, pathSearch),
      );
  }, [activeIndex, pathSearch, units]);
  const progress = units.length
    ? Math.round(
        (units.filter((unit) => unit.status === "signed_off").length /
          units.length) *
          100,
      )
    : 0;
  const signedCount = units.filter(
    (unit) => unit.status === "signed_off",
  ).length;
  const reviewedFileCount = reviewFiles.filter(
    ({ state }) => state === "reviewed",
  ).length;
  const activeReviewFile = activeUnit
    ? reviewFiles.find(({ path }) => path === activeUnit.path)
    : undefined;
  const activeFileOutstandingUnits = activeReviewFile
    ? activeReviewFile.totalUnits -
      activeReviewFile.reviewedUnits -
      activeReviewFile.waitingUnits
    : 0;
  const conceptProgress = useMemo(
    () =>
      initialData.concepts.map((concept) => ({
        concept,
        ...liveConceptStatus(concept, unitsById),
      })),
    [initialData.concepts, unitsById],
  );
  const signedConceptCount = conceptProgress.filter(
    ({ status }) => status === "signed_off",
  ).length;
  const conceptChangedLineTotal = units.reduce(
    (total, unit) => total + unit.changedLineCount,
    0,
  );
  const reviewedChangedLines = units.reduce(
    (total, unit) =>
      total + (unit.status === "signed_off" ? unit.changedLineCount : 0),
    0,
  );
  const waitingCount = units.filter((unit) => unit.status === "waiting").length;
  const availability = reviewAvailability(units);
  const hasNextActionableUnit = availability === "active";
  const reviewComplete = availability === "complete";
  const reviewCaughtUp = availability === "caught_up";
  const [completionOpen, setCompletionOpen] = useState(reviewComplete);
  const [waitingCompletionOpen, setWaitingCompletionOpen] =
    useState(reviewCaughtUp);
  const previousReviewComplete = useRef(reviewComplete);
  const previousReviewCaughtUp = useRef(reviewCaughtUp);
  const completedFileCount = useMemo(
    () => new Set(units.map(({ path }) => path)).size,
    [units],
  );
  const reviewQueue = api.review.dashboard.useQuery(undefined, {
    enabled: reviewComplete || reviewCaughtUp,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  const providerReviewState = api.review.providerReviewState.useQuery(
    { pullRequestId: initialData.pullRequest.id },
    {
      enabled: reviewComplete,
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
      staleTime: 0,
    },
  );
  const setProviderReviewDecision =
    api.review.setProviderReviewDecision.useMutation({
      onSuccess: (state) => {
        utils.review.providerReviewState.setData(
          { pullRequestId: initialData.pullRequest.id },
          state,
        );
        void Promise.all([
          utils.review.providerReviewState.invalidate({
            pullRequestId: initialData.pullRequest.id,
          }),
          utils.review.providerLifecycle.invalidate({
            pullRequestId: initialData.pullRequest.id,
          }),
          utils.review.dashboard.invalidate(),
        ]);
        toast.success(
          state.decision === "approved"
            ? "Approval recorded"
            : state.decision === "changes_requested"
              ? state.provider === "azure_devops"
                ? "Rejection recorded"
                : "Changes requested"
              : "Provider decision cleared",
          {
            description: `${providerLabel(state.provider)} is now synchronized with this review.`,
          },
        );
      },
      onError: (error) =>
        toast.error("Provider review decision was not updated", {
          description: error.message,
        }),
    });
  const providerLifecycle = api.review.providerLifecycle.useQuery(
    { pullRequestId: initialData.pullRequest.id },
    {
      enabled: reviewComplete,
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
      staleTime: 0,
      refetchInterval: followPendingProviderLifecycle,
    },
  );
  const mergePullRequest = api.review.mergePullRequest.useMutation({
    onSuccess: (state) => {
      utils.review.providerLifecycle.setData(
        { pullRequestId: initialData.pullRequest.id },
        state,
      );
      void Promise.all([
        utils.review.providerLifecycle.invalidate({
          pullRequestId: initialData.pullRequest.id,
        }),
        utils.review.providerReviewState.invalidate({
          pullRequestId: initialData.pullRequest.id,
        }),
        utils.review.dashboard.invalidate(),
      ]);
      toast.success(
        state.pullRequestState === "merged"
          ? state.provider === "azure_devops"
            ? "Pull request completed"
            : "Pull request merged"
          : "Merge submitted",
        {
          description: `${providerLabel(state.provider)} is now synchronized with this review.`,
        },
      );
    },
    onError: (error) =>
      toast.error("Pull request was not merged", {
        description: error.message,
      }),
  });
  const nextReview = useMemo(
    () => findNextReview(reviewQueue.data, initialData.pullRequest.id),
    [initialData.pullRequest.id, reviewQueue.data],
  );
  useReviewExitPrefetch(router, {
    nextReviewId: nextReview?.id,
    reviewEnded: reviewComplete || reviewCaughtUp,
  });
  useEffect(() => {
    sendReviewSession({
      type: reviewComplete ? "REVIEW_COMPLETED" : "REVIEW_REOPENED",
    });
  }, [reviewComplete]);
  useEffect(() => {
    if (reviewComplete && !previousReviewComplete.current) {
      setCompletionOpen(true);
    } else if (!reviewComplete) {
      setCompletionOpen(false);
      setCompletedBrowsing(false);
    }
    previousReviewComplete.current = reviewComplete;
  }, [reviewComplete]);
  useEffect(() => {
    if (reviewCaughtUp && !previousReviewCaughtUp.current) {
      setWaitingCompletionOpen(true);
    } else if (!reviewCaughtUp) {
      setWaitingCompletionOpen(false);
    }
    previousReviewCaughtUp.current = reviewCaughtUp;
  }, [reviewCaughtUp]);
  const revisionReReviewCount = initialData.units.filter(
    ({ changedSinceSignOff }) => changedSinceSignOff,
  ).length;
  const revisionPreservedCount = initialData.units.filter(
    ({ status }) => status === "signed_off",
  ).length;
  const previewHasFileContext = importPreview
    ? fileContexts.some((context) => context.path === importPreview.path)
    : false;
  const previewModuleIndex = importPreview
    ? previewHasFileContext
      ? -1
      : units.findIndex(
          (unit) => unit.path === importPreview.path && unit.kind === "module",
        )
    : -1;
  const activeModule = activeUnit
    ? (fileContexts.find((context) => context.path === activeUnit.path) ??
      units.find(
        (unit) => unit.path === activeUnit.path && unit.kind === "module",
      ))
    : undefined;
  const activeFileCardSourceAvailable =
    activeFileCardMembers.length > 0 &&
    activeFileCardMembers.every(
      (member) => member.kind === "binary" || hydratedUnitIds.has(member.id),
    );
  const diffAvailable = Boolean(
    activeSourceAvailable &&
      activeUnit &&
      activeUnit.kind !== "binary" &&
      (activeUnit.previousSource ||
        activeUnit.changeType === "added" ||
        Boolean(activeModule?.previousSource)),
  );
  const sideBySideVisible = showDiff && diffAvailable;
  const importsVisible = activeUnit
    ? importContextUnitIds.has(activeUnit.id)
    : false;
  const fullFileVisible = activeUnit
    ? fullFileUnitIds.has(activeUnit.id)
    : false;
  const previousUnitStartLine =
    activeUnit?.changeType === "deleted"
      ? activeUnit.startLine
      : activeUnit?.previousSource && activeModule
        ? sourceByteOffsetLine(
            activeModule.previousSource ?? undefined,
            activeUnit.previousStartByte,
            sourceStartLine(
              activeModule.previousSource ?? undefined,
              activeUnit.previousSource,
              activeUnit.startLine,
            ),
          )
        : (activeUnit?.startLine ?? 1);
  const previousUnitEndLine = activeUnit?.previousSource
    ? sourceEndLine(activeUnit.previousSource, previousUnitStartLine)
    : previousUnitStartLine;
  const currentRelatedRanges = useMemo(
    () => relatedReviewRanges(activeUnit, "current"),
    [activeUnit],
  );
  const previousRelatedRanges = useMemo(
    () => relatedReviewRanges(activeUnit, "previous"),
    [activeUnit],
  );
  const currentCardRanges = useMemo(
    () => reviewCardRanges(activeFileCardMembers, "current"),
    [activeFileCardMembers],
  );
  const previousCardRanges = useMemo(
    () =>
      reviewCardRanges(
        activeFileCardMembers,
        "previous",
        activeModule?.previousSource,
      ),
    [activeFileCardMembers, activeModule?.previousSource],
  );
  const cardStartLine =
    currentCardRanges.at(0)?.startLine ?? activeUnit?.startLine;
  const cardEndLine = currentCardRanges.at(-1)?.endLine ?? activeUnit?.endLine;
  const activeFileCardReviewed = reviewedFileCard(activeFileCardMembers);
  const activeFileCardChangedLineCount = activeFileCardMembers.reduce(
    (total, member) => total + member.changedLineCount,
    0,
  );
  const activeFileCardLineCount =
    cardStartLine !== undefined && cardEndLine !== undefined
      ? Math.max(0, cardEndLine - cardStartLine + 1)
      : 0;
  const activeFileCardHeavy = isHeavyReviewSource({
    changedLineCount: activeFileCardChangedLineCount,
    language: activeUnit?.language,
    path: activeUnit?.path,
    source: activeModule?.source,
  });
  const selectedFileSourceExpanded =
    fileSourceReveal &&
    fileSourceReveal.path === (activeUnit?.path ?? "") &&
    fileSourceReveal.reviewed === activeFileCardReviewed
      ? fileSourceReveal.expanded
      : reviewFileCardStartsExpanded({
          reviewed: activeFileCardReviewed,
          heavy: activeFileCardHeavy,
        });
  const firstCurrentReviewLine =
    currentRelatedRanges?.at(0)?.startLine ?? activeUnit?.startLine ?? 1;
  const primaryReviewRanges =
    activeUnit?.changeType === "deleted"
      ? previousCardRanges
      : currentCardRanges;
  const primaryReviewStart =
    primaryReviewRanges?.at(0)?.startLine ??
    (activeUnit?.changeType === "deleted"
      ? previousUnitStartLine
      : firstCurrentReviewLine);
  const primaryReviewEnd =
    primaryReviewRanges?.at(-1)?.endLine ??
    (activeUnit?.changeType === "deleted"
      ? previousUnitEndLine
      : (activeUnit?.endLine ?? 1));
  /** Checks whether a line is reviewable on the unit's provider side. */
  const isPrimaryReviewLine = (line: number) =>
    lineWithinReviewRanges(
      line,
      primaryReviewRanges,
      primaryReviewStart,
      primaryReviewEnd,
    );
  const diffPreviousSource =
    activeModule?.previousSource ?? activeUnit?.previousSource ?? "";
  const diffCurrentSource =
    activeModule?.source ??
    (activeUnit?.changeType === "deleted" ? "" : (activeUnit?.source ?? ""));
  const overviewLineCount = useMemo(
    () =>
      Math.max(
        reviewSourceLineCount(diffCurrentSource),
        reviewSourceLineCount(diffPreviousSource),
      ),
    [diffCurrentSource, diffPreviousSource],
  );
  const overviewEnabled =
    Boolean(activeUnit) &&
    selectedFileSourceExpanded &&
    activeSourceAvailable &&
    activeUnit?.kind !== "binary" &&
    overviewLineCount >= 24;
  const overviewRows = useMemo(
    () =>
      overviewEnabled
        ? sideBySideDiff(diffPreviousSource, diffCurrentSource)
        : [],
    [diffCurrentSource, diffPreviousSource, overviewEnabled],
  );
  const overviewMarks = useMemo(
    () => overviewMarksFromDiffRows(overviewRows),
    [overviewRows],
  );
  const overviewUnitRange = useMemo(() => {
    if (!activeUnit || overviewRows.length === 0) return undefined;
    return overviewRangeFromDiffRows(
      overviewRows,
      activeUnit.changeType === "deleted"
        ? previousUnitStartLine
        : activeUnit.startLine,
      activeUnit.changeType === "deleted"
        ? previousUnitEndLine
        : activeUnit.endLine,
      {
        currentStartLine: activeModule ? 1 : activeUnit.startLine,
        previousStartLine: activeModule ? 1 : previousUnitStartLine,
      },
    );
  }, [
    activeModule,
    activeUnit,
    overviewRows,
    previousUnitEndLine,
    previousUnitStartLine,
  ]);
  const {
    scrolled: codePaneScrolled,
    seek: seekCodeOverview,
    update: updateCodeOverview,
    viewport: overviewViewport,
  } = useReviewCodeOverview(
    codeScrollRef,
    codeOverviewRef,
    `${activeUnit?.id ?? ""}:${sideBySideVisible}:${overviewLineCount}:${fullFileVisible}`,
  );
  const fullFileLines = useMemo(
    () => activeModule?.source.split("\n") ?? [],
    [activeModule?.source],
  );
  const contextAvailable = Boolean(
    activeUnit &&
      activeModule &&
      cardEndLine &&
      fullFileLines.length >= cardEndLine,
  );
  const availableBefore =
    contextAvailable && cardStartLine ? Math.max(0, cardStartLine - 1) : 0;
  const availableAfter =
    contextAvailable && cardEndLine
      ? Math.max(0, fullFileLines.length - cardEndLine)
      : 0;
  const visibleStartLine = fullFileVisible
    ? 1
    : contextAvailable && cardStartLine
      ? cardStartLine - Math.min(contextBefore, availableBefore)
      : (activeUnit?.startLine ?? 1);
  const visibleEndLine = fullFileVisible
    ? fullFileLines.length
    : contextAvailable && cardEndLine
      ? cardEndLine + Math.min(contextAfter, availableAfter)
      : (activeUnit?.endLine ?? 1);
  const contextRevealed =
    fullFileVisible || contextBefore > 0 || contextAfter > 0;
  const contextVisible = activeFileCardMembers.length > 1 || contextRevealed;
  const changedCurrentLines = useMemo(() => {
    const changedLines = new Set<number>();
    if (
      !activeUnit ||
      activeUnit.kind === "binary" ||
      activeUnit.changeType === "deleted"
    ) {
      return changedLines;
    }
    if (activeModule?.previousSource) {
      for (const index of currentChangedLineIndexes(
        activeModule.previousSource,
        activeModule.source,
      )) {
        changedLines.add(index + 1);
      }
      return changedLines;
    }
    if (activeUnit.changeType === "added") {
      for (const range of currentCardRanges) {
        for (let line = range.startLine; line <= range.endLine; line += 1) {
          changedLines.add(line);
        }
      }
      return changedLines;
    }
    if (!activeUnit.previousSource) return changedLines;
    for (const index of currentChangedLineIndexes(
      activeUnit.previousSource,
      activeUnit.source,
    )) {
      changedLines.add(activeUnit.startLine + index);
    }
    return changedLines;
  }, [activeModule, activeUnit, currentCardRanges]);
  const filteredReviewActive = pathSearch.trim().length > 0;
  const displayedSource = useMemo(() => {
    if (!activeUnit) return "";
    if (!contextAvailable) return activeUnit.source;
    return fullFileLines.slice(visibleStartLine - 1, visibleEndLine).join("\n");
  }, [
    activeUnit,
    contextAvailable,
    fullFileLines,
    visibleEndLine,
    visibleStartLine,
  ]);
  const lines = useHighlightedSource(
    selectedFileSourceExpanded ? displayedSource : "",
    activeUnit?.language ?? "text",
  );
  const displayedLineEntries = useMemo(
    () =>
      lines.flatMap((line, index) => {
        const lineNumber = visibleStartLine + index;
        if (activeFileCardMembers.length <= 1) return [{ line, lineNumber }];
        const owner = reviewCardMemberForLine(
          activeFileCardMembers,
          lineNumber,
        );
        const collapsed = owner
          ? (unitFoldOverrides.get(owner.id) ??
            reviewUnitStartsCollapsed(owner))
          : false;
        const opensUnit = activeFileCardMembers.some(
          (member) => member.startLine === lineNumber,
        );
        return collapsed && !opensUnit ? [] : [{ line, lineNumber }];
      }),
    [activeFileCardMembers, lines, unitFoldOverrides, visibleStartLine],
  );
  const previousRewriteSource =
    activeUnit?.changeType === "modified" &&
    activeUnit.previousSource &&
    activeUnit.kind !== "binary"
      ? activeUnit.previousSource
      : "";
  const highlightedPreviousRewrite = useHighlightedSource(
    selectedFileSourceExpanded ? previousRewriteSource : "",
    activeUnit?.language ?? "text",
  );
  const previousRewriteLines = useMemo(() => {
    if (!activeUnit || !previousRewriteSource) return [];
    for (
      let line = activeUnit.startLine;
      line <= activeUnit.endLine;
      line += 1
    ) {
      if (!changedCurrentLines.has(line)) return [];
    }
    return highlightedPreviousRewrite;
  }, [
    activeUnit,
    changedCurrentLines,
    highlightedPreviousRewrite,
    previousRewriteSource,
  ]);
  const {
    close: closeSymbolPeek,
    holdOpen: holdSymbolPeek,
    peeked: peekedSymbol,
    peekHandlers,
  } = useSymbolPeek(activeSourceAvailable);
  const importReferences = useImportReferences(
    selectedFileSourceExpanded ? displayedSource : "",
    activeUnit?.language ?? "text",
  );
  // Every token of every rendered line asks whether it starts an import
  // binding, so the references are indexed by offset rather than scanned.
  const importReferenceByStart = useMemo(() => {
    const byStart = new Map<number, ImportReference>();
    for (const reference of importReferences) {
      byStart.set(reference.from, reference);
    }
    return byStart;
  }, [importReferences]);
  const fileImportReferences = useImportReferences(
    selectedFileSourceExpanded ? (activeModule?.source ?? "") : "",
    activeUnit?.language ?? "text",
  );
  // The name may be bound by an import statement the diff does not show, so
  // the whole file's imports are what say where to look for its declaration.
  const peekedImport = peekedSymbol
    ? fileImportReferences.find(({ local }) => local === peekedSymbol.symbol)
    : undefined;
  // A stored language the grammars no longer cover must not take the render
  // down: the lookup simply has nothing to resolve against and stays off.
  // Plain text is covered by name but has no parser behind it, so it has no
  // declarations to find either.
  const peekedLanguage = knownLanguage(activeUnit?.language ?? "text");
  const peekable = peekedLanguage !== undefined && peekedLanguage !== "text";
  const peekedDefinition = api.review.symbolDefinition.useQuery(
    {
      pullRequestId: initialData.pullRequest.id,
      sourcePath: activeUnit?.path ?? "",
      sourceLanguage: peekedLanguage ?? "text",
      symbol: peekedSymbol?.symbol ?? "",
      line: peekedSymbol?.line,
      ...(peekedImport
        ? {
            specifier: peekedImport.specifier,
            imported: peekedImport.imported,
            kind: peekedImport.kind,
          }
        : {}),
    },
    {
      enabled: Boolean(peekedSymbol && activeUnit && peekable),
      staleTime: 5 * 60_000,
      retry: false,
    },
  );
  const importPreviewLines = useHighlightedSource(
    importPreview?.source ?? "",
    importPreview?.language ?? "text",
  );
  /** Opens the provider comment composer for one reviewable diff line. */
  const openInlineComment = useCallback((line: number, draft = "") => {
    setKeyboardLine(undefined);
    setSelectedLine(line);
    commentDraft.current = draft;
    setDraftRevision((revision) => revision + 1);
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() =>
        document
          .getElementById(`review-line-${line}`)
          ?.scrollIntoView({ block: "center" }),
      ),
    );
  }, []);
  /** Scrolls the source to one AI walkthrough note, mounting its block first. */
  const revealExplanation = useCallback((endLine: number, index: number) => {
    setExplanationLine(endLine);
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() =>
        document
          .getElementById(`ai-explanation-${index}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" }),
      ),
    );
  }, []);
  /** Opens one atomic review unit and selects its concept card. */
  const selectUnit = useCallback(
    (index: number, pin: "file" | "unit" = "unit") => {
      const target = units[index];
      if (!target) return;
      setSourcePinRequest({ kind: pin, unitId: target.id });
      setActiveIndex(index);
      setShowDiff(true);
      setStartedAt(Date.now());
      setQueueLimit(INITIAL_PATH_ITEMS);
      setKeyboardLine(undefined);
      // `openFinding` sets the finding line after calling this, and the later
      // set wins in the same batch; a unit reached by ⌘↓, the path panel or a
      // concept card instead arrives with no stale amber line lit.
      clearFindingLineRef.current();
      setContextBefore(0);
      setContextAfter(0);
      setImportReturn(undefined);
      setImportPreview(undefined);
      setPathPanelOpen(false);
      setInsightsPanelOpen(false);
    },
    [units, setPathPanelOpen, setInsightsPanelOpen],
  );
  /** Opens a file at its first actionable unit without expanding to the full file. */
  const selectReviewFile = useCallback(
    (file: ReviewFileEntry) => {
      const member = actionableReviewCardMember(file.units);
      if (!member) {
        toast.info("This file has no semantic review units", {
          description:
            file.skipReason ??
            (file.isBinary
              ? "Binary content is shown in the changed-file tree only."
              : "It does not contribute to semantic review completion."),
        });
        return;
      }
      const index = units.findIndex(({ id }) => id === member.id);
      if (index < 0) return;
      setCompletedBrowsing(false);
      setCompletionOpen(false);
      selectUnit(index, "file");
    },
    [selectUnit, units],
  );
  const requestReviewFileAdvance = useReviewFileAdvance(
    reviewFiles,
    selectReviewFile,
  );

  /**
   * Applies or reverses one file-sized semantic review decision.
   *
   * Sign-off uses the same optimistic queue as unit and card actions so a
   * reviewer can tick several files without waiting for each save. After a
   * sign-off the workspace opens the next outstanding file in the sidebar.
   * Each return targets its own snapshot file, so returns are tracked per file
   * and every other file stays clickable while one of them saves.
   */
  function applyReviewFileToggle(file: ReviewFileEntry) {
    if (file.totalUnits === 0) return;
    if (file.state === "reviewed") {
      if (
        pendingFiles.has(file.id) ||
        file.units.some((unit) => signOffQueue.ids.has(unit.id))
      ) {
        return;
      }
      const signedIds = file.units
        .filter((unit) => unit.status === "signed_off")
        .map((unit) => unit.id);
      unreviewRollbacks.current.set(
        file.id,
        unitsRef.current.filter((unit) => signedIds.includes(unit.id)),
      );
      const updated = optimisticallyUnreviewReviewUnits(
        unitsRef.current,
        signedIds,
      );
      unitsRef.current = updated;
      setUnits(updated);
      setPendingFiles((current) => new Set(current).add(file.id));
      unreviewFile.mutate({
        snapshotFileId: file.id,
        sessionId,
      });
      return;
    }
    const outstanding = outstandingReviewFileUnits(file);
    if (outstanding.length === 0) return;
    const nextFile = nextOutstandingReviewFile(reviewFiles, file.path);
    const activeDuration = Math.round((Date.now() - startedAt) / 1000);
    setCompletedBrowsing(false);
    // Update the checkbox before selecting the next file because source
    // hydration and highlighting can delay that selection's render.
    optimisticallyQueueSignOffs(
      outstanding.map((unit) => ({
        unitId: unit.id,
        sessionId,
        durationSeconds: unit.id === activeUnit?.id ? activeDuration : 0,
      })),
      undefined,
      { advance: false },
    );
    if (nextFile) {
      requestReviewFileAdvance(nextFile.path);
    }
  }
  const applyReviewFileToggleRef = useRef(applyReviewFileToggle);
  applyReviewFileToggleRef.current = applyReviewFileToggle;
  /**
   * Keeps one identity for the file decision across workspace renders.
   *
   * The changed-file tree is memoized, and it reads sign-off state that the
   * surrounding render recomputes on every keystroke and stream chunk, so the
   * handler reaches it through a ref instead of as a fresh closure.
   */
  const toggleReviewFile = useCallback((file: ReviewFileEntry) => {
    applyReviewFileToggleRef.current(file);
  }, []);
  /**
   * Opens the composer on a line a reviewer picked in another member's card.
   *
   * The composer, the published threads and the publish call all read the open
   * unit, so the card the line came from has to open first. Opening it clears
   * the composer, which is why the line is held here until that unit is the
   * one on screen rather than passed straight to the composer.
   */
  const commentOnMemberLine = useCallback(
    (unitId: string, line: number) => {
      const index = unitIndexById.get(unitId) ?? -1;
      if (index < 0) return;
      setPendingCommentLine({ unitId, line });
      selectUnit(index);
    },
    [selectUnit, unitIndexById],
  );
  /** Opens a line through the atomic owner represented inside the file card. */
  const commentOnCardLine = useCallback(
    (line: number) => {
      const owner = reviewCardMemberForLine(activeFileCardMembers, line);
      if (!owner) return;
      if (owner.id === activeUnitId) {
        openInlineComment(line);
      } else {
        commentOnMemberLine(owner.id, line);
      }
    },
    [
      activeFileCardMembers,
      activeUnitId,
      commentOnMemberLine,
      openInlineComment,
    ],
  );
  /** Opens AI assistance through the atomic owner represented in the card. */
  function askAboutCardLine(line: number) {
    const owner = reviewCardMemberForLine(activeFileCardMembers, line);
    if (!owner) return;
    if (owner.id === activeUnitId) {
      openAiQuestionAt(line);
      return;
    }
    const index = unitIndexById.get(owner.id) ?? -1;
    if (index < 0) return;
    setPendingAiQuestionLine({ unitId: owner.id, line });
    selectUnit(index);
  }
  // File cards are re-rendered only when their members or source move, so
  // unrelated workspace state never re-reconciles hundreds of source lines.
  const conceptFileCardPreviews = useMemo(
    () =>
      viewerCardWindow.cards.map((card, windowIndex) => {
        const cardIndex = viewerCardWindow.start + windowIndex;
        const firstActionable = actionableReviewCardMember(card.members);
        const fileContext = fileContexts.find(({ path }) => path === card.path);
        const itemLabel = reviewMode === "files" ? "File" : "Card";
        const sourceBytes = reviewSourceByteLength(fileContext);
        /** Opens this file card at its first remaining review unit. */
        const openCard = () =>
          selectUnit(
            firstActionable
              ? (unitIndexById.get(firstActionable.id) ?? -1)
              : -1,
          );
        if (
          reviewMode === "files" &&
          Math.abs(cardIndex - activeConceptCardIndex) >
            FILES_VIEWER_PREVIEW_RADIUS
        ) {
          return (
            <article
              key={card.path}
              className="mx-4 overflow-hidden rounded-xl border border-line bg-surface/30"
            >
              <ReviewFileCardHeader
                members={card.members}
                index={cardIndex}
                count={activeConceptFileCards.length}
                selected={false}
                itemLabel={itemLabel}
                onSelect={openCard}
                sourceBytes={sourceBytes}
              />
            </article>
          );
        }
        return (
          <ReviewConceptFileCardPreview
            key={card.path}
            members={card.members}
            index={cardIndex}
            count={activeConceptFileCards.length}
            fileSource={fileContext?.source ?? ""}
            itemLabel={itemLabel}
            onSelect={openCard}
            onCommentLine={commentOnMemberLine}
            sourceBytes={sourceBytes}
          />
        );
      }),
    [
      activeConceptCardIndex,
      activeConceptFileCards.length,
      commentOnMemberLine,
      fileContexts,
      reviewMode,
      selectUnit,
      unitIndexById,
      viewerCardWindow.cards,
      viewerCardWindow.start,
    ],
  );

  /** Opens the anchor unit for one concept-first path entry. */
  function selectConceptPath(index: number) {
    // The entry is anchored on the concept's first member that this snapshot
    // still holds. Its own first member id may name one the snapshot dropped,
    // and reading that instead opens nothing.
    const anchorId = conceptPathEntries[index]?.unit.id;
    const unitIndex = anchorId ? (unitIndexById.get(anchorId) ?? -1) : -1;
    if (unitIndex >= 0) selectUnit(unitIndex);
  }

  /** Selects an adjacent file card in the current viewer list. */
  function navigateConceptCard(direction: -1 | 1) {
    const card = activeConceptFileCards[activeConceptCardIndex + direction];
    const member = card ? actionableReviewCardMember(card.members) : undefined;
    if (!member) return;
    const index = unitIndexById.get(member.id) ?? -1;
    if (index >= 0) selectUnit(index);
  }

  /** Opens the adjacent concept while preserving concept-first navigation. */
  function navigateConcept(direction: -1 | 1) {
    const index = activeConceptPathIndex + direction;
    if (index >= 0 && index < initialData.concepts.length) {
      selectConceptPath(index);
    }
  }

  /** Shows or hides source context surrounding the active review unit. */
  function toggleContext() {
    if (!contextAvailable) return;
    if (contextRevealed) {
      setContextBefore(0);
      setContextAfter(0);
      codeScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    setContextBefore(Math.min(CONTEXT_PAGE_LINES, availableBefore));
    setContextAfter(Math.min(CONTEXT_PAGE_LINES, availableAfter));
  }
  /** Navigates an import to its review unit or opens its source context. */
  async function followImport(reference: ImportReference) {
    if (!activeUnit) return;
    const resolutionKey = `${activeUnit.id}:${reference.from}:${reference.to}`;
    const localTarget = findImportTargetUnit(
      activeUnit.path,
      activeUnit.language,
      reference,
      units,
    );
    if (localTarget) {
      const pathUnits = units
        .map((unit, index) => ({ unit, index }))
        .filter(({ unit }) => unit.path === localTarget.targetPath);
      const target = pathUnits.find(
        ({ unit }) => unit.id === localTarget.exactUnit?.id,
      );
      if (target) {
        if (target.index === activeIndex) return;
        const origin = {
          index: activeIndex,
          unitName: activeUnit.name,
          importedName:
            reference.kind === "named" ? reference.imported : target.unit.name,
        };
        selectUnit(target.index);
        setImportReturn(origin);
        toast.success(`Opened ${target.unit.name}`, {
          description: `Reviewing this import out of order. ${activeUnit.name} remains in your path.`,
        });
        return;
      }
      const moduleUnit = pathUnits.find(
        ({ unit }) => unit.id === localTarget.moduleUnit?.id,
      );
      if (moduleUnit) {
        setImportPreview({
          kind: "preview",
          path: moduleUnit.unit.path,
          language: moduleUnit.unit.language,
          name: reference.imported,
          source: moduleUnit.unit.source,
          startLine: moduleUnit.unit.startLine,
          endLine: moduleUnit.unit.endLine,
          focusLine: findImportedDeclarationLine(
            moduleUnit.unit.source,
            reference.imported,
            moduleUnit.unit.language,
            moduleUnit.unit.startLine,
          ),
          inReviewPath: true,
        });
        return;
      }
    }

    setResolvingImport(resolutionKey);
    try {
      const result = await utils.review.importTarget.fetch({
        pullRequestId: initialData.pullRequest.id,
        sourcePath: activeUnit.path,
        sourceLanguage: supportedLanguage(activeUnit.language),
        specifier: reference.specifier,
        imported: reference.imported,
        kind: reference.kind,
      });
      if (result.kind === "unit") {
        const index = units.findIndex((unit) => unit.id === result.unitId);
        if (index >= 0) {
          const origin = {
            index: activeIndex,
            unitName: activeUnit.name,
            importedName: reference.imported,
          };
          selectUnit(index);
          setImportReturn(origin);
          return;
        }
      }
      if (result.kind === "preview") {
        setImportPreview(result);
        return;
      }
      toast.info(
        result.reason === "too_large"
          ? "This source file is too large for the in-app preview"
          : result.reason === "external"
            ? "This import is provided outside the repository"
            : "This import could not be found at the reviewed revision",
      );
    } catch (cause) {
      toast.error(
        cause instanceof Error
          ? cause.message
          : "The imported source could not be opened",
      );
    } finally {
      setResolvingImport((current) =>
        current === resolutionKey ? undefined : current,
      );
    }
  }
  const { mutate: beginSession } = api.review.beginSession.useMutation({
    onSuccess: (session) => setSessionId(session?.id),
    onError: (error) => toast.error(error.message),
  });
  useEffect(() => {
    beginSession({
      pullRequestId: initialData.pullRequest.id,
    });
    // A review workspace starts one resumable session per snapshot.
  }, [beginSession, initialData.pullRequest.id]);
  useEffect(() => {
    const snapshot = initialData.snapshot;
    if (!snapshot) return;
    const current = {
      headSha: snapshot.headSha,
      snapshotId: snapshot.id,
      version: snapshot.version,
    };
    const acknowledged = acknowledgedReviewRevision(
      window.localStorage,
      initialData.pullRequest.id,
    );
    if (acknowledged?.snapshotId === current.snapshotId) {
      setRevisionNotice(undefined);
      return;
    }
    if (acknowledged) {
      setRevisionNotice({ previous: acknowledged });
      return;
    }
    if (revisionReReviewCount > 0) {
      const previous = initialData.previousSnapshot;
      setRevisionNotice({
        previous: previous
          ? {
              headSha: previous.headSha,
              snapshotId: previous.id,
              version: previous.version,
            }
          : undefined,
      });
      return;
    }
    acknowledgeReviewRevision(
      window.localStorage,
      initialData.pullRequest.id,
      current,
    );
  }, [
    initialData.previousSnapshot,
    initialData.pullRequest.id,
    initialData.snapshot,
    revisionReReviewCount,
  ]);
  const signOff = api.review.signOff.useMutation();
  const signOffBatch = api.review.signOffBatch.useMutation();
  /** Releases one saved file without disturbing the others still in flight. */
  function resolvePendingFile(snapshotFileId: string) {
    unreviewRollbacks.current.delete(snapshotFileId);
    setPendingFiles((current) => {
      const next = new Set(current);
      next.delete(snapshotFileId);
      return next;
    });
  }

  const unreviewFile = api.review.unreviewFile.useMutation({
    onSuccess: ({ snapshotFileId, unreviewedUnitIds }) => {
      const unreviewed = new Set(unreviewedUnitIds);
      setUnits((current) =>
        current.map((unit) =>
          unreviewed.has(unit.id)
            ? {
                ...unit,
                status:
                  unit.revisionState === "updated"
                    ? ("changed" as const)
                    : ("pending" as const),
                signOffOrigin: "none" as const,
              }
            : unit,
        ),
      );
      resolvePendingFile(snapshotFileId);
      setCompletedBrowsing(false);
      void Promise.all([
        utils.workspace.guidance.invalidate(),
        utils.review.dashboard.invalidate(),
        utils.review.gamification.invalidate(),
      ]);
      toast.success("File returned to review", {
        description: `${unreviewedUnitIds.length} ${unreviewedUnitIds.length === 1 ? "unit is" : "units are"} back in the review path.`,
      });
    },
    onError: (error, { snapshotFileId }) => {
      const rollback = unreviewRollbacks.current.get(snapshotFileId);
      if (rollback) {
        const restored = new Map(rollback.map((unit) => [unit.id, unit]));
        setUnits((current) =>
          current.map((unit) => restored.get(unit.id) ?? unit),
        );
      }
      resolvePendingFile(snapshotFileId);
      toast.error("File could not be returned to review", {
        description: error.message,
      });
    },
  });

  /** Applies several sign-offs immediately while retaining rollback state. */
  function optimisticallyQueueSignOffs(
    inputs: SignOffInput[],
    preferredNextUnit?: (unit: ReviewUnit, index: number) => boolean,
    options?: { advance?: boolean },
  ) {
    const inputByUnitId = new Map(inputs.map((input) => [input.unitId, input]));
    const alreadyQueued = new Set(
      queuedSignOffs.current.map(({ input }) => input.unitId),
    );
    const scrollTop = codeScrollRef.current?.scrollTop ?? 0;
    const currentUnits = unitsRef.current;
    const queued = currentUnits.flatMap((unit, unitIndex): QueuedSignOff[] => {
      const input = inputByUnitId.get(unit.id);
      if (
        !input ||
        alreadyQueued.has(unit.id) ||
        unit.status === "signed_off" ||
        unit.status === "waiting"
      ) {
        return [];
      }
      return [
        {
          input,
          rollback: {
            unit,
            unitIndex,
            pathSearch,
            searchLimit,
            showDiff,
            contextBefore,
            contextAfter,
            scrollTop,
          },
        },
      ];
    });
    if (queued.length === 0) return;
    const updated = optimisticallySignOffReviewUnits(
      currentUnits,
      queued.map(({ input }) => input.unitId),
    );
    const first = queued[0];
    if (first) {
      setSignOffUndoHistory((history) =>
        rememberSignOff(history, {
          kind: "unit",
          label:
            queued.length === 1
              ? first.rollback.unit.name
              : `${queued.length} units`,
          unitIds: queued.map(({ input }) => input.unitId),
          view: reviewViewSnapshot(first.rollback),
        }),
      );
    }
    for (const entry of queued) {
      dispatchSignOffQueue({
        type: "enqueue",
        unitId: entry.input.unitId,
      });
    }
    queuedSignOffs.current.push(...queued);
    unitsRef.current = updated;
    setUnits(updated);
    if (options?.advance === false) {
      void drainSignOffQueue();
      return;
    }
    const nextIndex = nextReviewIndexAfterAction(updated, preferredNextUnit);
    if (nextIndex >= 0) {
      setActiveIndex(nextIndex);
    }
    setQueueLimit(INITIAL_PATH_ITEMS);
    setShowDiff(true);
    setContextBefore(0);
    setContextAfter(0);
    codeScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    setStartedAt(Date.now());
    void drainSignOffQueue();
  }

  /** Restores failed optimistic saves and returns focus to the first failure. */
  function restoreFailedSignOffs(
    failures: Array<{
      code?: string;
      message: string;
      queued: QueuedSignOff;
    }>,
  ) {
    const first = failures[0];
    if (!first) return;
    setUnits((current) =>
      failures.reduce(
        (restored, { queued }) =>
          restoreReviewUnitAfterFailedSignOff(restored, queued.rollback.unit),
        current,
      ),
    );
    const rollback = first.queued.rollback;
    setActiveIndex(rollback.unitIndex);
    if (rollback.pathSearch.trim()) {
      setPathSearch((current) =>
        current.trim() ? current : rollback.pathSearch,
      );
      setSearchLimit(rollback.searchLimit);
    }
    setShowDiff(rollback.showDiff);
    setContextBefore(rollback.contextBefore);
    setContextAfter(rollback.contextAfter);
    setStartedAt(Date.now());
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        codeScrollRef.current?.scrollTo({
          top: rollback.scrollTop,
          behavior: "auto",
        });
      }),
    );
    if (
      failures.some(({ code }) => code === "CONFLICT" || code === "NOT_FOUND")
    ) {
      markUpdateAvailable();
      toast.warning("Review path changed", {
        id: "review-sign-off-save-error",
        description:
          failures.length === 1
            ? `${rollback.unit.name} could not be signed off because its code changed. Load the latest review path to review it again.`
            : `${failures.length} units could not be signed off because the review path changed. Returned to ${rollback.unit.name}.`,
      });
      return;
    }
    toast.error("Sign-off was not saved", {
      id: "review-sign-off-save-error",
      description:
        first.code === "UNAUTHORIZED"
          ? `Returned to ${rollback.unit.name}. Your session could not be refreshed; reload or sign in again.`
          : failures.length === 1
            ? `Returned to ${rollback.unit.name}. ${first.message}`
            : `${failures.length} saves failed. Returned to ${rollback.unit.name}. ${first.message}`,
    });
  }

  /** Drains one immediate save, then coalesces accumulated work into batches. */
  async function drainSignOffQueue() {
    if (signOffDrainRunning.current) return;
    signOffDrainRunning.current = true;
    try {
      while (queuedSignOffs.current.length > 0) {
        const batchSize = nextSignOffBatchSize(queuedSignOffs.current.length);
        const batch = queuedSignOffs.current.splice(0, batchSize);
        let saved = 0;
        try {
          if (batch.length === 1) {
            const queued = batch[0];
            if (!queued) continue;
            await signOff.mutateAsync(queued.input);
            saved = 1;
          } else {
            const results = await signOffBatch.mutateAsync({
              signOffs: batch.map(({ input }) => input),
            });
            const queuedByUnit = new Map(
              batch.map((queued) => [queued.input.unitId, queued]),
            );
            const failures = results.flatMap((result) => {
              if (result.ok) {
                saved += 1;
                return [];
              }
              const queued = queuedByUnit.get(result.unitId);
              return queued
                ? [
                    {
                      code: result.code,
                      message: result.message,
                      queued,
                    },
                  ]
                : [];
            });
            restoreFailedSignOffs(failures);
          }
          if (saved > 0) {
            void Promise.all([
              utils.workspace.guidance.invalidate(),
              utils.review.dashboard.invalidate(),
              utils.review.gamification.invalidate(),
            ]);
          }
        } catch (error) {
          const failure =
            error instanceof Error
              ? error
              : new Error("The sign-off request failed");
          const code =
            typeof error === "object" &&
            error !== null &&
            "data" in error &&
            typeof error.data === "object" &&
            error.data !== null &&
            "code" in error.data &&
            typeof error.data.code === "string"
              ? error.data.code
              : undefined;
          const remaining =
            code === "UNAUTHORIZED" ? queuedSignOffs.current.splice(0) : [];
          const failed = [...batch, ...remaining];
          restoreFailedSignOffs(
            failed.map((queued) => ({
              code,
              message: failure.message,
              queued,
            })),
          );
          for (const { input } of remaining) {
            dispatchSignOffQueue({ type: "settle", unitId: input.unitId });
          }
        } finally {
          for (const { input } of batch) {
            dispatchSignOffQueue({ type: "settle", unitId: input.unitId });
          }
        }
      }
    } finally {
      signOffDrainRunning.current = false;
    }
  }
  /**
   * Returns the named units to the review path before the server answers.
   *
   * Sign-off paints through the queue the moment it is pressed, so undo has
   * to as well: a mark that holds for a round trip reads as the control
   * doing nothing to the reviewer who signed off by mistake. Only sign-offs
   * that still stand are taken back, because one undo step can name units
   * some other action has already given back.
   */
  function optimisticallyUndoSignOffs(unitIds: string[]) {
    const named = new Set(unitIds);
    const undone = unitsRef.current.filter(
      (unit) => named.has(unit.id) && unit.status === "signed_off",
    );
    if (undone.length === 0) return;
    const updated = optimisticallyUnreviewReviewUnits(
      unitsRef.current,
      undone.map(({ id }) => id),
    );
    unitsRef.current = updated;
    setUnits(updated);
    setStartedAt(Date.now());
    return undone;
  }

  /** Puts back the sign-offs an undo took away but the server kept. */
  function restoreUndoneSignOffs(undone: ReviewUnit[] | undefined) {
    if (!undone) return;
    const restored = new Map(undone.map((unit) => [unit.id, unit]));
    const updated = unitsRef.current.map(
      (unit) => restored.get(unit.id) ?? unit,
    );
    unitsRef.current = updated;
    setUnits(updated);
  }

  // Keyed by the unit the request named rather than the one on screen: undo
  // reaches back to a sign-off the reviewer has since moved on from.
  const undoSignOff = api.review.unreview.useMutation({
    onMutate: ({ unitId }) => optimisticallyUndoSignOffs([unitId]),
    onSuccess: ({ unreviewed }, { unitId }, undone) => {
      if (!unreviewed) {
        restoreUndoneSignOffs(undone);
        return;
      }
      void Promise.all([
        utils.workspace.guidance.invalidate(),
        utils.review.dashboard.invalidate(),
        utils.review.gamification.invalidate(),
      ]);
      // One undo of a many-unit step is one decision, so only the request
      // that finishes it says so.
      if (quietUndoUnitIds.current.delete(unitId)) return;
      toast.success("Marked as not reviewed", {
        description: `${units.find(({ id }) => id === unitId)?.name ?? "The unit"} is back in your review queue.`,
      });
    },
    onError: (error, _input, undone) => {
      restoreUndoneSignOffs(undone);
      toast.error(error.message);
    },
  });
  const signOffConcept = api.review.signOffConcept.useMutation();
  const undoConcept = api.review.unreviewConcept.useMutation({
    onMutate: ({ conceptId }) => {
      const concept = initialData.concepts.find(({ id }) => id === conceptId);
      if (!concept) return;
      return optimisticallyUndoSignOffs(concept.memberIds);
    },
    onSuccess: ({ unreviewed }, _input, undone) => {
      if (!unreviewed) {
        restoreUndoneSignOffs(undone);
        return;
      }
      void Promise.all([
        utils.workspace.guidance.invalidate(),
        utils.review.dashboard.invalidate(),
        utils.review.gamification.invalidate(),
      ]);
      toast.success("Concept returned to the review path");
    },
    onError: (error, _input, undone) => {
      restoreUndoneSignOffs(undone);
      toast.error(error.message);
    },
  });
  // Improve, Split, and Move member all funnel into the same layout mutation,
  // so the pressed control is remembered to keep its spinner on that control.
  const [conceptLayoutAction, setConceptLayoutAction] = useState<
    "improve" | "split" | "move"
  >();
  const replaceConceptLayout =
    api.review.replacePersonalConceptLayout.useMutation({
      onSuccess: () => {
        toast.success("Semantic grouping applied", {
          description:
            "Your personal concept layout is ready. Atomic coverage is unchanged.",
        });
        // The new grouping only reaches the screen with the refreshed server
        // payload, so the pressed control keeps its spinner inside the
        // transition until that payload arrives.
        startLayoutRefresh(() => {
          router.refresh();
          setConceptLayoutAction(undefined);
        });
      },
      onError: (error) => {
        setConceptLayoutAction(undefined);
        toast.error(error.message);
      },
    });
  const improveConceptGrouping = api.review.improveConceptGrouping.useMutation({
    onSuccess: ({ concepts }) => {
      if (!initialData.snapshot || !initialData.conceptLayout) {
        setConceptLayoutAction(undefined);
        return;
      }
      replaceConceptLayout.mutate({
        pullRequestId: initialData.pullRequest.id,
        snapshotId: initialData.snapshot.id,
        expectedVersion: initialData.conceptLayout.version,
        source: "ai",
        concepts,
      });
    },
    onError: (error) => {
      setConceptLayoutAction(undefined);
      toast.error(error.message);
    },
  });
  // The layout is only on screen once the refreshed payload lands, so the
  // refresh counts as part of the action the reviewer started.
  const conceptLayoutPending =
    replaceConceptLayout.isPending || layoutRefreshing;
  // The regrouping spans two mutations: the model proposes concepts, then the
  // layout is replaced. Both stages read as one action to the reviewer.
  const groupingImproving =
    improveConceptGrouping.isPending ||
    (conceptLayoutPending && conceptLayoutAction === "improve");
  const improveGroupingLabel = improveConceptGrouping.isPending
    ? "Improving grouping…"
    : conceptLayoutPending && conceptLayoutAction === "improve"
      ? "Applying grouping…"
      : "Improve grouping with AI";
  const splittingConcept =
    conceptLayoutPending && conceptLayoutAction === "split";
  const movingMember = conceptLayoutPending && conceptLayoutAction === "move";
  const moveMemberLabel = movingMember
    ? "Moving unit…"
    : "Move this unit to another concept";
  /** Finds the next filtered match, then resumes the global review path. */
  function nextReviewIndexAfterAction(
    nextUnits: ReviewUnit[],
    preferred?: (unit: ReviewUnit, index: number) => boolean,
  ) {
    if (pathSearch.trim()) {
      const filteredIndex = nextPendingReviewIndex(
        nextUnits,
        (unit, index) =>
          reviewPathSearchMatches(unit, pathSearch) &&
          (preferred?.(unit, index) ?? true),
      );
      if (filteredIndex >= 0) return filteredIndex;
      setPathSearch("");
      setSearchLimit(INITIAL_PATH_ITEMS);
    }
    return preferred
      ? nextPendingReviewIndexPreferring(nextUnits, preferred)
      : nextPendingReviewIndex(nextUnits);
  }

  /** Completes the current action within the active filter or global path. */
  function continueReview() {
    const nextIndex = nextReviewIndexAfterAction(units);
    if (nextIndex >= 0) {
      selectUnit(nextIndex);
      codeScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    }
  }
  const aiStatus = api.ai.status.useQuery(
    {
      pullRequestId: initialData.pullRequest.id,
      unitId: settledActiveUnitId,
    },
    {
      enabled: Boolean(settledActiveUnitId),
      refetchInterval: (query) =>
        ["queued", "running"].includes(query.state.data?.status ?? "")
          ? 2_000
          : false,
    },
  );
  const explanationError = aiErrorPresentation(aiStatus.data?.error);
  const aiQuestions = api.ai.questions.useQuery(
    {
      pullRequestId: initialData.pullRequest.id,
      unitId: settledActiveUnitId ?? "",
    },
    {
      enabled: Boolean(settledActiveUnitId),
      refetchInterval: (query) =>
        query.state.data?.some(({ status }) =>
          ["queued", "running"].includes(status),
        )
          ? 2_000
          : false,
    },
  );
  const {
    askQuestion,
    liveQuestions: liveAiQuestions,
    removeDeletedQuestions,
    removeTerminalQuestions,
    startPending: aiQuestionStartPending,
  } = useAiQuestionStreamController({
    onQuestionsChanged: () => void aiQuestions.refetch(),
    onUsageChanged: () => void aiUsage.refetch(),
    pullRequestId: initialData.pullRequest.id,
  });
  const {
    focusComposer: focusAiQuestionComposer,
    line: aiQuestionLine,
    move: moveAiQuestion,
    openAt: positionAiQuestion,
    previewLine: aiQuestionPreviewLine,
    setFocusComposer: setFocusAiQuestionComposer,
    setLine: setAiQuestionLine,
    setPreviewLine: setAiQuestionPreviewLine,
    setThreadId: setAiQuestionThreadId,
    step: stepAiQuestion,
    threadId: aiQuestionThreadId,
  } = useInlineAiQuestionController({
    activeUnit,
    codeScrollRef,
    isReviewLine: isPrimaryReviewLine,
    liveQuestions: liveAiQuestions,
    persistedQuestions: aiQuestions.data,
    primaryEnd: primaryReviewEnd,
    primaryRanges: primaryReviewRanges,
    primaryStart: primaryReviewStart,
    pullRequestId: initialData.pullRequest.id,
  });
  useEffect(() => {
    const terminalJobIds = new Set(
      aiQuestions.data
        ?.filter(({ status }) => ["completed", "failed"].includes(status))
        .map(({ id }) => id) ?? [],
    );
    removeTerminalQuestions(terminalJobIds);
  }, [aiQuestions.data, removeTerminalQuestions]);
  useEffect(() => {
    if (
      !activeUnit ||
      !activeUnitId ||
      activeUnitId !== settledActiveUnitId ||
      aiQuestionLine !== undefined ||
      dismissedAiQuestionUnits.current.has(activeUnitId)
    ) {
      return;
    }
    const latestSavedQuestion = aiQuestions.data?.at(-1);
    const remembered = aiConversationVisibility(
      window.localStorage,
      initialData.pullRequest.id,
      activeUnitId,
    );
    if (remembered === null) return;
    const focusLine = remembered
      ? remembered.line
      : latestSavedQuestion?.focusLine;
    const threadId =
      remembered?.threadId ?? latestSavedQuestion?.conversationId;
    if (
      focusLine === null ||
      focusLine === undefined ||
      (!lineWithinReviewRanges(
        focusLine,
        currentRelatedRanges,
        activeUnit.startLine,
        activeUnit.endLine,
      ) &&
        !lineWithinReviewRanges(
          focusLine,
          previousRelatedRanges,
          previousUnitStartLine,
          previousUnitEndLine,
        ))
    ) {
      return;
    }
    setFocusAiQuestionComposer(false);
    setAiQuestionLine(focusLine);
    setAiQuestionThreadId(threadId);
    rememberAiConversationVisibility(
      window.localStorage,
      initialData.pullRequest.id,
      activeUnitId,
      focusLine,
      threadId,
    );
  }, [
    activeUnit,
    activeUnitId,
    aiQuestionLine,
    aiQuestions.data,
    initialData.pullRequest.id,
    previousUnitEndLine,
    previousUnitStartLine,
    currentRelatedRanges,
    previousRelatedRanges,
    settledActiveUnitId,
    setAiQuestionLine,
    setAiQuestionThreadId,
    setFocusAiQuestionComposer,
  ]);
  const startExplanation = api.ai.start.useMutation({
    onSuccess: () => {
      toast.success("Explanation started");
      void aiStatus.refetch();
    },
    onError: showAiStartError,
  });
  const deleteAiQuestionThread = api.ai.deleteQuestionThread.useMutation({
    onError: (error) => toast.error(error.message),
  });
  const aiConfiguration = api.ai.configuration.useQuery();
  // Absent, never present-and-erroring: until the query resolves the account is
  // treated as unentitled, so no affordance renders that `ai.start` would then
  // refuse.
  const deepReviewAvailable =
    aiConfiguration.data?.deepReviewAvailable ?? false;
  const pullRequestReview = api.ai.reviewStatus.useQuery(
    { pullRequestId: initialData.pullRequest.id },
    {
      refetchInterval: (query) =>
        aiJobActive(query.state.data?.status) ? 2_000 : false,
    },
  );
  const explanationRunning =
    startExplanation.isPending ||
    ["queued", "running"].includes(aiStatus.data?.status ?? "");
  const aiQuestionRunning =
    aiQuestionStartPending ||
    liveAiQuestions.some(({ status }) =>
      ["queued", "running", "streaming"].includes(status),
    ) ||
    (aiQuestions.data?.some(({ status }) =>
      ["queued", "running"].includes(status),
    ) ??
      false);
  const explanationAnnotations = useMemo(
    () =>
      aiStatus.data?.status === "completed" && aiStatus.data.result
        ? [...(aiStatus.data.result.annotations ?? [])]
            .filter(
              (annotation) =>
                annotation.path === activeUnit?.path &&
                annotation.line >= (activeUnit?.startLine ?? 0) &&
                (annotation.endLine ?? annotation.line) <=
                  (activeUnit?.endLine ?? 0),
            )
            .sort(
              (left, right) =>
                left.line - right.line ||
                (left.endLine ?? left.line) - (right.endLine ?? right.line),
            )
        : [],
    [
      aiStatus.data,
      activeUnit?.endLine,
      activeUnit?.path,
      activeUnit?.startLine,
    ],
  );
  const {
    conversations: providerConversations,
    discussion,
    managingThread,
    providerThreadActions,
    publishComment,
    replyingToThread,
  } = useProviderConversationController({
    clearDraft: () => {
      commentDraft.current = "";
      setSelectedLine(undefined);
    },
    pullRequest: initialData.pullRequest,
    refreshIntervalMs: PROVIDER_CONVERSATION_REFRESH_MS,
    settledUnitId: settledActiveUnitId,
    waitingCount,
  });
  const providerDiscussionThreads = providerConversations.data?.threads ?? [];
  const openProviderDiscussionCount = providerDiscussionThreads.filter(
    isOpenProviderDiscussion,
  ).length;
  /** Leaves summary UI and returns to the exact unit carrying a discussion. */
  const openProviderDiscussion = useCallback(
    (thread: ProviderDiscussionThread) => {
      const index = unitIndexById.get(thread.unitId) ?? -1;
      if (index < 0) return;
      setDiscussionsOpen(false);
      setCompletionOpen(false);
      setWaitingCompletionOpen(false);
      setCompletedBrowsing(true);
      setPendingProviderThread({
        externalId: thread.externalId,
        line: thread.line,
        unitId: thread.unitId,
      });
      selectUnit(index);
    },
    [selectUnit, unitIndexById],
  );
  const manualSyncPending = reviewSession === "synchronizing";
  const {
    acknowledgeLoadedRevision,
    externalSyncPending,
    loadAvailableChanges,
    loadingChanges,
    markUpdateAvailable,
    resetReview,
    syncExternalData,
    updateAvailable,
  } = useReviewSynchronizationController({
    manualSyncPending,
    onReset: () => {
      const updated = resetSignedOffReviewUnits(unitsRef.current);
      unitsRef.current = updated;
      setUnits(updated);
      queuedSignOffs.current = [];
      dispatchSignOffQueue({ type: "synchronize", unitIds: [] });
      setPendingConceptSignOffIds(new Set());
      setSignOffUndoHistory([]);
      const nextIndex = nextPendingReviewIndex(updated);
      if (nextIndex >= 0) setActiveIndex(nextIndex);
      setCompletedBrowsing(false);
      setCompletionOpen(false);
      setWaitingCompletionOpen(false);
      setResetDialogOpen(false);
    },
    onRevisionAcknowledged: () => setRevisionNotice(undefined),
    pullRequest: initialData.pullRequest,
    sendReviewSession,
    snapshot: initialData.snapshot,
  });

  const {
    activeThreads: activeProviderThreads,
    activeUnitHasConversation,
    answeredWaitCount,
    awaitResponse,
    releaseReviewWaits,
    resumeReviewFile,
    waitingUnits: waitingReviewUnits,
  } = useReviewWaitController({
    activeUnitId: activeUnit?.id,
    conceptProgress,
    conversations: providerConversations.data,
    discussionComments: discussion.data?.comments,
    navigation: {
      commentDraft,
      nextReviewIndex: nextReviewIndexAfterAction,
      pathSearch,
      queueLimit,
      searchLimit,
      selectedLine,
      setActiveIndex,
      setPathSearch,
      setQueueLimit,
      setSearchLimit,
      setSelectedLine,
      setShowDiff,
      setStartedAt,
      setWaitingLimit,
      showDiff,
      startedAt,
      waitingLimit,
    },
    setUnits,
    units,
  });
  useEffect(() => {
    if (!pendingProviderThread) return;
    if (pendingProviderThread.unitId !== activeUnitId) return;
    const targetThread = pendingProviderThread;
    let frame = 0;
    let attempts = 0;
    const maximumAttempts = 180;

    /** Reveals the requested discussion once its hydrated target has mounted. */
    function revealDiscussion() {
      const target =
        document.getElementById(
          providerConversationElementId(targetThread.externalId),
        ) ?? document.getElementById(`review-line-${targetThread.line}`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        setPendingProviderThread(undefined);
        return;
      }
      attempts += 1;
      if (attempts >= maximumAttempts) {
        setPendingProviderThread(undefined);
        return;
      }
      frame = window.requestAnimationFrame(revealDiscussion);
    }

    frame = window.requestAnimationFrame(revealDiscussion);
    return () => window.cancelAnimationFrame(frame);
  }, [activeUnitId, pendingProviderThread]);
  const hasLiveConversation = activeUnitHasConversation;
  /** Renders the open finding inline beside the line it accuses. */
  function renderInlineFindingCard(
    finding: DeepReviewFinding,
    lineNumber: number,
  ) {
    if (!activeUnit) return null;
    const jobId = deepReview.data?.jobId;
    return (
      <DeepReviewInlineFinding
        key={finding.id}
        finding={finding}
        variant="line"
        locationIndex={activeFindingLocationIndex}
        providerName={providerLabel(initialData.pullRequest.provider)}
        published={findingPublished(finding)}
        publishing={
          publishComment.isPending &&
          publishComment.variables?.aiFindingId === finding.id
        }
        onOpenLocation={(index) => openFinding(finding, index)}
        onPublish={
          jobId
            ? () =>
                publishComment.mutate({
                  unitId: activeUnit.id,
                  line: lineNumber,
                  aiJobId: jobId,
                  aiFindingId: finding.id,
                })
            : undefined
        }
        onEdit={() =>
          openInlineComment(
            lineNumber,
            `**${finding.title}**\n\n${finding.body}`,
          )
        }
        onCollapse={() => collapseFinding(finding.id)}
      />
    );
  }

  /** Renders the open finding above the diff when no visible line carries it. */
  function renderDetachedFindingCard() {
    if (!activeFinding || !activeFindingTarget || !activeUnit) return null;
    const target = activeFindingTarget;
    const onThisUnit =
      target.kind !== "nowhere" &&
      units[target.unitIndex]?.id === activeUnit.id;
    // A card never follows the reviewer into unrelated code: it detaches only
    // where the finding itself points, or when it points nowhere at all.
    if (target.kind === "unit" && !onThisUnit) return null;
    // The unified view gives every rendered line a `review-line` id but only
    // hangs details off the reviewed ranges, so a line in the gap between a
    // concept's disjoint ranges resolves and lights up with nowhere to put
    // the body — the one case the reveal effect cannot detect for itself.
    const inlineCardRenders =
      onThisUnit &&
      !findingRevealExhausted &&
      (sideBySideVisible ||
        (target.kind === "line" && isPrimaryReviewLine(target.line)));
    if (target.kind === "line" && (!onThisUnit || inlineCardRenders)) {
      return null;
    }
    const label =
      target.kind === "nowhere"
        ? "Finding with no line in this revision"
        : target.kind === "unit"
          ? "Finding with no line in this file"
          : "Finding whose line this unit does not render";
    return (
      <div className="mb-3">
        <p className="text-fog px-4 text-[9px] tracking-[.14em] uppercase">
          {label}
        </p>
        <DeepReviewInlineFinding
          finding={activeFinding}
          variant="detached"
          locationIndex={activeFindingLocationIndex}
          providerName={providerLabel(initialData.pullRequest.provider)}
          published={findingPublished(activeFinding)}
          publishing={false}
          onOpenLocation={(index) => openFinding(activeFinding, index)}
          onCollapse={() => collapseFinding(activeFinding.id)}
          onShowInCode={
            target.kind === "unit"
              ? () => openFinding(activeFinding, activeFindingLocationIndex)
              : undefined
          }
        />
      </div>
    );
  }

  /** Reports a unit's explicit fold choice or its status-based default. */
  function unitIsCollapsed(member: ReviewUnit) {
    return (
      unitFoldOverrides.get(member.id) ?? reviewUnitStartsCollapsed(member)
    );
  }

  /** Changes one unit without disturbing the fold state of its siblings. */
  function toggleUnitCollapsed(member: ReviewUnit) {
    setUnitFoldOverrides((current) => {
      const next = new Map(current);
      next.set(
        member.id,
        !(current.get(member.id) ?? reviewUnitStartsCollapsed(member)),
      );
      return next;
    });
  }

  /** Reports whether this unit's individual ledger action is being saved. */
  function unitReviewActionPending(member: ReviewUnit) {
    const concept = conceptByMemberId.get(member.id);
    return (
      signOffQueue.ids.has(member.id) ||
      (undoSignOff.isPending && undoSignOff.variables?.unitId === member.id) ||
      Boolean(concept && pendingConceptSignOffIds.has(concept.id))
    );
  }

  /** Reports whether an atomic ledger action is safe from this card. */
  function unitReviewActionDisabled(member: ReviewUnit) {
    if (
      unitReviewActionPending(member) ||
      undoSignOff.isPending ||
      undoConcept.isPending ||
      resetReview.isPending
    ) {
      return true;
    }
    if (member.status === "signed_off") return false;
    return (
      reviewComplete ||
      member.status === "waiting" ||
      (member.kind !== "binary" && !hydratedUnitIds.has(member.id))
    );
  }

  /** Toggles one unit's review ledger without advancing or changing its card. */
  function toggleUnitReview(member: ReviewUnit) {
    if (unitReviewActionDisabled(member)) return;
    if (member.status === "signed_off") {
      undoSignOff.mutate({ unitId: member.id, sessionId });
      return;
    }
    optimisticallyQueueSignOffs(
      [
        {
          unitId: member.id,
          sessionId,
          durationSeconds:
            member.id === activeUnit?.id
              ? Math.round((Date.now() - startedAt) / 1000)
              : 0,
        },
      ],
      undefined,
      { advance: false },
    );
  }

  /** Units that open on this line when a card contains more than one. */
  function fileUnitsStartingAt(lineNumber: number) {
    if (activeFileCardMembers.length <= 1) return [];
    return activeFileCardMembers.filter(
      (member) => member.startLine === lineNumber,
    );
  }

  /** Reports whether the atomic owner of a rendered card line is folded. */
  function isFileUnitLineCollapsed(lineNumber: number) {
    if (activeFileCardMembers.length <= 1) return false;
    const owner = reviewCardMemberForLine(activeFileCardMembers, lineNumber);
    return owner ? unitIsCollapsed(owner) : false;
  }

  /** Renders the persistent opener for each atomic unit in a file card. */
  function renderFileUnitMarkers(lineNumber: number) {
    return fileUnitsStartingAt(lineNumber).map((member) => (
      <ReviewFileUnitMarker
        key={member.id}
        collapsed={unitIsCollapsed(member)}
        member={member}
        onToggleCollapsed={() => toggleUnitCollapsed(member)}
        onToggleReview={() => toggleUnitReview(member)}
        onStopWaiting={
          member.status === "waiting"
            ? () => stopWaitingOnUnit(member.id)
            : undefined
        }
        reviewActionDisabled={unitReviewActionDisabled(member)}
        reviewActionPending={unitReviewActionPending(member)}
      />
    ));
  }

  /** Renders every review artifact attached to one source line in either code view. */
  function renderReviewLineDetails(lineNumber: number) {
    if (!activeUnit) return null;
    const endingExplanations = groupedEntries(
      explanationsEndingAtLine,
      lineNumber,
    );
    const lineFindings = groupedEntries(reviewFindingsByLine, lineNumber);
    // A different source entirely from `lineFindings` above: that one is a
    // completed explain job's `result.findings`, a payload a deep-review run
    // never writes, so the two blocks cannot collide on one line.
    const lineDeepFindings = groupedEntries(
      deepReviewFindingsByLine,
      lineNumber,
    );
    const lineQuestionGroups = questionGroupsAt(
      aiQuestionGroupsByLine,
      lineNumber,
    );
    const activeThreadId =
      aiQuestionThreadId && lineQuestionGroups.has(aiQuestionThreadId)
        ? aiQuestionThreadId
        : ([...lineQuestionGroups.keys()].at(-1) ?? aiQuestionThreadId);
    const lineQuestions = activeThreadId
      ? groupedEntries(lineQuestionGroups, activeThreadId)
      : NO_GROUPED_ENTRIES;
    const lineThreads = groupedEntries(providerThreadsByLine, lineNumber);
    const lineComments = groupedEntries(publishedCommentsByLine, lineNumber);

    return (
      <>
        {endingExplanations.map(({ annotation, index }) => {
          const endLine = annotation.endLine ?? annotation.line;
          return (
            <article
              id={`ai-explanation-${index}`}
              key={`${annotation.line}-${endLine}-${annotation.title}`}
              className="border-violet/20 bg-violet/[.045] relative mx-4 my-2 ml-[82px] overflow-hidden rounded-xl border p-3 font-sans shadow-[0_10px_30px_var(--app-shadow)]"
            >
              <span className="bg-violet absolute inset-y-0 left-0 w-0.5" />
              <div className="flex items-start gap-3">
                <span className="bg-violet/10 text-violet mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg">
                  <Sparkles className="size-3.5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <p className="text-violet text-[9px] font-semibold tracking-[.12em] uppercase">
                      AI walkthrough
                    </p>
                    <span className="text-fog font-mono text-[9px]">
                      {annotation.line === endLine
                        ? `Line ${annotation.line}`
                        : `Lines ${annotation.line}–${endLine}`}
                    </span>
                  </div>
                  <h3 className="text-cloud mt-1 text-xs font-medium">
                    {annotation.title}
                  </h3>
                  <p className="text-mist mt-1.5 text-xs leading-5">
                    {annotation.body}
                  </p>
                </div>
              </div>
            </article>
          );
        })}
        {aiQuestionLine === lineNumber && (
          <InlineAiQuestion
            autoFocus={focusAiQuestionComposer}
            canAsk={canAskAi}
            initialDraft={aiQuestionDraft.current}
            entries={lineQuestions}
            line={lineNumber}
            minimumLine={Math.min(activeUnit.startLine, previousUnitStartLine)}
            maximumLine={Math.max(activeUnit.endLine, previousUnitEndLine)}
            onAsk={askAiQuestion}
            onClose={() => {
              if (activeUnitId) {
                dismissedAiQuestionUnits.current.add(activeUnitId);
                rememberAiConversationVisibility(
                  window.localStorage,
                  initialData.pullRequest.id,
                  activeUnitId,
                  null,
                );
              }
              setAiQuestionLine(undefined);
              setAiQuestionThreadId(undefined);
              setFocusAiQuestionComposer(false);
              setAiQuestionPreviewLine(undefined);
              aiQuestionDraft.current = "";
            }}
            onDeleteThread={async (jobIds) => {
              if (jobIds.length === 0) return;
              const questionInputs = [
                ...new Set(
                  [settledActiveUnitId, activeUnit.id].filter(
                    (unitId): unitId is string => Boolean(unitId),
                  ),
                ),
              ].map((unitId) => ({
                pullRequestId: initialData.pullRequest.id,
                unitId,
              }));
              // A poll started before the delete can land after refetch and
              // put the discarded thread back until the next full reload.
              await Promise.all(
                questionInputs.map((input) => utils.ai.questions.cancel(input)),
              );
              await deleteAiQuestionThread.mutateAsync({
                pullRequestId: initialData.pullRequest.id,
                unitId: activeUnit.id,
                jobIds,
              });
              for (const input of questionInputs) {
                utils.ai.questions.setData(input, (current) =>
                  withoutDeletedAiQuestions(current, jobIds),
                );
              }
              removeDeletedQuestions(jobIds);
              dismissedAiQuestionUnits.current.add(activeUnit.id);
              rememberAiConversationVisibility(
                window.localStorage,
                initialData.pullRequest.id,
                activeUnit.id,
                null,
              );
              setAiQuestionLine(undefined);
              setAiQuestionThreadId(undefined);
              setFocusAiQuestionComposer(false);
              setAiQuestionPreviewLine(undefined);
              aiQuestionDraft.current = "";
              toast.success("AI conversation deleted", {
                description:
                  "Previously published pull-request comments were preserved.",
              });
              for (const input of questionInputs) {
                void utils.ai.questions.invalidate(input);
              }
            }}
            onDraftChange={(value) => {
              aiQuestionDraft.current = value;
            }}
            onMove={moveAiQuestion}
            onPreview={setAiQuestionPreviewLine}
            onPublishProposal={async (proposal) => {
              await publishComment.mutateAsync({
                unitId: activeUnit.id,
                ...proposal,
              });
              dismissedAiQuestionUnits.current.add(activeUnit.id);
              rememberAiConversationVisibility(
                window.localStorage,
                initialData.pullRequest.id,
                activeUnit.id,
                null,
              );
              setAiQuestionLine(undefined);
              setAiQuestionThreadId(undefined);
              setFocusAiQuestionComposer(false);
            }}
            onStep={stepAiQuestion}
            providerName={providerLabel(initialData.pullRequest.provider)}
          />
        )}
        {[...lineQuestionGroups.entries()].map(
          ([threadId, questions], groupIndex) =>
            !(aiQuestionLine === lineNumber && activeThreadId === threadId) && (
              <button
                key={threadId}
                type="button"
                aria-label={
                  lineQuestionGroups.size === 1
                    ? `Reopen AI conversation on line ${lineNumber}`
                    : `Reopen AI conversation ${groupIndex + 1} on line ${lineNumber}`
                }
                onClick={() => {
                  dismissedAiQuestionUnits.current.delete(activeUnit.id);
                  rememberAiConversationVisibility(
                    window.localStorage,
                    initialData.pullRequest.id,
                    activeUnit.id,
                    lineNumber,
                    threadId,
                  );
                  setFocusAiQuestionComposer(false);
                  setAiQuestionThreadId(threadId);
                  setAiQuestionLine(lineNumber);
                }}
                className="border-violet/15 bg-violet/[.035] text-violet hover:border-violet/30 hover:bg-violet/[.07] mx-4 my-1 ml-[82px] flex items-center gap-2 rounded-lg border px-2.5 py-1.5 font-sans text-[9px] transition"
              >
                <Sparkles className="size-3" />
                AI conversation
                <span className="border-violet/15 bg-panel rounded px-1.5 py-0.5 font-mono text-[8px]">
                  {questions.length}
                </span>
              </button>
            ),
        )}
        {lineFindings.map((finding) => {
          const published = publishedAiProposals.has(
            `${finding.aiJobId}:${finding.index}`,
          );
          const publishingThisFinding =
            publishComment.isPending &&
            publishComment.variables?.aiJobId === finding.aiJobId &&
            publishComment.variables?.aiFindingIndex === finding.index;
          return (
            <article
              key={`${finding.aiJobId}-${finding.index}`}
              className="mx-4 my-2 ml-[82px] rounded-xl border border-amber-300/20 bg-surface p-3 font-sans"
            >
              <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
                <div className="min-w-0">
                  <p className="text-[9px] font-semibold tracking-wider text-amber-800 uppercase dark:text-amber-200">
                    AI review finding
                  </p>
                  <p className="text-cloud mt-1 text-xs font-medium">
                    {finding.title}
                  </p>
                </div>
                {published ? (
                  <Badge className="border-lime/20 bg-lime/8 text-lime">
                    Published
                  </Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    disabled={publishComment.isPending}
                    onClick={() =>
                      publishComment.mutate({
                        unitId: activeUnit.id,
                        line: lineNumber,
                        aiJobId: finding.aiJobId,
                        aiFindingIndex: finding.index,
                      })
                    }
                  >
                    {publishingThisFinding ? (
                      <LoaderCircle className="size-3 animate-spin" />
                    ) : (
                      <Send className="size-3" />
                    )}
                    {publishingThisFinding
                      ? "Posting…"
                      : `Post to ${providerLabel(initialData.pullRequest.provider)}`}
                  </Button>
                )}
              </div>
              <p className="text-mist mt-2 text-xs leading-5">{finding.body}</p>
            </article>
          );
        })}
        {/* The model's claim reads above the human conversation about it. */}
        {lineDeepFindings
          .filter(({ id }) => id !== activeFindingId)
          .map((finding) => (
            <DeepReviewFindingChip
              key={finding.id}
              finding={finding}
              published={findingPublished(finding)}
              onOpen={() => openFinding(finding)}
            />
          ))}
        {activeFinding &&
          activeFindingTarget?.kind === "line" &&
          activeFindingTarget.line === lineNumber &&
          units[activeFindingTarget.unitIndex]?.id === activeUnit.id &&
          !findingRevealExhausted &&
          renderInlineFindingCard(activeFinding, lineNumber)}
        {lineThreads.map((thread) => (
          <ProviderConversation
            key={thread.externalId}
            provider={initialData.pullRequest.provider}
            thread={thread}
            newSince={
              activeUnit.status === "waiting" ? activeUnit.waitingSince : null
            }
            managing={managingThread(thread.externalId)}
            replying={replyingToThread(thread.externalId)}
            {...providerThreadActions(activeUnit.id, thread.externalId)}
            publishedByReviewDuck={publishedProviderThreadIds.has(
              thread.externalId,
            )}
          />
        ))}
        {lineComments.map((comment) => (
          <div
            key={comment.id}
            className="border-cyan/15 bg-cyan/[.035] mx-4 my-2 ml-[82px] rounded-xl border p-3 font-sans"
          >
            <p className="text-cyan text-[9px] font-semibold tracking-wider uppercase">
              Posted to {providerLabel(initialData.pullRequest.provider)}
            </p>
            <p className="text-mist mt-1 text-xs leading-5">{comment.body}</p>
          </div>
        ))}
        {selectedLine === lineNumber && (
          <InlineCommentComposer
            key={`${lineNumber}-${draftRevision}`}
            initialDraft={commentDraft.current}
            line={lineNumber}
            path={activeUnit.path}
            pending={publishComment.isPending}
            posting={
              publishComment.isPending && publishComment.variables?.body != null
            }
            provider={initialData.pullRequest.provider}
            onCancel={() => {
              setSelectedLine(undefined);
              commentDraft.current = "";
            }}
            onDraftChange={(value) => {
              commentDraft.current = value;
            }}
            onPost={(body) =>
              publishComment.mutate({
                unitId: activeUnit.id,
                line: lineNumber,
                body,
              })
            }
          />
        )}
      </>
    );
  }
  const startPullRequestReview = api.ai.start.useMutation({
    onSuccess: () => {
      toast.success("Pull request review started", {
        description:
          "Findings will appear inline as the review agent completes its analysis.",
      });
      void pullRequestReview.refetch();
    },
    onError: showAiStartError,
  });
  const reviewRunning =
    startPullRequestReview.isPending ||
    aiJobActive(pullRequestReview.data?.status);
  const aiUsage = api.ai.usage.useQuery(
    { pullRequestId: initialData.pullRequest.id },
    {
      refetchInterval:
        explanationRunning || aiQuestionRunning || reviewRunning
          ? 2_000
          : false,
    },
  );
  // Coverage and findings are their own query rather than fields on
  // `ai.reviewStatus`: that one polls every two seconds, and carrying the whole
  // finding tree on it would refetch every finding twice a second.
  const deepReview = api.review.deepReviewFindings.useQuery(
    { pullRequestId: initialData.pullRequest.id },
    { refetchInterval: reviewRunning ? 4_000 : false },
  );
  const deepReviewFindings = deepReview.data?.findings;
  const {
    activeFinding,
    activeFindingId,
    activeFindingTarget,
    activeLocationIndex: activeFindingLocationIndex,
    categoryFilter: findingCategoryFilter,
    collapseFinding,
    findingGroups,
    findingLine,
    findingsListRef,
    openFinding,
    pendingReveal: pendingFindingReveal,
    revealExhausted: findingRevealExhausted,
    setCategoryFilter: setFindingCategoryFilter,
    setFindingLine,
    setSeverityFilter: setFindingSeverityFilter,
    severityFilter: findingSeverityFilter,
    stepFinding,
    toggleFindingSeverity,
    visibleFindings,
  } = useDeepReviewFindingController({
    activeIndex,
    activeSourceHydrationPending,
    activeUnitId,
    codeScrollRef,
    findings: deepReviewFindings,
    selectUnit,
    setShowDiff,
    sideBySideVisible,
    units,
  });
  clearFindingLineRef.current = () => setFindingLine(undefined);
  // Resolved once per unit rather than once per rendered line: the index can
  // hold forty findings and a unit can hold hundreds of lines.
  const deepReviewFindingsByLine = useMemo(() => {
    const byLine = new Map<number, DeepReviewFinding[]>();
    if (!activeUnitId) return byLine;
    for (const finding of deepReviewFindings ?? []) {
      const target = deepReviewFindingTarget(finding, units);
      if (target.kind !== "line") continue;
      if (units[target.unitIndex]?.id !== activeUnitId) continue;
      const group = byLine.get(target.line) ?? [];
      group.push(finding);
      byLine.set(target.line, group);
    }
    return byLine;
  }, [activeUnitId, deepReviewFindings, units]);
  // Every index below answers `renderReviewLineDetails` for one line. Resolved
  // per data change rather than per rendered line: a unit can hold hundreds of
  // lines and the discussion hundreds of comments, and the workspace re-renders
  // far more often than either collection changes.
  const explanationsEndingAtLine = useMemo(() => {
    const byLine = new Map<
      number,
      { annotation: (typeof explanationAnnotations)[number]; index: number }[]
    >();
    explanationAnnotations.forEach((annotation, index) => {
      const endLine = annotation.endLine ?? annotation.line;
      if (endLine < annotation.line) return;
      const group = byLine.get(endLine) ?? [];
      group.push({ annotation, index });
      byLine.set(endLine, group);
    });
    return byLine;
  }, [explanationAnnotations]);
  const reviewFindingsByLine = useMemo(() => {
    const byLine = new Map<
      number,
      NonNullable<typeof discussion.data>["findings"]
    >();
    for (const finding of discussion.data?.findings ?? []) {
      if (finding.line === undefined) continue;
      const group = byLine.get(finding.line) ?? [];
      group.push(finding);
      byLine.set(finding.line, group);
    }
    return byLine;
  }, [discussion.data?.findings]);
  const providerThreadsByLine = useMemo(() => {
    const byLine = new Map<number, typeof activeProviderThreads>();
    for (const thread of activeProviderThreads) {
      const group = byLine.get(thread.line) ?? [];
      group.push(thread);
      byLine.set(thread.line, group);
    }
    return byLine;
  }, [activeProviderThreads]);
  const publishedAiProposals = useMemo(() => {
    const proposals = new Set<string>();
    for (const comment of discussion.data?.comments ?? []) {
      if (comment.status !== "published") continue;
      if (!comment.aiJobId || comment.aiFindingIndex === null) continue;
      proposals.add(`${comment.aiJobId}:${comment.aiFindingIndex}`);
    }
    return proposals;
  }, [discussion.data?.comments]);
  const publishedProviderThreadIds = useMemo(() => {
    const externalIds = new Set<string>();
    for (const comment of discussion.data?.comments ?? []) {
      if (comment.providerExternalId) {
        externalIds.add(comment.providerExternalId);
      }
    }
    return externalIds;
  }, [discussion.data?.comments]);
  const publishedCommentsByLine = useMemo(() => {
    const byLine = new Map<
      number,
      NonNullable<typeof discussion.data>["comments"]
    >();
    for (const comment of discussion.data?.comments ?? []) {
      if (comment.status !== "published" || comment.source !== "user") continue;
      // A comment that opened a conversation the line already renders would
      // otherwise appear twice, once on its own and once inside the thread.
      if (
        comment.providerExternalId &&
        groupedEntries(providerThreadsByLine, comment.line).some(
          ({ externalId }) => externalId === comment.providerExternalId,
        )
      ) {
        continue;
      }
      const group = byLine.get(comment.line) ?? [];
      group.push(comment);
      byLine.set(comment.line, group);
    }
    return byLine;
  }, [discussion.data?.comments, providerThreadsByLine]);
  const aiQuestionGroupsByLine = useMemo(() => {
    const liveJobIds = new Set(liveAiQuestions.map(({ jobId }) => jobId));
    // Persisted questions lead each line's conversation, live ones close it.
    const anchored = [
      ...(aiQuestions.data ?? [])
        .filter((question) => !liveJobIds.has(question.id))
        .map((question) => ({
          entry: {
            error: question.error,
            id: question.id,
            jobId: question.id,
            question: question.question,
            result: question.result
              ? {
                  summary: question.result.summary,
                  commentProposals: question.result.commentProposals?.map(
                    (proposal, index) => ({
                      ...proposal,
                      published: publishedAiProposals.has(
                        `${question.id}:${index}`,
                      ),
                    }),
                  ),
                }
              : null,
            status: question.status,
            threadId: question.conversationId,
          },
          line: question.focusLine,
        })),
      ...liveAiQuestions.map((question) => ({
        entry: {
          error: question.error,
          id: question.id,
          jobId: question.jobId,
          progress: question.progress,
          question: question.question,
          result: question.result,
          status: question.status,
          threadId: question.threadId,
        },
        line: question.focusLine,
      })),
    ];
    const byLine = new Map<
      number,
      Map<string, (typeof anchored)[number]["entry"][]>
    >();
    for (const { entry, line } of anchored) {
      if (line === null) continue;
      let groups = byLine.get(line);
      if (!groups) {
        groups = new Map();
        byLine.set(line, groups);
      }
      const group = groups.get(entry.threadId) ?? [];
      group.push(entry);
      groups.set(entry.threadId, group);
    }
    return byLine;
  }, [aiQuestions.data, liveAiQuestions, publishedAiProposals]);
  const publishedFindingIds = useMemo(
    () => new Set(deepReview.data?.publishedFindingIds ?? []),
    [deepReview.data?.publishedFindingIds],
  );
  const pullReviewRequested = useRef(false);
  useEffect(() => {
    // The automatic review trigger is entirely client-side; there is no server
    // counterpart. Ungated, an unentitled account with the preference on gets a
    // refused mutation on every pull-request page load.
    if (
      aiConfiguration.data?.deepReviewAvailable &&
      aiConfiguration.data.reviewPullRequests &&
      aiConfiguration.data.mode !== "off" &&
      !pullRequestReview.isLoading &&
      !pullRequestReview.data &&
      !startPullRequestReview.isPending &&
      !pullReviewRequested.current
    ) {
      pullReviewRequested.current = true;
      startPullRequestReview.mutate({
        pullRequestId: initialData.pullRequest.id,
        kind: "review",
      });
    }
  }, [
    aiConfiguration.data?.deepReviewAvailable,
    aiConfiguration.data?.mode,
    aiConfiguration.data?.reviewPullRequests,
    initialData.pullRequest.id,
    pullRequestReview.data,
    pullRequestReview.isLoading,
    startPullRequestReview,
  ]);
  useEffect(() => {
    if (!activeUnitId) return;
    setSelectedLine(undefined);
    commentDraft.current = "";
    setAiQuestionLine(undefined);
    setAiQuestionThreadId(undefined);
    setFocusAiQuestionComposer(false);
    setAiQuestionPreviewLine(undefined);
    setExplanationLine(undefined);
    aiQuestionDraft.current = "";
  }, [
    activeUnitId,
    setAiQuestionThreadId,
    setFocusAiQuestionComposer,
    setAiQuestionLine,
    setAiQuestionPreviewLine,
  ]);
  // Declared after the reset above so it runs after it in the same commit: a
  // line picked in another member's card survives the switch that opens it.
  useEffect(() => {
    if (!pendingCommentLine || pendingCommentLine.unitId !== activeUnitId) {
      return;
    }
    setPendingCommentLine(undefined);
    openInlineComment(pendingCommentLine.line);
  }, [activeUnitId, openInlineComment, pendingCommentLine]);
  // The two state dependencies cause a fresh render after selecting the line's
  // owning unit, so this intentionally calls that render's question opener.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the opener is render-local and the pending selection owns this effect
  useEffect(() => {
    if (
      !pendingAiQuestionLine ||
      pendingAiQuestionLine.unitId !== activeUnitId
    ) {
      return;
    }
    setPendingAiQuestionLine(undefined);
    openAiQuestionAt(pendingAiQuestionLine.line);
  }, [activeUnitId, pendingAiQuestionLine]);
  useEffect(() => {
    if (!importPreview) return;
    importPreviewFocusRef.current?.scrollIntoView({ block: "center" });
    /** Closes the active review overlay when Escape is pressed. */
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setImportPreview(undefined);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [importPreview]);
  useTerminalReviewRefetch(pullRequestReview.data?.status, {
    aiUsage,
    deepReview,
    discussion,
  });
  const { refetch: refetchAiUsage } = aiUsage;
  useEffect(() => {
    if (aiStatus.data?.status === "completed") {
      void refetchAiUsage();
    }
  }, [aiStatus.data?.status, refetchAiUsage]);
  const autoRequested = useRef(new Set<string>());
  useEffect(() => {
    if (
      activeUnit &&
      settledActiveUnitId === activeUnit.id &&
      aiConfiguration.data?.mode === "automatic" &&
      !aiStatus.isLoading &&
      !aiStatus.data &&
      !startExplanation.isPending &&
      !autoRequested.current.has(activeUnit.id)
    ) {
      autoRequested.current.add(activeUnit.id);
      startExplanation.mutate({
        pullRequestId: initialData.pullRequest.id,
        unitId: activeUnit.id,
        kind: "explain",
      });
    }
  }, [
    activeUnit,
    aiConfiguration.data?.mode,
    aiStatus.data,
    aiStatus.isLoading,
    initialData.pullRequest.id,
    settledActiveUnitId,
    startExplanation,
  ]);

  const openCommands = useCallback(() => setCommandCenterMode("commands"), []);
  const openShortcuts = useCallback(
    () => setCommandCenterMode("shortcuts"),
    [],
  );
  const nextQueueEntry = pathSections.upcoming[0];
  const activeConceptSignOffPending = Boolean(
    activeConcept && pendingConceptSignOffIds.has(activeConcept.id),
  );
  const activeSignOffPending = activeUnit
    ? signOffQueue.ids.has(activeUnit.id) || activeConceptSignOffPending
    : false;
  const activeConceptSourcesAvailable = activeConceptMembers.every(
    (unit) => unit.kind === "binary" || hydratedUnitIds.has(unit.id),
  );
  const deletedUnitsToSignOff = useMemo(
    () => deletedFileSignOffUnits(units, fileContexts),
    [fileContexts, units],
  );
  const canSignOffDeletedFiles =
    activeFileIsDeleted &&
    deletedUnitsToSignOff.length > 0 &&
    deletedUnitsToSignOff.every((unit) => hydratedUnitIds.has(unit.id)) &&
    !resetReview.isPending;
  const pendingSignOffCount =
    signOffQueue.ids.size + pendingConceptSignOffIds.size;
  const signOffQueueProgress = `${signOffQueue.completed}/${signOffQueue.total}`;
  const backgroundSaveProgress =
    pendingConceptSignOffIds.size > 0
      ? `${pendingSignOffCount} pending`
      : signOffQueueProgress;
  const footerSaveState = reviewFooterSaveState({
    activeSavePending: activeSignOffPending,
    pendingSaveCount: pendingSignOffCount,
    reviewComplete,
  });
  const completionVisible =
    reviewComplete && completionOpen && footerSaveState === "idle";
  const waitingCompletionVisible =
    reviewCaughtUp && waitingCompletionOpen && footerSaveState === "idle";
  const completionChromeHidden = completionVisible || waitingCompletionVisible;
  useEffect(() => {
    if (completionChromeHidden) setDiscussionsOpen(false);
  }, [completionChromeHidden]);
  const openPullRequests = useCallback(
    () => navigate("/pullrequests"),
    [navigate],
  );
  const openNextReview = useCallback(() => {
    if (nextReview) navigate(`/review/${nextReview.id}`);
  }, [nextReview, navigate]);
  /** Changes only the workspace projection and preserves the review ledger. */
  function changeReviewMode(mode: ReviewMode) {
    setReviewMode(mode);
    rememberReviewMode(window.localStorage, mode);
    if (mode === "path") setCompletedBrowsing(false);
  }

  /** Leaves the completion page so the reviewer can inspect signed-off files. */
  function browseCompletedReview() {
    setReviewMode("files");
    setCompletionOpen(false);
    setCompletedBrowsing(true);
    showPathPanel();
    sendReviewSession({ type: "REVIEW_BROWSED" });
  }
  useEffect(() => {
    if (!completionVisible && !waitingCompletionVisible) return;

    /** Dismisses either end state while preserving the review beneath it. */
    function dismissEndState(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (completionVisible) {
        setReviewMode("files");
        setCompletionOpen(false);
        setCompletedBrowsing(true);
        setPathPanelCollapsed(false);
        if (!window.matchMedia("(min-width: 1536px)").matches) {
          setInsightsPanelOpen(false);
          setInsightsPanelCollapsed(true);
          setPathPanelOpen(true);
        }
        sendReviewSession({ type: "REVIEW_BROWSED" });
      }
      if (waitingCompletionVisible) setWaitingCompletionOpen(false);
    }

    document.addEventListener("keydown", dismissEndState);
    return () => document.removeEventListener("keydown", dismissEndState);
  }, [
    completionVisible,
    waitingCompletionVisible,
    setPathPanelOpen,
    setPathPanelCollapsed,
    setInsightsPanelOpen,
    setInsightsPanelCollapsed,
  ]);
  const canUseAi =
    aiConfiguration.data?.mode !== "off" &&
    !explanationRunning &&
    !!activeUnit &&
    settledActiveUnitId === activeUnit.id &&
    activeUnit.kind !== "binary";
  const canAskAi =
    aiConfiguration.data?.mode !== "off" &&
    !aiQuestionRunning &&
    !!activeUnit &&
    settledActiveUnitId === activeUnit.id &&
    activeUnit.kind !== "binary";
  const awaitPending = awaitResponse.isPending;
  // A wait names one unit. Sibling members stay reviewable, so the open
  // card's own status is what every "is this waiting?" check reads.
  const activeWaitStatus = activeUnit?.status;
  const activeUnitAnswered =
    activeWaitStatus === "waiting" &&
    Boolean(
      activeUnit &&
        waitingReviewUnits.some(
          (unit) => unit.id === activeUnit.id && unit.answered,
        ),
    );
  // A concept action needs a layout to name, and a concept of one member is
  // its unit — there the two levels collapse into a single action.
  const conceptActionAvailable = Boolean(
    activeConcept &&
      initialData.conceptLayout &&
      activeConceptMembers.length > 1,
  );
  const cardActionAvailable = activeFileCardMembers.length > 1;
  const outstandingCardMembers = activeFileCardMembers.filter(
    ({ status }) => status !== "signed_off" && status !== "waiting",
  );
  const reviewActionBlocked =
    !activeUnit ||
    reviewComplete ||
    activeWaitStatus === "waiting" ||
    activeSignOffPending ||
    undoSignOff.isPending ||
    undoConcept.isPending ||
    awaitPending ||
    resetReview.isPending;
  const fileSignOffBlocked =
    !activeUnit ||
    reviewComplete ||
    activeSignOffPending ||
    undoSignOff.isPending ||
    undoConcept.isPending ||
    awaitPending ||
    resetReview.isPending;
  // One unit needs only its own source; the concept needs every member's,
  // because it records all of them at once.
  const canSignOffUnit =
    !reviewActionBlocked &&
    activeSourceAvailable &&
    activeUnit.status !== "signed_off";
  const canSignOffCard =
    !reviewActionBlocked &&
    cardActionAvailable &&
    activeFileCardSourceAvailable &&
    outstandingCardMembers.length > 0;
  const canSignOffConcept =
    !reviewActionBlocked &&
    conceptActionAvailable &&
    activeConceptSourcesAvailable &&
    activeConceptProgress?.status !== "signed_off";
  const outstandingFileMembersForSignOff = activeFileCardMembers.filter(
    (unit) => unit.status !== "signed_off" && unit.status !== "waiting",
  );
  const activeFileOutstandingSourceAvailable =
    outstandingFileMembersForSignOff.length > 0 &&
    outstandingFileMembersForSignOff.every(
      (member) => member.kind === "binary" || hydratedUnitIds.has(member.id),
    );
  const canSignOffActiveFile =
    reviewMode === "files" &&
    !!activeReviewFile &&
    activeReviewFile.totalUnits > 0 &&
    activeFileOutstandingUnits > 0 &&
    activeFileOutstandingSourceAvailable &&
    !fileSignOffBlocked;
  const fileWaitingUnitIds =
    reviewMode === "files" && activeReviewFile
      ? waitingReviewFileUnits(activeReviewFile).map(({ id }) => id)
      : [];
  const fileIsFullyWaiting =
    reviewMode === "files" &&
    !!activeReviewFile &&
    activeFileOutstandingUnits === 0 &&
    fileWaitingUnitIds.length > 0;
  const canUsePrimaryAction = fileIsFullyWaiting
    ? !awaitPending
    : activeWaitStatus === "signed_off" ||
        (activeWaitStatus === "waiting" && !canSignOffActiveFile)
      ? !!activeUnit &&
        !reviewComplete &&
        !activeSignOffPending &&
        !undoSignOff.isPending &&
        !undoConcept.isPending &&
        !awaitPending &&
        !resetReview.isPending &&
        // Continue only exists when it has somewhere actionable to go. A
        // review that is only waiting belongs to the caught-up state instead
        // of a no-op button.
        hasNextActionableUnit
      : reviewMode === "files"
        ? canSignOffActiveFile
        : cardActionAvailable
          ? canSignOffCard
          : canSignOffUnit;
  const primaryIsContinue =
    !fileIsFullyWaiting &&
    !canSignOffActiveFile &&
    (activeWaitStatus === "signed_off" || activeWaitStatus === "waiting");
  // The scope the plain key commits to, named the same way wherever it is
  // read: the footer, and the command centre entry that carries it.
  const primaryScopeLabel = fileIsFullyWaiting
    ? `Resume waiting (${fileWaitingUnitIds.length})`
    : primaryIsContinue
      ? filteredReviewActive
        ? "Next match"
        : "Continue"
      : reviewMode === "files" && activeReviewFile
        ? `Sign off file (${activeFileOutstandingUnits})`
        : cardActionAvailable
          ? `Sign off card (${outstandingCardMembers.length})`
          : "Sign off";
  const primaryActionLabel = activeConceptSignOffPending
    ? "Saving concept…"
    : activeSignOffPending
      ? `Saving ${signOffQueueProgress}…`
      : primaryScopeLabel;
  const canAwaitResponse =
    !!activeUnit &&
    hasLiveConversation &&
    activeWaitStatus !== "waiting" &&
    !awaitPending &&
    !activeSignOffPending;
  const canAwaitUnit = canAwaitResponse && activeUnitHasConversation;
  const heldWaitUnitIds =
    fileWaitingUnitIds.length > 0
      ? fileWaitingUnitIds
      : activeUnit?.status === "waiting"
        ? [activeUnit.id]
        : [];
  const canStopWaiting = heldWaitUnitIds.length > 0 && !awaitPending;
  const undoableSignOff = nextUndoableSignOff(signOffUndoHistory, units);
  const canUndoSignOff =
    !!undoableSignOff &&
    // Both ways a sign-off is saved mark their units optimistically, so undo
    // waits for the save it would otherwise race: the queue drains unit
    // sign-offs, and a concept sign-off is one request of its own.
    signOffQueue.ids.size === 0 &&
    pendingConceptSignOffIds.size === 0 &&
    !undoSignOff.isPending &&
    !undoConcept.isPending &&
    !resetReview.isPending;

  /** Starts an AI explanation for the active review unit. */
  function explainActiveUnit() {
    if (!activeUnit || !canUseAi) return;
    startExplanation.mutate({
      pullRequestId: initialData.pullRequest.id,
      unitId: activeUnit.id,
      kind: "explain",
    });
  }

  /** Opens an inline question at the visible in-scope line nearest the reader. */
  function openAiQuestion() {
    if (!activeUnit || activeUnit.kind === "binary") return;
    openAiQuestionAt(centredReviewLine());
  }

  /**
   * Names the review line sitting closest to the middle of the code pane.
   *
   * Both keyboard entry points anchor themselves here, so asking about a line
   * and commenting on one land where the reviewer is already reading instead
   * of wherever the last interaction left a cursor.
   */
  function centredReviewLine() {
    const pane = codeScrollRef.current;
    const center = pane
      ? pane.getBoundingClientRect().top + pane.clientHeight / 2
      : window.innerHeight / 2;
    // Each line is measured once: a comparator that measured would force a
    // layout read on every comparison the sort makes.
    const nearest = Array.from(
      document.querySelectorAll<HTMLElement>('[id^="review-line-"]'),
    )
      .flatMap((element) => {
        const line = Number(element.id.replace("review-line-", ""));
        if (!Number.isInteger(line) || !isPrimaryReviewLine(line)) return [];
        const bounds = element.getBoundingClientRect();
        return [
          {
            distance: Math.abs(center - (bounds.top + bounds.height / 2)),
            line,
          },
        ];
      })
      .sort((left, right) => left.distance - right.distance)[0]?.line;
    const firstChangedLine = [...changedCurrentLines]
      .filter(isPrimaryReviewLine)
      .sort((left, right) => left - right)[0];
    return nearest ?? firstChangedLine ?? primaryReviewStart;
  }

  /** Opens the provider comment composer on the line the reviewer is reading. */
  function openCentredInlineComment() {
    if (!activeUnit || activeUnit.kind === "binary") return;
    commentOnCardLine(
      closestReviewLine(
        centredReviewLine(),
        primaryReviewRanges,
        primaryReviewStart,
        primaryReviewEnd,
      ),
    );
  }

  /** Opens the inline AI conversation anchored to one chosen review line. */
  function openAiQuestionAt(line: number) {
    if (!activeUnit || activeUnit.kind === "binary") return;
    dismissedAiQuestionUnits.current.delete(activeUnit.id);
    setSelectedLine(undefined);
    setKeyboardLine(undefined);
    positionAiQuestion(line);
  }

  /** Sends the current line-focused question to the AI stream controller. */
  function askAiQuestion(rawQuestion: string) {
    const threadId = aiQuestionThreadId ?? crypto.randomUUID();
    const startedThreadId = askQuestion({
      canAsk: canAskAi,
      focusLine: aiQuestionLine,
      question: rawQuestion,
      threadId,
      unitId: activeUnit?.id,
    });
    if (startedThreadId && !aiQuestionThreadId) {
      setAiQuestionThreadId(startedThreadId);
    }
    return Boolean(startedThreadId);
  }

  /** Starts a complete evidence-based review of the pull request. */
  function reviewPullRequestWithAi() {
    if (reviewRunning) return;
    setAiReviewDialogOpen(false);
    startPullRequestReview.mutate({
      pullRequestId: initialData.pullRequest.id,
      kind: "review",
    });
  }

  /** Asks the model to regroup this layout once the reviewer has agreed. */
  function improveGroupingWithAi() {
    if (groupingImproving || !initialData.conceptLayout) return;
    setConceptGroupingDialogOpen(false);
    setConceptLayoutAction("improve");
    improveConceptGrouping.mutate({
      pullRequestId: initialData.pullRequest.id,
      layoutId: initialData.conceptLayout.id,
      layoutVersion: initialData.conceptLayout.version,
    });
  }

  /** Splits the active concept into atomic personal-layout concepts. */
  function splitActiveConcept() {
    if (
      !activeConcept ||
      activeConcept.memberIds.length < 2 ||
      !initialData.snapshot ||
      !initialData.conceptLayout ||
      conceptLayoutLocked
    ) {
      return;
    }
    setSplitConceptDialogOpen(false);
    setConceptLayoutAction("split");
    replaceConceptLayout.mutate({
      pullRequestId: initialData.pullRequest.id,
      snapshotId: initialData.snapshot.id,
      expectedVersion: initialData.conceptLayout.version,
      source: "manual",
      concepts: initialData.concepts.flatMap((concept) =>
        concept.id === activeConcept.id
          ? concept.memberIds.map((memberId) => {
              const member = units.find(({ id }) => id === memberId);
              return {
                title: member?.name ?? "Review change",
                rationale: `Manually split from ${activeConcept.title}.`,
                memberUnitIds: [memberId],
              };
            })
          : [
              {
                title: concept.title,
                rationale: concept.rationale ?? undefined,
                memberUnitIds: concept.memberIds,
              },
            ],
      ),
    });
  }

  /** Moves the active atomic member into the concept the reviewer picked. */
  function moveActiveMemberToConcept(targetConceptId: string) {
    if (
      !activeUnit ||
      !activeConcept ||
      initialData.concepts.length < 2 ||
      !initialData.snapshot ||
      !initialData.conceptLayout ||
      conceptLayoutLocked
    ) {
      return;
    }
    const target = initialData.concepts.find(
      ({ id }) => id === targetConceptId,
    );
    if (!target || target.id === activeConcept.id) return;
    setMoveMemberDialogOpen(false);
    setConceptLayoutAction("move");
    replaceConceptLayout.mutate({
      pullRequestId: initialData.pullRequest.id,
      snapshotId: initialData.snapshot.id,
      expectedVersion: initialData.conceptLayout.version,
      source: "manual",
      concepts: initialData.concepts.flatMap((concept) => {
        if (concept.id === activeConcept.id) {
          const remaining = concept.memberIds.filter(
            (id) => id !== activeUnit.id,
          );
          return remaining.length > 0
            ? [
                {
                  title: concept.title,
                  rationale: concept.rationale ?? undefined,
                  memberUnitIds: remaining,
                },
              ]
            : [];
        }
        return [
          {
            title: concept.title,
            rationale:
              concept.id === target.id
                ? `Manually includes ${activeUnit.name}.`
                : (concept.rationale ?? undefined),
            memberUnitIds:
              concept.id === target.id
                ? [...concept.memberIds, activeUnit.id]
                : concept.memberIds,
          },
        ];
      }),
    });
  }

  /** Runs the status-appropriate action for the active review unit. */
  function runPrimaryAction() {
    if (!activeUnit || !canUsePrimaryAction) return;
    if (fileIsFullyWaiting) {
      stopWaitingOnActive();
      return;
    }
    if (activeWaitStatus === "signed_off" || activeWaitStatus === "waiting") {
      if (canSignOffActiveFile && activeReviewFile) {
        toggleReviewFile(activeReviewFile);
        return;
      }
      continueReview();
      return;
    }
    if (reviewMode === "files" && activeReviewFile) {
      toggleReviewFile(activeReviewFile);
      return;
    }
    if (cardActionAvailable) {
      signOffActiveCard();
      return;
    }
    signOffActiveUnit();
  }

  /** Records every outstanding atomic unit represented by the open file card. */
  function signOffActiveCard() {
    if (!canSignOffCard || outstandingCardMembers.length === 0) return;
    const activeDuration = Math.round((Date.now() - startedAt) / 1000);
    const memberIds = new Set(activeConcept?.memberIds ?? []);
    optimisticallyQueueSignOffs(
      outstandingCardMembers.map((member) => ({
        unitId: member.id,
        sessionId,
        durationSeconds: member.id === activeUnit?.id ? activeDuration : 0,
      })),
      (unit) => memberIds.has(unit.id),
    );
  }

  /**
   * Records the open unit and moves on to the next one in its concept.
   *
   * The concept is read one member at a time, so the unit the reviewer just
   * finished is the natural thing to record: the next member is preferred over
   * the canonical order, which keeps a concept together instead of scattering
   * a reviewer across the pull request between its members.
   */
  function signOffActiveUnit() {
    if (!activeUnit || !canSignOffUnit) return;
    const memberIds = new Set(activeConcept?.memberIds ?? []);
    optimisticallyQueueSignOffs(
      [
        {
          unitId: activeUnit.id,
          sessionId,
          durationSeconds: Math.round((Date.now() - startedAt) / 1000),
        },
      ],
      (unit) => memberIds.has(unit.id),
    );
  }

  /** Records every member of the open concept in one go. */
  function signOffActiveConcept() {
    if (!canSignOffConcept || !activeConcept || !initialData.conceptLayout) {
      return;
    }
    const concept = activeConcept;
    const layout = initialData.conceptLayout;
    const previousMembers = units.filter((unit) =>
      concept.memberIds.includes(unit.id),
    );
    const view = reviewViewSnapshot({ unitIndex: activeIndex });
    const updated = optimisticallySignOffReviewUnits(units, concept.memberIds);
    const nextIndex = nextReviewIndexAfterAction(updated);
    setSignOffUndoHistory((history) =>
      rememberSignOff(history, {
        kind: "concept",
        conceptId: concept.id,
        label: concept.title,
        layoutId: layout.id,
        layoutVersion: layout.version,
        unitIds: concept.memberIds,
        view,
      }),
    );
    setPendingConceptSignOffIds((current) => new Set(current).add(concept.id));
    setUnits(updated);
    if (nextIndex >= 0) setActiveIndex(nextIndex);
    setQueueLimit(INITIAL_PATH_ITEMS);
    setShowDiff(true);
    setContextBefore(0);
    setContextAfter(0);
    codeScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    setStartedAt(Date.now());

    void signOffConcept
      .mutateAsync({
        conceptId: concept.id,
        layoutId: layout.id,
        layoutVersion: layout.version,
        sessionId,
        durationSeconds: Math.round((Date.now() - startedAt) / 1000),
      })
      .then(({ signedUnitIds }) => {
        void Promise.all([
          utils.workspace.guidance.invalidate(),
          utils.review.dashboard.invalidate(),
          utils.review.gamification.invalidate(),
        ]);
        toast.success("Review concept signed off", {
          description: `${signedUnitIds.length} atomic ${signedUnitIds.length === 1 ? "unit" : "units"} recorded together.`,
        });
      })
      .catch((error: Error) => {
        setUnits((current) =>
          previousMembers.reduce(
            (restored, original) =>
              restoreReviewUnitAfterFailedSignOff(restored, original),
            current,
          ),
        );
        setSignOffUndoHistory((history) => {
          const index = history.findIndex(
            (entry) =>
              entry.kind === "concept" && entry.conceptId === concept.id,
          );
          return index < 0
            ? history
            : history.filter((_entry, entryIndex) => entryIndex !== index);
        });
        restoreReviewView(view, concept.memberIds);
        toast.error("Concept sign-off was not saved", {
          description: `Returned to ${concept.title}. ${error.message}`,
        });
      })
      .finally(() => {
        setPendingConceptSignOffIds((current) => {
          const pending = new Set(current);
          pending.delete(concept.id);
          return pending;
        });
      });
  }

  /** Captures where the reviewer is, so undoing a sign-off can return there. */
  function reviewViewSnapshot(
    at: { unitIndex: number } & Partial<ReviewViewSnapshot>,
  ): ReviewViewSnapshot {
    return {
      contextAfter: at.contextAfter ?? contextAfter,
      contextBefore: at.contextBefore ?? contextBefore,
      pathSearch: at.pathSearch ?? pathSearch,
      scrollTop: at.scrollTop ?? codeScrollRef.current?.scrollTop ?? 0,
      searchLimit: at.searchLimit ?? searchLimit,
      showDiff: at.showDiff ?? showDiff,
      unitIndex: at.unitIndex,
    };
  }

  /**
   * Puts the reviewer back in front of the unit a sign-off was made from.
   *
   * The recorded position is an index into the list as it stood, and a resync
   * or a regrouping can shorten that list. The units the step named are what
   * still identify the place, so the index is only honoured while it points at
   * one of them.
   */
  function restoreReviewView(view: ReviewViewSnapshot, unitIds: string[]) {
    const surviving = unitIds.flatMap((unitId) => {
      const index = units.findIndex(({ id }) => id === unitId);
      return index >= 0 ? [index] : [];
    });
    setActiveIndex(
      surviving.includes(view.unitIndex)
        ? view.unitIndex
        : (surviving[0] ??
            Math.min(
              Math.max(0, view.unitIndex),
              Math.max(0, units.length - 1),
            )),
    );
    if (view.pathSearch.trim()) {
      setPathSearch((current) => (current.trim() ? current : view.pathSearch));
      setSearchLimit(view.searchLimit);
    }
    setShowDiff(view.showDiff);
    setContextBefore(view.contextBefore);
    setContextAfter(view.contextAfter);
    setStartedAt(Date.now());
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        codeScrollRef.current?.scrollTo({
          top: view.scrollTop,
          behavior: "auto",
        });
      }),
    );
  }

  /**
   * Takes back the most recent sign-off that still stands.
   *
   * Sign-offs are saved through a queue, so undo waits for that queue to
   * drain rather than racing a save it would have to undo twice. Steps whose
   * units a resync removed, or which some other action already returned to
   * the queue, are dropped instead of replayed.
   */
  async function undoLastSignOff() {
    // A mutation's pending flag only reaches this closure on the next render,
    // so a held shortcut would otherwise take the same step back twice.
    if (!undoableSignOff || !canUndoSignOff || undoInFlight.current) return;
    undoInFlight.current = true;
    setUndoPending(true);
    const { entry, remaining } = undoableSignOff;
    setSignOffUndoHistory(remaining);
    restoreReviewView(entry.view, entry.unitIds);
    const target = signOffUndoTarget(
      entry,
      initialData.conceptLayout ?? undefined,
    );
    try {
      if (target.kind === "concept") {
        await undoConcept.mutateAsync({ ...target, sessionId });
        return;
      }
      // A step that names several units is one undo to the reviewer, so only
      // the request for the last of them speaks.
      for (const unitId of target.unitIds.slice(0, -1)) {
        quietUndoUnitIds.current.add(unitId);
      }
      // The requests name distinct units and do not depend on each other, so
      // they go out together and the step comes back in one frame. Every one
      // of them has to settle before the quiet marks are dropped, so a
      // failure among them cannot let the rest each announce themselves.
      const undos = await Promise.allSettled(
        target.unitIds.map((unitId) =>
          undoSignOff.mutateAsync({ unitId, sessionId }),
        ),
      );
      for (const undo of undos) {
        if (undo.status === "rejected") throw undo.reason;
      }
    } catch {
      // The mutation owns the user-facing error. The step goes back on the
      // history so the reviewer can take it back again rather than being left
      // with a sign-off standing and nothing left to undo it from.
      setSignOffUndoHistory((history) => rememberSignOff(history, entry));
    } finally {
      // A request that failed leaves its unit marked quiet, and the next undo
      // of that unit would otherwise succeed without saying so.
      quietUndoUnitIds.current.clear();
      undoInFlight.current = false;
      setUndoPending(false);
    }
  }

  /** Pauses the open unit until its own conversation moves. */
  function awaitActiveUnit() {
    if (!activeUnit || !canAwaitUnit) return;
    awaitResponse.mutate({ unitId: activeUnit.id });
  }

  /** Pauses the open unit until its conversation or code changes. */
  function awaitActiveResponse() {
    awaitActiveUnit();
  }

  /** Signs off every outstanding unit from files removed by this pull request. */
  function signOffDeletedFiles() {
    if (!canSignOffDeletedFiles) return;
    const activeDuration = Math.round((Date.now() - startedAt) / 1000);
    optimisticallyQueueSignOffs(
      deletedUnitsToSignOff.map((unit) => ({
        unitId: unit.id,
        sessionId,
        durationSeconds: unit.id === activeUnit?.id ? activeDuration : 0,
      })),
      (unit) => unit.changeType !== "deleted",
    );
  }

  /**
   * Gives back the wait the open unit is holding.
   *
   * Only the reviewer releases a wait: when the provider answers, the
   * workspace marks the unit as answered and this same action resumes it
   * with the response still on screen. It equally frees a unit paused by
   * mistake or answered somewhere the poll cannot see.
   */
  function stopWaitingOnActive() {
    if (!canStopWaiting) return;
    releaseReviewWaits.mutate({ unitIds: heldWaitUnitIds });
  }

  /** Opens a unit selected from the waiting room. */
  function openWaitingUnit(unitId: string) {
    const index = unitIndexById.get(unitId) ?? -1;
    if (index < 0) return;
    setWaitingCompletionOpen(false);
    setWaitingExpanded(true);
    selectUnit(index);
  }

  /** Returns one waiting unit to the actionable review path. */
  function stopWaitingOnUnit(unitId: string) {
    releaseReviewWaits.mutate({ unitIds: [unitId] });
  }

  /** Returns the active signed-off unit to the pending review queue. */
  function unreviewActiveUnit() {
    if (
      activeConcept &&
      initialData.conceptLayout &&
      activeConceptProgress?.status === "signed_off"
    ) {
      undoConcept.mutate({
        conceptId: activeConcept.id,
        layoutId: initialData.conceptLayout.id,
        layoutVersion: initialData.conceptLayout.version,
        sessionId,
      });
      return;
    }
    if (activeUnit?.status !== "signed_off") return;
    undoSignOff.mutate({
      unitId: activeUnit.id,
      sessionId,
    });
  }

  /** Reports whether a finding already reached the pull request. */
  function findingPublished(finding: DeepReviewFinding) {
    // Two readings of one fact keyed the same way: the run-wide set tells the
    // truth about every file at once, and the per-unit discussion refetches
    // the instant a publish succeeds.
    return (
      publishedFindingIds.has(finding.id) ||
      (discussion.data?.comments.some(
        (comment) =>
          comment.aiJobId === deepReview.data?.jobId &&
          comment.aiFindingIndex === finding.orderIndex &&
          comment.status === "published",
      ) ??
        false)
    );
  }

  /** Opens inline commenting at the first eligible source line. */
  function beginKeyboardComment() {
    if (!activeUnit) return;
    const firstChangedLine = [...changedCurrentLines]
      .filter(isPrimaryReviewLine)
      .sort((left, right) => left - right)[0];
    setKeyboardLine(selectedLine ?? firstChangedLine ?? primaryReviewStart);
    setSelectedLine(undefined);
    commentDraft.current = "";
  }

  /** Moves keyboard focus to the review-path search field. */
  function focusReviewSearch() {
    const search = pathSearchRef.current;
    if (search && search.offsetParent !== null) {
      search.focus();
      return;
    }
    openCommands();
  }

  /**
   * Reveals the next page of source preceding the reviewed unit.
   *
   * The side-by-side view pages its own rows, so it is offered the reveal
   * first and the surrounding-source counter only moves when it declines.
   * One shortcut then means the same thing in either view.
   */
  function revealContextAbove() {
    if (diffContextRef.current?.revealContext(-1)) return;
    setContextBefore((current) =>
      Math.min(current + CONTEXT_PAGE_LINES, availableBefore),
    );
  }

  /** Reveals the next page of source following the reviewed unit. */
  function revealContextBelow() {
    if (diffContextRef.current?.revealContext(1)) return;
    setContextAfter((current) =>
      Math.min(current + CONTEXT_PAGE_LINES, availableAfter),
    );
  }

  /**
   * Scrolls the code viewport.
   *
   * Revealing surrounding context is deliberately left to its own controls: a
   * concept shows many atomic units at once, and expanding one of them because
   * the reader happened to reach an edge made a unit appear to contain code
   * that belongs to the next one.
   */
  function scrollCode(direction: -1 | 1) {
    codeScrollRef.current?.scrollBy({ top: direction * 72, behavior: "auto" });
  }

  /** Renders direct AI controls without hiding their distinct scopes in a menu. */
  function renderAiActionButtons() {
    const aiDisabled = aiConfiguration.data?.mode === "off";
    return (
      <div
        className={cn(
          "grid w-full gap-2",
          deepReviewAvailable ? "grid-cols-2" : "grid-cols-1",
        )}
      >
        <Button
          type="button"
          variant="secondary"
          className="min-w-0 px-2.5"
          disabled={aiDisabled || !activeUnit || activeUnit.kind === "binary"}
          onClick={openAiQuestion}
        >
          <MessageSquareText className="size-3.5 shrink-0" />
          <span className="truncate">Ask</span>
          <ShortcutHint
            shortcut={reviewShortcuts.askAi}
            className="ml-auto hidden sm:inline-flex"
          />
        </Button>
        {deepReviewAvailable && (
          <Button
            type="button"
            variant="secondary"
            className="min-w-0 px-2.5"
            disabled={aiDisabled || reviewRunning}
            onClick={() => setAiReviewDialogOpen(true)}
          >
            {reviewRunning ? (
              <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
            ) : (
              <Sparkles className="size-3.5 shrink-0" />
            )}
            <span className="truncate">
              {reviewRunning ? "Reviewing…" : "Review"}
            </span>
            <ShortcutHint
              shortcut={reviewShortcuts.reviewPullRequest}
              className="ml-auto hidden sm:inline-flex"
            />
          </Button>
        )}
      </div>
    );
  }

  /**
   * Opens the author's own account of the change beside the AI controls.
   *
   * The wide panel names the control, because an unlabelled icon under an
   * "AI assistance" heading reads as an explanation of that heading rather
   * than of the pull request.
   */
  function renderPullRequestDetailsButton({
    className,
    label,
  }: {
    className: string;
    label?: string;
  }) {
    return (
      <button
        type="button"
        aria-label="About this pull request"
        title="About this pull request"
        onClick={() => setPullRequestDetailsOpen(true)}
        className={cn(
          "text-mist hover:text-cloud flex shrink-0 items-center justify-center gap-1.5 rounded-lg transition hover:bg-surface-hover",
          className,
        )}
      >
        <Info className="size-4 shrink-0" />
        {label}
      </button>
    );
  }

  /** Renders the deep review's terminal state, coverage, and findings. */
  function renderDeepReviewPanel() {
    const run = deepReview.data;
    if (!run) {
      return reviewRunning ? (
        <section
          aria-label="Deep review"
          className="mt-5 border-t border-line pt-4"
        >
          <p className="text-violet text-[10px] leading-4">
            Deep review is starting. Coverage appears once the file plan is
            sealed.
          </p>
        </section>
      ) : null;
    }
    const findings = run.findings;
    // The open finding stays open when a filter change would hide it: the
    // reviewer is mid-judgement on that claim, and a filter is not a verdict.
    const activeFindingHidden = Boolean(
      activeFindingId &&
        !visibleFindings.some(({ id }) => id === activeFindingId),
    );
    // Falls back to the first row when the open finding is filtered out, or
    // Tab would find no stop at all and the list would stop being reachable.
    const rovingFindingId = activeFindingHidden
      ? visibleFindings[0]?.id
      : (activeFindingId ?? visibleFindings[0]?.id);
    const running = aiJobActive(run.status);
    const terminal = run.terminalState
      ? deepReviewTerminalCopy[run.terminalState]
      : undefined;
    // The run failed when coverage says so, or when the parent job itself died
    // before it could record a terminal state at all.
    const runFailed = run.terminalState === "failed" || run.status === "failed";
    const reviewed = run.coverage.completed + run.coverage.reused;
    return (
      <section
        aria-label="Deep review"
        className="mt-5 border-t border-line pt-4"
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
            Deep review
          </p>
          {running ? (
            <span className="text-violet inline-flex items-center gap-1.5 text-[10px]">
              <LoaderCircle className="size-3 animate-spin" />
              {run.status.replace(/_/g, " ")}
            </span>
          ) : (
            terminal && (
              <Badge
                className={cn(
                  "px-2 py-0.5 text-[9px] tracking-wider uppercase",
                  runFailed &&
                    "border-red-500/35 bg-red-500/10 text-red-700 dark:text-red-200",
                  run.terminalState === "partial" &&
                    "border-amber-500/35 bg-amber-400/10 text-amber-800 dark:text-amber-200",
                  run.terminalState === "complete" &&
                    "border-lime/25 bg-lime/[.08] text-lime",
                )}
              >
                {terminal.label}
              </Badge>
            )
          )}
        </div>
        {!running && runFailed && (
          <div
            role="status"
            className="mt-3 rounded-lg border border-red-500/20 bg-red-400/10 p-3 text-red-700 dark:border-red-300/15 dark:text-red-200"
          >
            <p className="text-xs font-medium">Deep review failed</p>
            <p className="mt-1 text-[11px] leading-5 opacity-80">
              {/* The classified cause is the specific one; `run.error` is the
                  fallback for a parent that died before finalize could set a
                  class, routed through the same remediation copy the explain
                  panel uses. */}
              {(run.runFailureClass
                ? reviewFailureClassCopy[run.runFailureClass]
                : undefined) ??
                (run.error
                  ? aiErrorPresentation(run.error).detail
                  : "No selected file was reviewed.")}
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={reviewRunning}
              onClick={() => setAiReviewDialogOpen(true)}
              className="mt-2 h-7 border border-red-500/15 px-2.5 text-[10px] text-current hover:bg-red-500/10"
            >
              <RefreshCw className="size-3" />
              Run it again
            </Button>
          </div>
        )}
        {!running &&
          !runFailed &&
          terminal &&
          run.terminalState !== "complete" && (
            <p className="text-mist mt-2 text-[11px] leading-5">
              {terminal.detail}
            </p>
          )}
        <button
          type="button"
          aria-expanded={coverageOpen}
          onClick={() => setCoverageOpen((open) => !open)}
          className="text-mist hover:bg-surface-subtle hover:text-cloud mt-3 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[10px] transition"
        >
          {coverageOpen ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          <span>
            {/* A unit is a symbol. Coverage is files, because a file count
                matches what the reviewer is walking. */}
            Coverage {reviewed}/{run.coverage.total}{" "}
            {run.coverage.total === 1 ? "file" : "files"}
            {run.coverage.failed > 0 ? ` · ${run.coverage.failed} failed` : ""}
            {run.coverage.waived > 0 ? ` · ${run.coverage.waived} waived` : ""}
          </span>
        </button>
        {/* `grid-cols-1` pins the track to the panel width. An implicit track
            is sized by its widest item, so one deep source path made every row
            wider than the column and the list overflowed its own panel. */}
        {coverageOpen && (
          <ul className="mt-1 grid grid-cols-1 gap-0.5">
            {run.items.map((item) => (
              <li
                key={item.id}
                className="flex min-w-0 items-start justify-between gap-2 rounded-lg px-2 py-1"
              >
                <span className="min-w-0 flex-1">
                  <span className="text-mist block truncate font-mono text-[9px]">
                    {item.kind === "survey" ? "Whole pull request" : item.path}
                  </span>
                  {item.reason && (
                    <span className="text-fog mt-0.5 block text-[9px] leading-4">
                      {item.reason}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "text-fog shrink-0 text-[9px]",
                    item.state === "failed" && "text-red-700 dark:text-red-200",
                  )}
                >
                  {deepReviewItemStateCopy[item.state] ?? item.state}
                </span>
              </li>
            ))}
          </ul>
        )}
        {findings.length === 0 ? (
          !running && (
            <p className="text-mist mt-3 text-[11px] leading-5">
              No findings were surfaced.
            </p>
          )
        ) : (
          <>
            {/* Doubles as the legend for the rails in the list below, which is
                why all four render whether or not the run produced any. */}
            <div className="mt-3 flex h-7 flex-wrap items-center gap-1">
              {deepReviewFacetCounts(
                findings,
                "severity",
                findingSeverities,
              ).map(({ value, count }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={findingSeverityFilter.has(value)}
                  onClick={() => toggleFindingSeverity(value)}
                  className={cn(
                    "rounded-md border px-1.5 py-0.5 text-[9px] tracking-wider uppercase transition",
                    findingSeverityFilter.has(value)
                      ? (findingSeverityStyle[value] ?? "")
                      : "text-fog border-line",
                  )}
                >
                  {findingSeverityChipLabel[value]} {count}
                </button>
              ))}
            </div>
            <div className="mt-1.5 h-7">
              <select
                aria-label="Filter findings by category"
                value={findingCategoryFilter}
                onChange={(event) =>
                  setFindingCategoryFilter(event.target.value)
                }
                className="bg-surface text-cloud h-7 w-full rounded-lg border border-line px-2 text-[10px] outline-none"
              >
                <option value="all">All ({findings.length})</option>
                {deepReviewFacetCounts(findings, "category", findingCategories)
                  .filter(({ count }) => count > 0)
                  .map(({ value, count }) => (
                    <option key={value} value={value}>
                      {value} ({count})
                    </option>
                  ))}
              </select>
            </div>
            {/* Opaque, not `bg-surface/55`: the aside is translucent above
                `xl`, and a see-through sticky header ghosts the rows that
                scroll behind it. */}
            <div
              ref={findingsListRef}
              className="mt-3 max-h-[min(52vh,560px)] overflow-y-auto rounded-xl border border-line bg-surface"
            >
              {activeFindingHidden && (
                <div className="text-fog sticky top-0 z-20 flex h-6 items-center gap-1.5 bg-surface px-1.5 text-[9px]">
                  <span className="truncate">
                    1 open finding hidden by this filter
                  </span>
                  <span aria-hidden="true">·</span>
                  <button
                    type="button"
                    onClick={() => {
                      setFindingSeverityFilter(new Set());
                      setFindingCategoryFilter("all");
                    }}
                    className="text-violet hover:bg-surface-subtle shrink-0 rounded px-1"
                  >
                    Clear
                  </button>
                </div>
              )}
              {findingGroups.map((group) => (
                <div key={`${group.kind}-${group.label}`}>
                  <div
                    className={cn(
                      "sticky z-10 flex h-5 min-w-0 items-baseline gap-1.5 bg-surface px-1.5",
                      // Clears the pinned notice above it, which is 24px tall.
                      activeFindingHidden ? "top-6" : "top-0",
                    )}
                  >
                    {group.kind === "file" ? (
                      <>
                        <span className="text-fog truncate font-mono text-[9px]">
                          {group.label.slice(
                            0,
                            group.label.lastIndexOf("/") + 1,
                          )}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 font-mono text-[9px]",
                            group.path === activeUnit?.path
                              ? "text-cloud"
                              : "text-mist",
                          )}
                        >
                          {group.label.slice(group.label.lastIndexOf("/") + 1)}
                        </span>
                      </>
                    ) : (
                      <span className="text-mist truncate font-mono text-[9px]">
                        {group.label}
                      </span>
                    )}
                    <span className="text-fog ml-auto shrink-0 text-[9px]">
                      {group.findings.length}
                    </span>
                  </div>
                  <ul aria-label={group.label}>
                    {group.findings.map((finding) => (
                      <li key={finding.id}>
                        <DeepReviewFindingRow
                          finding={finding}
                          active={finding.id === activeFindingId}
                          // Read off the group, so a row never disagrees with
                          // the header that is already lit above it.
                          inActiveUnit={group.path === activeUnit?.path}
                          published={findingPublished(finding)}
                          // Roving: Tab reaches the list once instead of
                          // paying forty stops to cross it.
                          tabIndex={finding.id === rovingFindingId ? 0 : -1}
                          onOpen={() => openFinding(finding)}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {visibleFindings.length === 0 && (
                <p className="text-mist px-1.5 py-2 text-[11px] leading-5">
                  No finding matches this filter.
                </p>
              )}
            </div>
          </>
        )}
      </section>
    );
  }

  const unitCommands = useMemo(
    () => buildReviewUnitCommands(units, activeIndex, selectUnit),
    [activeIndex, selectUnit, units],
  );
  const reviewCommands = buildReviewWorkspaceCommands(
    {
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
    },
    {
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
    },
    unitCommands,
  );
  const pendingShortcut = useCommandCenterBindings({
    commands: reviewCommands,
    onOpen: openCommands,
    onOpenShortcuts: openShortcuts,
    suspended: commandBindingsSuspended,
  });

  useEffect(() => {
    if (keyboardLine === undefined || !activeUnit) return;
    const pickedLine = keyboardLine;
    const target = document.getElementById(`review-line-${keyboardLine}`);
    target?.scrollIntoView({ block: "nearest" });

    /** Handles keyboard selection and cancellation for inline comments. */
    function onLinePickerKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setKeyboardLine(undefined);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setKeyboardLine((current) =>
          nextAnchorableLine(
            current ?? primaryReviewStart,
            direction,
            primaryReviewRanges,
            primaryReviewStart,
            primaryReviewEnd,
          ),
        );
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (
          lineWithinReviewRanges(
            pickedLine,
            primaryReviewRanges,
            primaryReviewStart,
            primaryReviewEnd,
          )
        ) {
          commentOnCardLine(pickedLine);
        }
        setKeyboardLine(undefined);
      }
    }

    document.addEventListener("keydown", onLinePickerKeyDown);
    return () => document.removeEventListener("keydown", onLinePickerKeyDown);
  }, [
    activeUnit,
    commentOnCardLine,
    keyboardLine,
    primaryReviewEnd,
    primaryReviewRanges,
    primaryReviewStart,
  ]);

  if (!initialData.snapshot || !activeUnit) {
    return (
      <main className="bg-ink grid min-h-screen place-items-center p-6 text-center">
        <div>
          <FileCode2 className="text-lime mx-auto size-8" />
          <h1 className="mt-5 text-xl font-medium">
            No reviewable symbols yet
          </h1>
          <p className="text-mist mt-2 text-sm">
            ReviewDuck found no supported review units in this pull request.
            Open it on the provider to review unsupported files, or synchronize
            again if supported changes have landed.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link href="/pullrequests">
                <LinkPendingSpinner />
                Back to pull requests
              </Link>
            </Button>
            {initialData.pullRequest.webUrl ? (
              <Button asChild variant="secondary">
                <a
                  href={initialData.pullRequest.webUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open pull request
                  <ExternalLink className="size-3.5" />
                </a>
              </Button>
            ) : null}
          </div>
        </div>
      </main>
    );
  }

  // The pane scrolls to these lines and hangs chrome off them, so their
  // blocks stay mounted wherever the reviewer has scrolled the source.
  const pinnedReviewLines = [
    activeUnit?.startLine,
    aiQuestionLine,
    aiQuestionPreviewLine,
    explanationLine,
    findingLine,
    keyboardLine,
    pendingFindingReveal?.line,
    pendingProviderThread?.line,
    selectedLine,
  ].flatMap((line) => (line === undefined ? [] : [line]));

  const reviewHeaderUrl = reviewProviderWebUrl(initialData.pullRequest);
  const reviewHeaderCopiesPullRequest = Boolean(
    initialData.pullRequest.webUrl?.trim(),
  );

  return (
    // `overflow: clip` rather than `hidden`: hidden still forms a scroll
    // port, so focusing a visually-hidden file checkbox can scroll this
    // shell and leave the review jammed into the top of the window.
    <div className="bg-ink fixed inset-0 flex min-h-0 flex-col overflow-clip">
      <header className="flex h-16 items-center gap-4 border-b border-line px-4 sm:px-6">
        <Link
          href="/pullrequests"
          aria-label="Back to pull requests"
          className="text-mist hover:text-cloud grid size-9 place-items-center rounded-full transition hover:bg-surface-subtle"
        >
          <LinkNavigationStatus
            idle={<ArrowLeft className="size-4" />}
            pending={
              <LoaderCircle className="navigation-pending-reveal size-4 animate-spin" />
            }
          />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {initialData.pullRequest.title}
          </p>
          <div className="flex min-w-0 items-center gap-1">
            <a
              href={reviewHeaderUrl}
              target="_blank"
              rel="noreferrer"
              title={reviewHeaderUrl}
              className="text-fog hover:text-mist min-w-0 truncate text-[10px] hover:underline"
            >
              {reviewHeaderUrl}
            </a>
            <CopyRepositoryUrlButton
              kind={
                reviewHeaderCopiesPullRequest ? "pull-request" : "repository"
              }
              url={reviewHeaderUrl}
            />
          </div>
        </div>
        <div className="hidden items-center gap-3 sm:flex">
          <span className="text-mist text-xs">
            {signedConceptCount}/{initialData.concepts.length} concepts ·{" "}
            {progress}%
          </span>
          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-hover">
            <div
              role="progressbar"
              aria-label="Review progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              className="bg-lime h-full rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        <button
          type="button"
          aria-controls="review-discussions-panel"
          aria-expanded={discussionsOpen}
          aria-label={`Show pull request discussions, ${openProviderDiscussionCount} open`}
          title={`${openProviderDiscussionCount} open ${openProviderDiscussionCount === 1 ? "discussion" : "discussions"}`}
          onClick={() => {
            setDiscussionsOpen((open) => {
              if (!open) setInsightsPanelOpen(false);
              return !open;
            });
          }}
          className={cn(
            "flex h-9 shrink-0 items-center gap-2 rounded-lg border px-2.5 text-[10px] transition",
            completionChromeHidden && "hidden",
            discussionsOpen
              ? "border-cyan/30 bg-cyan/[.08] text-cyan"
              : "text-mist hover:text-cloud border-line hover:bg-surface-subtle",
          )}
        >
          {providerConversations.isLoading && !providerConversations.data ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <MessageSquareText className="size-4" />
          )}
          <span className="hidden lg:inline">Discussions</span>
          <span
            className={cn(
              "grid min-w-4 place-items-center rounded-md px-1 py-0.5 font-mono text-[9px]",
              openProviderDiscussionCount > 0
                ? "bg-coral/10 text-coral"
                : "bg-lime/10 text-lime",
            )}
          >
            {openProviderDiscussionCount}
          </span>
          {openProviderDiscussionCount > 0 && (
            <span
              className="bg-coral size-1.5 rounded-full"
              aria-hidden="true"
            />
          )}
        </button>
        <button
          type="button"
          onClick={
            updateAvailable
              ? loadAvailableChanges
              : () => void syncExternalData()
          }
          disabled={
            resetReview.isPending ||
            loadingChanges ||
            (!updateAvailable && externalSyncPending)
          }
          aria-label={
            updateAvailable
              ? "Load new code changes"
              : `Sync ${providerLabel(initialData.pullRequest.provider)} pull request`
          }
          title={
            updateAvailable
              ? "Load the synced code changes (R)"
              : `Fetch the latest ${providerLabel(initialData.pullRequest.provider)} code and review conversations (R)`
          }
          className="text-mist hover:text-cloud flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line px-2.5 text-[10px] transition hover:bg-surface-subtle disabled:cursor-wait"
        >
          <RefreshCw
            className={cn(
              "size-4",
              (loadingChanges || (externalSyncPending && !updateAvailable)) &&
                "animate-spin",
            )}
          />
          <span className="hidden sm:inline">
            {loadingChanges ? (
              "Loading…"
            ) : updateAvailable ? (
              <>
                Load
                <span className="hidden xl:inline"> changes</span>
              </>
            ) : externalSyncPending ? (
              "Syncing…"
            ) : (
              "Sync"
            )}
          </span>
          <ShortcutHint
            shortcut={
              updateAvailable
                ? reviewShortcuts.loadChanges
                : reviewShortcuts.refresh
            }
            className="hidden 2xl:inline-flex"
          />
        </button>
        <button
          type="button"
          onClick={undoLastSignOff}
          disabled={!canUndoSignOff}
          aria-busy={undoPending || undefined}
          aria-label="Undo the last sign-off"
          title={
            undoableSignOff
              ? `Return ${undoableSignOff.entry.label} to the review path`
              : "No sign-off from this session left to undo"
          }
          className="text-mist hover:text-cloud flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line px-2.5 text-[10px] transition hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-45"
        >
          {undoPending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Undo2 className="size-4" />
          )}
          <span className="hidden sm:inline">
            {undoPending ? "Undoing…" : "Undo"}
          </span>
          <ShortcutHint
            shortcut={reviewShortcuts.undoSignOff}
            className="hidden 2xl:inline-flex"
          />
        </button>
        <button
          type="button"
          onClick={() => setResetDialogOpen(true)}
          disabled={
            pendingSignOffCount > 0 ||
            externalSyncPending ||
            resetReview.isPending
          }
          aria-label="Reset review"
          title={
            pendingSignOffCount > 0
              ? "Wait for pending sign-offs to finish before resetting"
              : "Sync the latest code and clear all of your sign-offs (Shift+R)"
          }
          className="text-mist hover:text-cloud flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line px-2.5 text-[10px] transition hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-45"
        >
          <RotateCcw className="size-4" />
          <span className="hidden sm:inline">Reset</span>
          <ShortcutHint
            shortcut={reviewShortcuts.reset}
            className="hidden 2xl:inline-flex"
          />
        </button>
        <button
          type="button"
          onClick={openCommands}
          aria-label="Open review commands"
          title="Open review commands"
          className="text-mist hover:text-cloud flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line px-2.5 text-[10px] transition hover:bg-surface-subtle"
        >
          <Keyboard className="size-4" />
          <ShortcutHint
            shortcut={commandMenuShortcut}
            className="hidden sm:inline-flex"
          />
        </button>
        <a
          href={initialData.pullRequest.webUrl}
          target="_blank"
          rel="noreferrer"
          aria-label="Open pull request in provider"
          className="text-mist hover:text-cloud grid size-9 place-items-center rounded-full hover:bg-surface-subtle"
        >
          <ExternalLink className="size-4" />
        </a>
        <ThemeToggle className="size-9 rounded-full" />
      </header>

      {updateAvailable && (
        <div
          role="status"
          className="border-cyan/20 bg-cyan/[.055] flex shrink-0 items-center gap-3 border-b px-4 py-2.5 sm:px-6"
        >
          <RefreshCw className="text-cyan size-4 shrink-0" />
          <p className="text-mist min-w-0 flex-1 text-xs">
            New code changes are ready. Loading them will preserve unaffected
            sign-offs and reopen affected units.
          </p>
          <Button
            size="sm"
            loading={loadingChanges}
            onClick={loadAvailableChanges}
            title="Load the synced code changes (R)"
          >
            <span>{loadingChanges ? "Loading changes…" : "Load changes"}</span>
            {!loadingChanges && (
              <ShortcutHint shortcut={reviewShortcuts.loadChanges} />
            )}
          </Button>
        </div>
      )}

      {revisionNotice && (
        <ReviewRevisionLoadedNotice onAcknowledge={acknowledgeLoadedRevision}>
          {revisionNotice.previous &&
          revisionNotice.previous.headSha !== initialData.snapshot.headSha
            ? `${providerLabel(initialData.pullRequest.provider)} moved from ${shortRevision(revisionNotice.previous.headSha)} to ${shortRevision(initialData.snapshot.headSha)}. `
            : `Review analysis was recomputed for ${shortRevision(initialData.snapshot.headSha)}. `}
          {revisionReReviewCount > 0
            ? `${revisionReReviewCount} previously reviewed ${revisionReReviewCount === 1 ? "unit changed" : "units changed"} and ${revisionReReviewCount === 1 ? "needs" : "need"} another look. `
            : "No reviewed units were reopened. "}
          {revisionPreservedCount > 0 &&
            `${revisionPreservedCount} unaffected ${revisionPreservedCount === 1 ? "sign-off was" : "sign-offs were"} preserved. `}
          Only a new source or analysis revision can change review state;
          interface updates cannot.
        </ReviewRevisionLoadedNotice>
      )}

      {discussionsOpen && (
        <ReviewDiscussionsPanel
          error={providerConversations.error?.message}
          loading={providerConversations.isFetching}
          provider={
            providerConversations.data?.provider ??
            initialData.pullRequest.provider
          }
          threads={providerDiscussionThreads}
          onClose={() => setDiscussionsOpen(false)}
          onOpenThread={openProviderDiscussion}
          onRefresh={() => void providerConversations.refetch()}
        />
      )}

      <div
        style={
          {
            "--review-insights-panel-width": `${insightsPanelWidth}px`,
            "--review-path-panel-width": `${pathPanelWidth}px`,
          } as CSSProperties
        }
        className={cn(
          "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-hidden",
          !completionChromeHidden &&
            (insightsPanelCollapsed
              ? "xl:grid-cols-[minmax(0,1fr)]"
              : "xl:grid-cols-[minmax(0,1fr)_var(--review-insights-panel-width)]"),
          !completionChromeHidden &&
            (pathPanelCollapsed && insightsPanelCollapsed
              ? "2xl:grid-cols-[minmax(0,1fr)]"
              : pathPanelCollapsed
                ? "2xl:grid-cols-[minmax(0,1fr)_var(--review-insights-panel-width)]"
                : insightsPanelCollapsed
                  ? "2xl:grid-cols-[var(--review-path-panel-width)_minmax(0,1fr)]"
                  : "2xl:grid-cols-[var(--review-path-panel-width)_minmax(0,1fr)_var(--review-insights-panel-width)]"),
        )}
      >
        {pathPanelOpen && !completionChromeHidden && (
          <button
            type="button"
            aria-label={`Close ${reviewMode === "path" ? "review path" : "changed files"}`}
            onClick={() => setPathPanelOpen(false)}
            className="fixed top-16 right-0 bottom-0 left-0 z-30 bg-black/55 backdrop-blur-[2px] 2xl:hidden"
          />
        )}
        {insightsPanelOpen && !completionChromeHidden && (
          <button
            type="button"
            aria-label="Close AI assistance"
            onClick={() => setInsightsPanelOpen(false)}
            className="fixed top-16 right-0 bottom-0 left-0 z-30 bg-black/55 backdrop-blur-[2px] xl:hidden"
          />
        )}
        <aside
          id="review-path-panel"
          aria-label={reviewMode === "path" ? "Review path" : "Changed files"}
          className={cn(
            "min-h-0 flex-col overflow-hidden border-r border-line bg-panel",
            completionChromeHidden
              ? "hidden"
              : pathPanelOpen
                ? "fixed top-16 bottom-0 left-0 z-40 flex w-[min(320px,calc(100vw-3rem))] shadow-2xl"
                : "hidden",
            !completionChromeHidden &&
              (pathPanelCollapsed
                ? "2xl:hidden"
                : "2xl:relative 2xl:flex 2xl:w-auto 2xl:shadow-none"),
          )}
        >
          {!pathPanelCollapsed && (
            <ReviewPanelResizeHandle
              className="2xl:flex"
              controls="review-path-panel"
              defaultWidth={REVIEW_PATH_PANEL_WIDTHS.default}
              label={`Resize ${reviewMode === "path" ? "review path" : "changed files"}`}
              maximumWidth={REVIEW_PATH_PANEL_WIDTHS.maximum}
              minimumWidth={REVIEW_PATH_PANEL_WIDTHS.minimum}
              side="left"
              width={pathPanelWidth}
              onResize={setPathPanelWidth}
              onCollapse={hidePathPanel}
            />
          )}
          <div className="shrink-0 border-b border-line px-4 py-4">
            <ReviewModeSwitch mode={reviewMode} onChange={changeReviewMode} />
            <div className="mt-4 flex items-center justify-between">
              <span className="text-fog text-[10px] font-semibold tracking-[.16em] uppercase">
                {reviewMode === "path" ? "Review concepts" : "Changed files"}
              </span>
              <Badge>
                {reviewMode === "path"
                  ? `${initialData.concepts.length} concepts`
                  : `${reviewFiles.length} files`}
              </Badge>
            </div>
            <div className="mt-3 flex items-center gap-2 text-[9px]">
              <span className="text-cloud">
                {reviewMode === "path"
                  ? `${initialData.concepts.length - signedConceptCount} concepts remaining`
                  : `${reviewedFileCount}/${reviewFiles.filter(({ totalUnits }) => totalUnits > 0).length} files reviewed`}
              </span>
              <span aria-hidden="true" className="text-line-strong">
                ·
              </span>
              <span className="text-fog">
                {signedCount}/{units.length} units · {reviewedChangedLines}/
                {conceptChangedLineTotal} lines
              </span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-hover">
              <div
                aria-hidden="true"
                className="bg-lime h-full rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="relative mt-3">
              <input
                ref={pathSearchRef}
                type="search"
                value={pathSearch}
                onChange={(event) => {
                  setPathSearch(event.target.value);
                  setSearchLimit(INITIAL_PATH_ITEMS);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setPathSearch("");
                    event.currentTarget.blur();
                  }
                }}
                aria-label={
                  reviewMode === "path"
                    ? "Filter review path"
                    : "Filter changed files"
                }
                placeholder={
                  reviewMode === "path"
                    ? "Find a symbol or file"
                    : "Find a file"
                }
                className="bg-surface text-cloud focus:border-cyan/45 h-9 w-full rounded-lg border border-line px-3 pr-9 text-xs outline-none"
              />
              <ShortcutHint
                shortcut={reviewShortcuts.search}
                className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2"
              />
            </div>
          </div>
          {reviewMode === "path" ? (
            <>
              {!pathSearch.trim() && (
                <section className="shrink-0 border-b border-line px-3 py-3">
                  <button
                    type="button"
                    aria-expanded={reviewedExpanded}
                    aria-controls="reviewed-units"
                    disabled={pathSections.reviewed.length === 0}
                    onClick={() => {
                      setReviewedExpanded((current) => !current);
                      setReviewedLimit(INITIAL_PATH_ITEMS);
                    }}
                    className="hover:bg-surface-subtle flex w-full items-center justify-between rounded-lg px-2 py-1 text-left transition disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <span className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
                      Reviewed
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-fog text-[9px]">
                        {pathSections.reviewed.length}
                      </span>
                      <ChevronDown
                        className={cn(
                          "text-fog size-3.5 transition-transform",
                          reviewedExpanded && "rotate-180",
                        )}
                      />
                    </span>
                  </button>
                  {reviewedExpanded && (
                    <div
                      id="reviewed-units"
                      className="mt-2 max-h-[32vh] space-y-1 overflow-y-auto"
                    >
                      {pathSections.reviewed
                        .slice(0, reviewedLimit)
                        .map((entry) => (
                          <ReviewPathUnit
                            key={entry.unit.id}
                            entry={entry}
                            active={false}
                            onSelect={selectConceptPath}
                          />
                        ))}
                      {pathSections.reviewed.length > reviewedLimit && (
                        <button
                          type="button"
                          onClick={() =>
                            setReviewedLimit((current) =>
                              Math.min(
                                current + PATH_PAGE_SIZE,
                                pathSections.reviewed.length,
                              ),
                            )
                          }
                          className="text-cyan hover:bg-cyan/[.06] w-full rounded-lg px-3 py-2 text-[10px] transition"
                        >
                          Show{" "}
                          {Math.min(
                            PATH_PAGE_SIZE,
                            pathSections.reviewed.length - reviewedLimit,
                          )}{" "}
                          more reviewed
                        </button>
                      )}
                    </div>
                  )}
                </section>
              )}
              {!pathSearch.trim() && pathSections.waiting.length > 0 && (
                <section className="shrink-0 border-b border-line px-3 py-3">
                  <button
                    type="button"
                    aria-expanded={waitingExpanded}
                    aria-controls="waiting-units"
                    onClick={() => {
                      setWaitingExpanded((current) => !current);
                      setWaitingLimit(INITIAL_PATH_ITEMS);
                    }}
                    className="hover:bg-surface-subtle flex w-full items-center justify-between rounded-lg px-2 py-1 text-left transition"
                  >
                    <span className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
                      Waiting for response
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-cyan text-[9px]">
                        {pathSections.waiting.length}
                      </span>
                      <ChevronDown
                        className={cn(
                          "text-fog size-3.5 transition-transform",
                          waitingExpanded && "rotate-180",
                        )}
                      />
                    </span>
                  </button>
                  {waitingExpanded && (
                    <div
                      id="waiting-units"
                      className="mt-2 max-h-[28vh] space-y-1 overflow-y-auto"
                    >
                      {pathSections.waiting
                        .slice(0, waitingLimit)
                        .map((entry) => (
                          <ReviewPathUnit
                            key={entry.unit.id}
                            entry={entry}
                            active={false}
                            onSelect={selectConceptPath}
                          />
                        ))}
                      {pathSections.waiting.length > waitingLimit && (
                        <button
                          type="button"
                          onClick={() =>
                            setWaitingLimit((current) =>
                              Math.min(
                                current + PATH_PAGE_SIZE,
                                pathSections.waiting.length,
                              ),
                            )
                          }
                          className="text-cyan hover:bg-cyan/[.06] w-full whitespace-nowrap rounded-lg px-3 py-2 text-[10px] transition"
                        >
                          Show{" "}
                          {Math.min(
                            PATH_PAGE_SIZE,
                            pathSections.waiting.length - waitingLimit,
                          )}{" "}
                          more
                        </button>
                      )}
                    </div>
                  )}
                </section>
              )}
              <div className="shrink-0 border-b border-line px-3 py-3">
                <div className="mb-1 flex items-center justify-between px-2">
                  <span className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
                    Current
                  </span>
                  <span
                    className="text-fog text-[9px]"
                    title={`Canonical concept position ${activeConceptPathIndex + 1} of ${conceptPathUnits.length}`}
                  >
                    {activeConceptPathIndex + 1}
                  </span>
                </div>
                {pathSections.current && (
                  <ReviewPathUnit
                    entry={pathSections.current}
                    active
                    onSelect={selectConceptPath}
                  />
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {pathSearch.trim() ? (
                  <section aria-labelledby="search-results-heading">
                    <div className="mb-2 flex items-center justify-between px-2">
                      <h2
                        id="search-results-heading"
                        className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase"
                      >
                        Matches
                      </h2>
                      <span className="text-fog text-[9px]">
                        {searchResults.length}
                      </span>
                    </div>
                    {searchResults.length ? (
                      <div className="space-y-1">
                        {searchResults.slice(0, searchLimit).map((entry) => (
                          <ReviewPathUnit
                            key={entry.unit.id}
                            entry={entry}
                            active={false}
                            onSelect={selectUnit}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="text-mist rounded-xl border border-dashed border-line px-3 py-4 text-center text-[10px] leading-4">
                        No other units match your search.
                      </p>
                    )}
                    {searchResults.length > searchLimit && (
                      <button
                        type="button"
                        onClick={() =>
                          setSearchLimit((current) =>
                            Math.min(
                              current + PATH_PAGE_SIZE,
                              searchResults.length,
                            ),
                          )
                        }
                        className="text-cyan hover:bg-cyan/[.06] mt-2 w-full rounded-lg px-3 py-2 text-[10px] transition"
                      >
                        Show{" "}
                        {Math.min(
                          PATH_PAGE_SIZE,
                          searchResults.length - searchLimit,
                        )}{" "}
                        more matches
                      </button>
                    )}
                  </section>
                ) : (
                  <section aria-labelledby="up-next-heading">
                    <div className="mb-2 flex items-center justify-between px-2">
                      <h2
                        id="up-next-heading"
                        className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase"
                      >
                        Up next
                      </h2>
                      <span className="text-fog text-[9px]">
                        {pathSections.upcoming.length}
                      </span>
                    </div>
                    {pathSections.upcoming.length ? (
                      <div className="space-y-1">
                        {pathSections.upcoming
                          .slice(0, queueLimit)
                          .map((entry) => (
                            <ReviewPathUnit
                              key={entry.unit.id}
                              entry={entry}
                              active={false}
                              onSelect={selectConceptPath}
                            />
                          ))}
                      </div>
                    ) : (
                      <p className="text-mist rounded-xl border border-dashed border-line px-3 py-4 text-center text-[10px]">
                        No concepts left in the queue.
                      </p>
                    )}
                    <div className="mt-2 flex items-center gap-1">
                      {pathSections.upcoming.length > queueLimit && (
                        <button
                          type="button"
                          onClick={() =>
                            setQueueLimit((current) =>
                              Math.min(
                                current + PATH_PAGE_SIZE,
                                pathSections.upcoming.length,
                              ),
                            )
                          }
                          className="text-cyan hover:bg-cyan/[.06] flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-[10px] transition"
                        >
                          Show{" "}
                          {Math.min(
                            PATH_PAGE_SIZE,
                            pathSections.upcoming.length - queueLimit,
                          )}{" "}
                          more
                        </button>
                      )}
                      {queueLimit > INITIAL_PATH_ITEMS && (
                        <button
                          type="button"
                          onClick={() => setQueueLimit(INITIAL_PATH_ITEMS)}
                          className="text-mist hover:bg-surface-subtle shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-[10px] transition"
                        >
                          Show less
                        </button>
                      )}
                    </div>
                  </section>
                )}
              </div>
            </>
          ) : (
            <ReviewFilesPanel
              files={reviewFiles}
              search={pathSearch}
              selectedPath={completedBrowsing ? undefined : activeUnit.path}
              pendingFileIds={pendingFiles}
              onSelect={selectReviewFile}
              onToggle={toggleReviewFile}
              onResumeWaiting={resumeReviewFile}
            />
          )}
          <div className="shrink-0 border-t border-line p-3">
            <button
              type="button"
              aria-label={`Hide ${reviewMode === "path" ? "review path" : "changed files"}`}
              title={`Hide ${reviewMode === "path" ? "review path" : "changed files"}`}
              onClick={hidePathPanel}
              className="text-mist hover:bg-surface-subtle hover:text-cloud flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-[10px] transition"
            >
              <PanelLeftClose className="size-3.5" />
              <span>
                Hide {reviewMode === "path" ? "review path" : "changed files"}
              </span>
              <ShortcutHint
                shortcut={reviewShortcuts.togglePathPanel}
                className="ml-auto"
              />
            </button>
          </div>
        </aside>

        <main className="relative flex min-h-0 min-w-0 flex-col overflow-hidden">
          {waitingCompletionVisible && (
            <ReviewWaitingCompletion
              dashboardShortcut={reviewShortcuts.dashboard}
              dismissShortcut={[{ key: "Escape" }]}
              nextReview={nextReview}
              nextReviewShortcut={reviewShortcuts.nextReview}
              providerName={providerLabel(initialData.pullRequest.provider)}
              queueLoading={reviewQueue.isLoading}
              reviewedConcepts={signedConceptCount}
              totalConcepts={conceptProgress.length}
              units={waitingReviewUnits}
              onDashboard={openPullRequests}
              onDismiss={() => setWaitingCompletionOpen(false)}
              onNextReview={openNextReview}
              onOpenUnit={openWaitingUnit}
              onStopWaiting={stopWaitingOnUnit}
            />
          )}
          {completionVisible && (
            <ReviewCompletion
              completedFiles={completedFileCount}
              completedUnits={signedCount}
              dashboardShortcut={reviewShortcuts.dashboard}
              dismissShortcut={[{ key: "Escape" }]}
              nextReview={nextReview}
              nextReviewShortcut={reviewShortcuts.nextReview}
              discussionStatus={
                <ReviewDiscussionSummary
                  provider={
                    providerConversations.data?.provider ??
                    initialData.pullRequest.provider
                  }
                  threads={providerDiscussionThreads}
                  onOpenThread={openProviderDiscussion}
                />
              }
              lifecycle={
                <ProviderLifecycle
                  state={providerLifecycle.data}
                  error={
                    mergePullRequest.error?.message ??
                    providerLifecycle.error?.message
                  }
                  loading={providerLifecycle.isFetching}
                  mutationPending={mergePullRequest.isPending}
                  permissionDenied={
                    mergePullRequest.error?.data?.code === "FORBIDDEN" ||
                    providerLifecycle.error?.data?.code === "FORBIDDEN"
                  }
                  provider={initialData.pullRequest.provider}
                  pullRequestUrl={initialData.pullRequest.webUrl}
                  reviewPath={`/review/${initialData.pullRequest.id}`}
                  onRefresh={() => {
                    void providerLifecycle.refetch().then((result) => {
                      if (!result.error) mergePullRequest.reset();
                    });
                  }}
                  onMerge={() =>
                    mergePullRequest.mutate({
                      pullRequestId: initialData.pullRequest.id,
                    })
                  }
                />
              }
              providerReview={
                <ProviderReviewDecision
                  state={providerReviewState.data}
                  error={
                    setProviderReviewDecision.error?.message ??
                    providerReviewState.error?.message
                  }
                  loading={providerReviewState.isFetching}
                  mutationPending={setProviderReviewDecision.isPending}
                  permissionDenied={
                    setProviderReviewDecision.error?.data?.code ===
                      "FORBIDDEN" ||
                    providerReviewState.error?.data?.code === "FORBIDDEN"
                  }
                  provider={initialData.pullRequest.provider}
                  repositoryUrl={initialData.pullRequest.repositoryWebUrl}
                  pullRequestUrl={initialData.pullRequest.webUrl}
                  reviewPath={`/review/${initialData.pullRequest.id}`}
                  onRefresh={() => {
                    void providerReviewState.refetch().then((result) => {
                      if (!result.error) setProviderReviewDecision.reset();
                    });
                  }}
                  onDecision={(action, body) =>
                    setProviderReviewDecision.mutate({
                      pullRequestId: initialData.pullRequest.id,
                      action,
                      body,
                    })
                  }
                />
              }
              openDiscussions={openProviderDiscussionCount}
              queueLoading={reviewQueue.isLoading}
              onDashboard={openPullRequests}
              onDismiss={browseCompletedReview}
              onNextReview={openNextReview}
            />
          )}
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden",
              completionChromeHidden && "hidden",
            )}
          >
            <div
              className={cn(
                "bg-panel sticky top-0 z-20 shrink-0 border-b border-line",
                codePaneScrolled &&
                  "shadow-[0_10px_24px_color-mix(in_srgb,var(--app-shadow)_55%,transparent)]",
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 px-3 py-3 sm:flex-nowrap sm:gap-4 sm:px-5 sm:py-4 lg:px-7">
                <button
                  type="button"
                  aria-label={`Show ${reviewMode === "path" ? "review path" : "changed files"}`}
                  aria-controls="review-path-panel"
                  aria-expanded={pathPanelOpen}
                  title={`Show ${reviewMode === "path" ? "review path" : "changed files"}`}
                  onClick={showPathPanel}
                  className={cn(
                    "text-mist hover:text-cyan h-8 shrink-0 items-center gap-2 rounded-lg border border-line px-2 transition hover:border-cyan/25 hover:bg-cyan/[.05]",
                    pathPanelCollapsed ? "flex" : "flex 2xl:hidden",
                  )}
                >
                  <PanelLeftOpen className="size-3.5" />
                  <span className="hidden text-[10px] sm:inline">
                    {reviewMode === "path" ? "Review path" : "Files"}
                  </span>
                  <ShortcutHint
                    shortcut={reviewShortcuts.togglePathPanel}
                    className="hidden lg:inline-flex"
                  />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <h1
                      className="truncate text-sm font-medium"
                      title={`${activeUnit.path}, lines ${activeUnit.startLine}–${activeUnit.endLine}`}
                    >
                      {reviewMode === "files"
                        ? (activeUnit.path.split("/").at(-1) ?? activeUnit.path)
                        : (activeConcept?.title ?? activeUnit.name)}
                    </h1>
                    {activeWaitStatus === "waiting" &&
                      (activeUnitAnswered ? (
                        <Badge className="border-lime/25 bg-lime/10 text-lime">
                          <MessageSquareText className="size-3" />
                          Response received
                        </Badge>
                      ) : (
                        <Badge className="border-cyan/25 bg-cyan/10 text-cyan">
                          <Clock3 className="size-3" />
                          Waiting for response
                        </Badge>
                      ))}
                    {activeUnit.changedSinceSignOff && (
                      <Badge className="border-amber-600/25 bg-amber-400/10 text-amber-800 dark:border-amber-300/20 dark:text-amber-200">
                        Changed
                      </Badge>
                    )}
                    {reviewMode === "files" &&
                      activeReviewFile &&
                      activeReviewFile.newUnits > 0 && (
                        <Badge className="border-cyan/25 bg-cyan/10 text-cyan">
                          {activeReviewFile.newUnits} new
                        </Badge>
                      )}
                    {reviewMode === "files" &&
                      activeReviewFile &&
                      activeReviewFile.updatedUnits > 0 && (
                        <Badge className="border-amber-600/25 bg-amber-400/10 text-amber-800 dark:border-amber-300/20 dark:text-amber-200">
                          {activeReviewFile.updatedUnits} updated
                        </Badge>
                      )}
                    {reviewMode === "path" &&
                      activeUnit.revisionState === "new" && (
                        <Badge className="border-cyan/25 bg-cyan/10 text-cyan">
                          New
                        </Badge>
                      )}
                    {reviewMode === "path" &&
                      activeUnit.revisionState === "updated" &&
                      !activeUnit.changedSinceSignOff && (
                        <Badge className="border-amber-600/25 bg-amber-400/10 text-amber-800 dark:border-amber-300/20 dark:text-amber-200">
                          Updated
                        </Badge>
                      )}
                    {activeUnit.changeType !== "modified" && (
                      <Badge
                        className={cn(
                          "capitalize",
                          activeUnit.changeType === "deleted" &&
                            "border-red-500/25 bg-red-400/10 text-red-700 dark:border-red-300/20 dark:text-red-200",
                        )}
                      >
                        {activeUnit.changeType}
                      </Badge>
                    )}
                  </div>
                  <p className="text-fog mt-1 flex min-w-0 items-center gap-1.5 truncate text-[10px]">
                    <span className="text-mist font-mono">
                      {activeUnit.path}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="shrink-0">
                      {reviewMode === "files"
                        ? `File ${activeConceptCardIndex + 1}/${activeConceptFileCards.length} · ${activeFileCardMembers.length} ${activeFileCardMembers.length === 1 ? "unit" : "units"}`
                        : activeFileCardMembers.length > 1
                          ? `Card ${activeConceptCardIndex + 1}/${activeConceptFileCards.length} · ${activeFileCardMembers.length} individual units`
                          : `Lines ${activeUnit.startLine}–${activeUnit.endLine}`}
                    </span>
                    {reviewMode === "path" && activeConcept && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="shrink-0">
                          {activeConcept.changedLineCount} changed lines in{" "}
                          {activeConcept.fileCount}{" "}
                          {activeConcept.fileCount === 1 ? "file" : "files"}
                        </span>
                      </>
                    )}
                  </p>
                </div>
                <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
                  {sourceHydrationPending && (
                    <span
                      role="status"
                      aria-label="Loading private review source"
                      className="text-mist flex h-8 shrink-0 items-center gap-1.5 px-1.5 text-[10px]"
                      title="Loading and verifying review source in the background"
                    >
                      <LoaderCircle className="size-3.5 animate-spin" />
                      <span className="hidden lg:inline">Loading source…</span>
                    </span>
                  )}
                  {initialData.conceptLayout && !conceptLayoutLocked && (
                    <button
                      type="button"
                      onClick={() => setConceptGroupingDialogOpen(true)}
                      disabled={
                        improveConceptGrouping.isPending || conceptLayoutPending
                      }
                      aria-label={improveGroupingLabel}
                      className="text-violet hover:bg-violet/[.06] grid size-8 shrink-0 place-items-center rounded-lg border border-violet/20 transition disabled:cursor-wait disabled:opacity-60"
                      title={improveGroupingLabel}
                    >
                      {groupingImproving ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="size-3.5" />
                      )}
                    </button>
                  )}
                  {initialData.conceptLayout &&
                    !conceptLayoutLocked &&
                    activeConceptMembers.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setSplitConceptDialogOpen(true)}
                        disabled={conceptLayoutPending}
                        className="text-mist hover:text-cyan flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[10px] transition disabled:opacity-50"
                        title="Split this concept"
                      >
                        {splittingConcept && (
                          <LoaderCircle className="size-3.5 animate-spin" />
                        )}
                        {splittingConcept ? "Splitting…" : "Split"}
                      </button>
                    )}
                  {initialData.conceptLayout &&
                    !conceptLayoutLocked &&
                    initialData.concepts.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setMoveMemberDialogOpen(true)}
                        disabled={conceptLayoutPending}
                        aria-label={moveMemberLabel}
                        title={moveMemberLabel}
                        className="text-mist hover:text-cyan grid size-8 shrink-0 place-items-center rounded-lg border border-line transition hover:border-cyan/25 hover:bg-cyan/[.05] disabled:opacity-50"
                      >
                        {movingMember ? (
                          <LoaderCircle className="size-3.5 animate-spin" />
                        ) : (
                          <FolderInput className="size-3.5" />
                        )}
                      </button>
                    )}
                  <button
                    type="button"
                    aria-label="Open review hierarchy"
                    title="Review hierarchy"
                    onClick={() => setHierarchyOpen(true)}
                    className="text-mist hover:text-cyan grid size-8 shrink-0 place-items-center rounded-lg border border-line transition hover:border-cyan/25 hover:bg-cyan/[.05]"
                  >
                    <GitBranch className="size-3.5" />
                  </button>
                  {diffAvailable && (
                    <ReviewCodeViewSwitch
                      diffVisible={sideBySideVisible}
                      onChange={(diffVisible) => {
                        if (diffVisible === sideBySideVisible) return;
                        setShowDiff(diffVisible);
                        setContextBefore(0);
                        setContextAfter(0);
                      }}
                    />
                  )}
                  <button
                    type="button"
                    aria-label="Show AI assistance"
                    aria-controls="code-explanation-panel"
                    aria-expanded={insightsPanelOpen}
                    title="Show AI assistance"
                    onClick={showInsightsPanel}
                    className={cn(
                      "text-mist hover:text-violet h-8 shrink-0 items-center gap-2 rounded-lg border border-line px-2 transition hover:border-violet/25 hover:bg-violet/[.05]",
                      insightsPanelCollapsed ? "flex" : "flex xl:hidden",
                    )}
                  >
                    <PanelRightOpen className="size-3.5" />
                    <span className="hidden text-[10px] sm:inline">
                      Details
                    </span>
                    <ShortcutHint
                      shortcut={reviewShortcuts.toggleInsightsPanel}
                      className="hidden lg:inline-flex"
                    />
                  </button>
                  <Badge className="hidden h-8 py-0 capitalize sm:inline-flex">
                    {activeUnit.kind}
                  </Badge>
                </div>
              </div>
            </div>
            {activeUnit.changedSinceSignOff && !activeUnit.previousSource && (
              <div className="border-cyan/15 bg-cyan/[.035] text-cyan border-b px-5 py-2 text-[10px] sm:px-7">
                This source is unchanged, but a dependency it relies on changed.
              </div>
            )}
            {providerConversations.isError && (
              <div className="flex items-center justify-between gap-3 border-b border-amber-500/20 bg-amber-400/[.06] px-5 py-2 sm:px-7">
                <p className="text-[10px] text-amber-800 dark:text-amber-200">
                  {providerConversations.error.message}
                </p>
                <button
                  type="button"
                  onClick={() => void providerConversations.refetch()}
                  className="shrink-0 text-[10px] font-medium text-amber-800 hover:underline dark:text-amber-200"
                >
                  Try again
                </button>
              </div>
            )}
            {importReturn && (
              <div className="border-cyan/15 bg-cyan/[.035] flex items-center justify-between gap-3 border-b px-5 py-2 sm:px-7">
                <p className="text-mist min-w-0 truncate text-[10px]">
                  Followed{" "}
                  <span className="text-cloud font-mono">
                    {importReturn.importedName}
                  </span>{" "}
                  from{" "}
                  <span className="text-cloud font-mono">
                    {importReturn.unitName}
                  </span>
                </p>
                <button
                  type="button"
                  onClick={() => selectUnit(importReturn.index)}
                  className="text-cyan hover:bg-cyan/[.07] flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] transition"
                >
                  <CornerUpLeft className="size-3" />
                  Return
                </button>
              </div>
            )}
            <div
              ref={codeScrollRef}
              data-code-scroll-pane
              onScroll={() => {
                closeSymbolPeek();
                updateCodeOverview();
                updateSelectedCardChrome();
              }}
              {...peekHandlers}
              className="min-h-0 flex-1 overflow-auto bg-code pb-5 font-mono text-xs leading-[21px] font-medium [overflow-anchor:none]"
            >
              <div aria-hidden="true" className="h-5" />
              {keyboardLine !== undefined && (
                <div
                  role="status"
                  className="border-cyan/20 bg-panel/95 text-mist sticky top-0 z-30 mx-4 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2 font-sans text-[10px] shadow-xl backdrop-blur"
                >
                  <span className="text-cloud flex items-center gap-2 font-medium">
                    <MessageSquareText className="text-cyan size-3.5" />
                    Choose a line to comment on
                  </span>
                  <span className="flex items-center gap-1.5">
                    <ShortcutHint
                      shortcut={[{ key: "ArrowUp" }, { key: "ArrowDown" }]}
                    />
                    move
                  </span>
                  <span className="flex items-center gap-1.5">
                    <ShortcutHint shortcut={[{ key: "Enter" }]} />
                    select
                  </span>
                  <span className="flex items-center gap-1.5">
                    <ShortcutHint shortcut={[{ key: "Escape" }]} />
                    cancel
                  </span>
                </div>
              )}
              <div ref={reviewCardsAboveRef}>
                {reviewMode === "files" && viewerCardWindow.hiddenAbove > 0 && (
                  <div className="mb-4 flex items-center gap-3 px-4 font-sans">
                    <span className="h-px flex-1 bg-line" />
                    <button
                      type="button"
                      onClick={() =>
                        setFilesViewerAbove(
                          (current) => current + FILES_VIEWER_PAGE_SIZE,
                        )
                      }
                      className="text-fog hover:border-cyan/25 hover:bg-cyan/[.05] hover:text-cyan flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[9px] transition"
                    >
                      Show{" "}
                      {Math.min(
                        FILES_VIEWER_PAGE_SIZE,
                        viewerCardWindow.hiddenAbove,
                      )}{" "}
                      more files above
                    </button>
                    <span className="h-px flex-1 bg-line" />
                  </div>
                )}
                {viewerCardWindow.cards
                  .slice(0, selectedWindowOffset)
                  .map((card, windowIndex) => (
                    <div key={card.path} className="mb-4">
                      {conceptFileCardPreviews[windowIndex]}
                    </div>
                  ))}
              </div>
              {/* Inside the scroller, so it scrolls away with the source it
                could not be anchored to instead of pinning above it. */}
              {renderDetachedFindingCard()}
              <div
                ref={reviewUnitStartRef}
                data-review-member-id={activeUnit.id}
                data-selected="true"
                className="mx-4 scroll-mt-5"
              >
                <div className="sticky top-0 z-20">
                  <div
                    aria-hidden="true"
                    className={cn(
                      "bg-code pointer-events-none absolute inset-x-[-1rem] bottom-full h-5",
                      !selectedCardStuck && "hidden",
                    )}
                  />
                  <div
                    className={cn(
                      "overflow-hidden border-x border-b border-cyan/35 bg-panel shadow-[0_0_0_1px_color-mix(in_srgb,var(--app-cyan)_8%,transparent)]",
                      selectedCardStuck
                        ? "rounded-none border-t-0"
                        : "rounded-t-xl border-t",
                    )}
                  >
                    <ReviewFileCardHeader
                      members={activeFileCardMembers}
                      index={activeConceptCardIndex}
                      count={activeConceptFileCards.length}
                      itemLabel={reviewMode === "files" ? "File" : "Card"}
                      selected
                      sourceBytes={reviewSourceByteLength(activeModule)}
                      onResumeWaiting={
                        fileWaitingUnitIds.length > 0
                          ? stopWaitingOnActive
                          : undefined
                      }
                      expanded={selectedFileSourceExpanded}
                      onToggleExpanded={() => {
                        setFileSourceReveal({
                          path: activeUnit.path,
                          reviewed: activeFileCardReviewed,
                          expanded: !selectedFileSourceExpanded,
                        });
                      }}
                      actions={
                        selectedFileSourceExpanded &&
                        activeUnit.kind !== "binary" ? (
                          <ReviewUnitViewOptions
                            importsVisible={importsVisible}
                            fullFileVisible={fullFileVisible}
                            importsDisabled={!activeModule}
                            fullFileDisabled={!contextAvailable}
                            onToggleImports={() =>
                              setImportContextUnitIds((current) => {
                                const next = new Set(current);
                                if (next.has(activeUnit.id))
                                  next.delete(activeUnit.id);
                                else next.add(activeUnit.id);
                                return next;
                              })
                            }
                            onToggleFullFile={() =>
                              setFullFileUnitIds((current) => {
                                const next = new Set(current);
                                if (next.has(activeUnit.id))
                                  next.delete(activeUnit.id);
                                else next.add(activeUnit.id);
                                return next;
                              })
                            }
                          />
                        ) : undefined
                      }
                    />
                    <ReviewScrollOverviewStrip
                      className="px-3 py-2 sm:px-3 lg:px-3"
                      label={
                        activeUnit
                          ? `L${activeUnit.startLine}–${activeUnit.endLine} · ${overviewLineCount} lines`
                          : undefined
                      }
                      marks={overviewMarks}
                      rows={overviewRows}
                      revealWholeFile={fullFileVisible}
                      unitRange={overviewUnitRange}
                      viewport={overviewViewport}
                      onSeek={seekCodeOverview}
                    />
                  </div>
                </div>
                <div
                  ref={codeOverviewRef}
                  className={cn(
                    "-mt-px",
                    !sideBySideVisible &&
                      "overflow-hidden rounded-b-xl border-x border-b border-line bg-code",
                  )}
                >
                  {!selectedFileSourceExpanded &&
                  activeFileCardSourceAvailable ? (
                    <ReviewFileCardSourcePlaceholder
                      framed
                      itemLabel={reviewMode === "files" ? "file" : "card"}
                      language={activeUnit.language}
                      lineCount={activeFileCardLineCount}
                      onShow={() =>
                        setFileSourceReveal({
                          path: activeUnit.path,
                          reviewed: activeFileCardReviewed,
                          expanded: true,
                        })
                      }
                      path={activeUnit.path}
                      reviewed={activeFileCardReviewed}
                      sourceBytes={reviewSourceByteLength(activeModule)}
                    />
                  ) : null}
                  {selectedFileSourceExpanded && sideBySideVisible && (
                    <SideBySideUnitDiff
                      key={activeUnit.id}
                      ref={diffContextRef}
                      previousSource={diffPreviousSource}
                      currentSource={diffCurrentSource}
                      language={activeUnit.language}
                      previousStartLine={1}
                      currentStartLine={1}
                      previousFocusRanges={previousCardRanges}
                      currentFocusRanges={currentCardRanges}
                      previousFocusStartLine={
                        activeUnit.changeType === "added"
                          ? null
                          : (previousCardRanges.at(0)?.startLine ??
                            previousUnitStartLine)
                      }
                      previousFocusEndLine={
                        activeUnit.changeType === "added"
                          ? null
                          : (previousCardRanges.at(-1)?.endLine ??
                            previousUnitEndLine)
                      }
                      currentFocusStartLine={
                        activeUnit.changeType === "deleted"
                          ? null
                          : (cardStartLine ?? activeUnit.startLine)
                      }
                      currentFocusEndLine={
                        activeUnit.changeType === "deleted"
                          ? null
                          : (cardEndLine ?? activeUnit.endLine)
                      }
                      selectedLine={selectedLine}
                      keyboardLine={keyboardLine ?? aiQuestionPreviewLine}
                      findingLine={findingLine}
                      expanded={fullFileVisible}
                      isReviewLineCollapsed={isFileUnitLineCollapsed}
                      onSelectReviewLine={commentOnCardLine}
                      onAskReviewLine={askAboutCardLine}
                      renderBeforeLine={renderFileUnitMarkers}
                      renderLineDetails={renderReviewLineDetails}
                    />
                  )}
                  {activeFileCardHydrationPending &&
                    !activeFileCardSourceAvailable && (
                      <div
                        className="min-h-72 animate-pulse bg-surface/10 px-5 py-6 font-sans"
                        aria-live="polite"
                      >
                        <span className="sr-only">
                          Loading and verifying private source…
                        </span>
                        <div aria-hidden="true" className="space-y-3">
                          <div className="bg-line-strong h-2 w-2/5 rounded-full" />
                          <div className="bg-line h-2 w-4/5 rounded-full" />
                          <div className="bg-line h-2 w-3/5 rounded-full" />
                          <div className="bg-line h-2 w-11/12 rounded-full" />
                          <div className="bg-line h-2 w-2/3 rounded-full" />
                        </div>
                      </div>
                    )}
                  {!activeFileCardHydrationPending &&
                    !activeFileCardSourceAvailable && (
                      <div className="mx-auto grid min-h-72 max-w-lg place-items-center px-6 py-12 font-sans">
                        <div className="w-full rounded-2xl border border-line bg-surface/45 p-8 text-center shadow-[0_18px_60px_var(--app-shadow)]">
                          <FileCode2
                            className="text-fog mx-auto size-6"
                            aria-hidden="true"
                          />
                          <p className="text-cloud mt-4 text-sm font-medium">
                            Source unavailable
                          </p>
                          <p className="text-mist mt-2 text-xs leading-5">
                            This private source could not be verified and
                            loaded. Reload the review before signing off this
                            unit.
                          </p>
                        </div>
                      </div>
                    )}
                  {selectedFileSourceExpanded &&
                    importsVisible &&
                    !sideBySideVisible &&
                    activeFileCardSourceAvailable &&
                    activeModule && (
                      <UnitImportContext
                        key={activeUnit.id}
                        fileSource={activeModule.source}
                        previousFileSource={
                          activeModule.previousSource ?? undefined
                        }
                        unitSource={activeUnit.source}
                        language={activeUnit.language}
                        unitId={activeUnit.id}
                        visibleStartLine={visibleStartLine}
                        visibleEndLine={visibleEndLine}
                        previousVisibleStartLine={previousUnitStartLine}
                        previousVisibleEndLine={previousUnitEndLine}
                        resolvingImport={resolvingImport}
                        onFollow={(reference) => void followImport(reference)}
                      />
                    )}
                  {selectedFileSourceExpanded &&
                    !sideBySideVisible &&
                    activeFileCardSourceAvailable &&
                    contextAvailable &&
                    !fullFileVisible && (
                      <ContextRevealControl
                        availableLines={availableBefore}
                        className="mb-3"
                        direction="above"
                        onReveal={revealContextAbove}
                        revealedLines={contextBefore}
                        shortcut={reviewShortcuts.revealContextAbove}
                      />
                    )}
                  {selectedFileSourceExpanded &&
                    activeFileCardSourceAvailable &&
                    activeUnit.kind === "binary" && (
                      <ReviewBinaryPreview
                        path={activeUnit.path}
                        unitId={activeUnit.id}
                      />
                    )}
                  {selectedFileSourceExpanded &&
                    !sideBySideVisible &&
                    activeFileCardSourceAvailable &&
                    activeUnit.kind !== "binary" && (
                      <SourceLineWindow
                        key={activeUnit.id}
                        items={displayedLineEntries}
                        lineNumberForItem={(entry) => entry.lineNumber}
                        pinnedLines={pinnedReviewLines}
                        rowHeight={WORKSPACE_SOURCE_ROW_HEIGHT_PX}
                        startLine={visibleStartLine}
                        renderLine={(entry, lineNumber) => {
                          const { line } = entry;
                          const unitMarkers = renderFileUnitMarkers(lineNumber);
                          if (isFileUnitLineCollapsed(lineNumber)) {
                            return (
                              <Fragment key={`${activeUnit.id}-${lineNumber}`}>
                                {unitMarkers}
                              </Fragment>
                            );
                          }
                          const isUnitLine = isPrimaryReviewLine(lineNumber);
                          const isChangedLine =
                            isUnitLine && changedCurrentLines.has(lineNumber);
                          const isContextLine = !isUnitLine;
                          const coveringExplanations = isUnitLine
                            ? explanationAnnotations.filter(
                                (annotation) =>
                                  lineNumber >= annotation.line &&
                                  lineNumber <=
                                    (annotation.endLine ?? annotation.line),
                              )
                            : [];
                          return (
                            <Fragment key={`${activeUnit.id}-${lineNumber}`}>
                              {unitMarkers}
                              {contextBefore > 0 &&
                                lineNumber === cardStartLine &&
                                cardStartLine && (
                                  <ReviewScopeMarker
                                    edge="start"
                                    line={cardStartLine}
                                  />
                                )}
                              {lineNumber === activeUnit.startLine &&
                                previousRewriteLines.map(
                                  (line, previousIndex) => {
                                    const previousLineNumber =
                                      previousUnitStartLine + previousIndex;
                                    return (
                                      <div
                                        key={`${activeUnit.id}-previous-${previousIndex}`}
                                        className="group grid grid-cols-[66px_1fr] border-l-2 border-l-red-400/45 bg-red-400/15 px-4 hover:bg-red-400/20"
                                      >
                                        <span className="flex items-center justify-end pr-3 text-right text-red-700 opacity-80 select-none dark:text-red-200">
                                          {previousLineNumber}
                                        </span>
                                        <pre className="syntax-code overflow-visible text-cloud line-through opacity-80">
                                          <HighlightedTokens
                                            tokens={line.tokens}
                                          />
                                        </pre>
                                      </div>
                                    );
                                  },
                                )}
                              <div
                                id={`review-line-${lineNumber}`}
                                className={cn(
                                  "group grid grid-cols-[66px_1fr] border-l-2 border-transparent px-4 hover:bg-surface-subtle",
                                  contextVisible &&
                                    isUnitLine &&
                                    "border-l-cyan/35 bg-cyan/[.012]",
                                  isChangedLine &&
                                    "border-l-addition/45 bg-addition/15 hover:bg-addition/20",
                                  isContextLine &&
                                    "bg-surface-subtle/15 opacity-55 hover:opacity-80",
                                  coveringExplanations.length > 0 &&
                                    "bg-violet/[.025] shadow-[inset_2px_0_0_var(--app-ai)]",
                                  // Amber already means "AI review finding" in this
                                  // file, and is the one tint not already spoken for by
                                  // the line picker, the composer, additions or
                                  // deletions. Both of those still win over it below.
                                  findingLine === lineNumber &&
                                    "bg-amber-400/[.09] shadow-[inset_2px_0_0_rgb(245_158_11/.85)]",
                                  selectedLine === lineNumber &&
                                    "bg-violet/[.055]",
                                  keyboardLine === lineNumber &&
                                    "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
                                  aiQuestionPreviewLine === lineNumber &&
                                    "bg-violet/[.075] shadow-[inset_2px_0_0_var(--app-ai)]",
                                )}
                              >
                                {isUnitLine && activeUnit.kind !== "binary" ? (
                                  <span
                                    className={cn(
                                      "flex items-center justify-end gap-1 pr-1.5 text-right text-fog select-none",
                                      isChangedLine &&
                                        "bg-addition/20 text-addition",
                                    )}
                                  >
                                    <AskAiLineButton
                                      line={lineNumber}
                                      onAsk={askAboutCardLine}
                                      visible={aiQuestionLine === lineNumber}
                                    />
                                    <button
                                      type="button"
                                      aria-label={`Comment on line ${lineNumber}`}
                                      aria-pressed={selectedLine === lineNumber}
                                      onClick={() =>
                                        commentOnCardLine(lineNumber)
                                      }
                                      className="hover:text-violet flex items-center gap-1 transition"
                                    >
                                      <MessageSquareText
                                        className={cn(
                                          "size-3 transition-opacity",
                                          selectedLine === lineNumber ||
                                            keyboardLine === lineNumber
                                            ? "text-cyan opacity-100"
                                            : "opacity-0 group-hover:opacity-100",
                                        )}
                                      />
                                      <span>{lineNumber}</span>
                                    </button>
                                  </span>
                                ) : (
                                  <span className="flex items-center justify-end pr-3 text-right text-fog select-none">
                                    {lineNumber}
                                  </span>
                                )}
                                <pre className="syntax-code overflow-visible text-cloud">
                                  <HighlightedTokens
                                    tokens={line.tokens}
                                    renderToken={({
                                      children,
                                      className,
                                      token,
                                    }) => {
                                      const startingReference =
                                        importReferenceByStart.get(token.from);
                                      const importReference =
                                        startingReference &&
                                        startingReference.to <= token.to
                                          ? startingReference
                                          : undefined;
                                      const resolutionKey = importReference
                                        ? `${activeUnit.id}:${importReference.from}:${importReference.to}`
                                        : undefined;
                                      return importReference ? (
                                        <button
                                          type="button"
                                          aria-label={`Open ${importReference.local} from ${importReference.specifier}`}
                                          title={`Open ${importReference.specifier}`}
                                          disabled={
                                            resolvingImport === resolutionKey
                                          }
                                          onClick={() =>
                                            void followImport(importReference)
                                          }
                                          {...symbolPeekAttributes(
                                            importReference.local,
                                            lineNumber,
                                          )}
                                          className={cn(
                                            "text-cyan decoration-cyan/55 hover:bg-cyan/[.09] cursor-pointer rounded-sm underline decoration-dotted underline-offset-4 transition",
                                            className,
                                            resolvingImport === resolutionKey &&
                                              "animate-pulse cursor-wait",
                                          )}
                                        >
                                          {children}
                                        </button>
                                      ) : isPeekableToken(token) ? (
                                        <span
                                          {...symbolPeekAttributes(
                                            token.text,
                                            lineNumber,
                                          )}
                                          className={cn(
                                            "hover:decoration-cyan/45 rounded-sm hover:underline hover:decoration-dotted hover:underline-offset-4",
                                            className,
                                          )}
                                        >
                                          {children}
                                        </span>
                                      ) : (
                                        <span className={className}>
                                          {children}
                                        </span>
                                      );
                                    }}
                                  />
                                </pre>
                              </div>
                              {isUnitLine &&
                                renderReviewLineDetails(lineNumber)}
                              {contextAfter > 0 &&
                                lineNumber === cardEndLine &&
                                cardEndLine && (
                                  <ReviewScopeMarker
                                    edge="end"
                                    line={cardEndLine}
                                  />
                                )}
                            </Fragment>
                          );
                        }}
                      />
                    )}
                  {selectedFileSourceExpanded &&
                    !sideBySideVisible &&
                    contextAvailable &&
                    !fullFileVisible && (
                      <ContextRevealControl
                        availableLines={availableAfter}
                        className="mt-3"
                        direction="below"
                        onReveal={revealContextBelow}
                        revealedLines={contextAfter}
                        shortcut={reviewShortcuts.revealContextBelow}
                      />
                    )}
                </div>
              </div>
              {viewerCardWindow.cards
                .slice(selectedWindowOffset + 1)
                .map((card, cardOffset) => (
                  <div key={card.path} className="mt-4">
                    {
                      conceptFileCardPreviews[
                        selectedWindowOffset + cardOffset + 1
                      ]
                    }
                  </div>
                ))}
              {reviewMode === "files" && viewerCardWindow.hiddenBelow > 0 && (
                <div className="mt-4 flex items-center gap-3 px-4 font-sans">
                  <span className="h-px flex-1 bg-line" />
                  <button
                    type="button"
                    onClick={() =>
                      setFilesViewerBelow(
                        (current) => current + FILES_VIEWER_PAGE_SIZE,
                      )
                    }
                    className="text-fog hover:border-cyan/25 hover:bg-cyan/[.05] hover:text-cyan flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[9px] transition"
                  >
                    Show{" "}
                    {Math.min(
                      FILES_VIEWER_PAGE_SIZE,
                      viewerCardWindow.hiddenBelow,
                    )}{" "}
                    more files below
                  </button>
                  <span className="h-px flex-1 bg-line" />
                </div>
              )}
            </div>
            {aiStatus.data?.status === "completed" && aiStatus.data.result && (
              <details className="group border-violet/15 bg-violet/[.025] border-t xl:hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                  <span className="text-violet flex min-w-0 items-center gap-2 text-xs font-medium">
                    <Sparkles className="size-3.5 shrink-0" />
                    <span className="truncate">Overall explanation</span>
                  </span>
                  <span className="text-fog flex shrink-0 items-center gap-2 text-[9px]">
                    {explanationAnnotations.length > 0 &&
                      `${explanationAnnotations.length} inline ${explanationAnnotations.length === 1 ? "note" : "notes"}`}
                    <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
                  </span>
                </summary>
                <ProviderCommentBody
                  body={aiStatus.data.result.summary}
                  className="mt-0 max-w-none border-t border-violet/10 px-4 py-3 text-xs leading-5"
                />
              </details>
            )}
            <div className="border-violet/15 bg-violet/[.025] flex items-center justify-end gap-2 border-t px-3 py-3 sm:px-4 xl:hidden">
              {renderAiActionButtons()}
              {renderPullRequestDetailsButton({
                className: "size-11 border border-line",
              })}
            </div>
            <div className="bg-panel/45 flex items-center justify-end gap-2 border-t border-line px-3 py-3 sm:gap-3 sm:px-7 sm:py-4">
              <div className="text-fog mr-auto hidden min-w-0 items-center gap-4 text-[9px] sm:flex">
                {reviewComplete ? (
                  <span
                    role="status"
                    className="text-lime flex items-center gap-2 whitespace-nowrap"
                  >
                    <CheckCheck className="size-3.5" />
                    All {signedCount} units reviewed
                  </span>
                ) : reviewCaughtUp ? (
                  <span
                    role="status"
                    className={cn(
                      "flex items-center gap-2 whitespace-nowrap",
                      answeredWaitCount > 0 ? "text-lime" : "text-cyan",
                    )}
                  >
                    {answeredWaitCount > 0 ? (
                      <MessageSquareText className="size-3.5" />
                    ) : (
                      <Clock3 className="size-3.5" />
                    )}
                    {answeredWaitCount > 0
                      ? `All available work reviewed · ${answeredWaitCount} ${answeredWaitCount === 1 ? "response" : "responses"} ready`
                      : `All available work reviewed · ${waitingCount} waiting`}
                  </span>
                ) : (
                  <span className="hidden items-center gap-3 xl:flex">
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      <ShortcutAlternatives
                        shortcut={reviewShortcuts.scrollUp}
                        alternateShortcut={reviewShortcuts.scrollDown}
                      />
                      {aiQuestionLine === undefined
                        ? "Scroll"
                        : "Move question"}
                    </span>
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      <ShortcutAlternatives
                        shortcut={reviewShortcuts.previousUnit}
                        alternateShortcut={reviewShortcuts.nextUnit}
                      />
                      Card
                    </span>
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      <ShortcutAlternatives
                        shortcut={reviewShortcuts.previousConcept}
                        alternateShortcut={reviewShortcuts.nextConcept}
                      />
                      Concept
                    </span>
                  </span>
                )}
              </div>
              {footerSaveState === "background" && (
                <span
                  role="status"
                  aria-label={`Saving reviews, ${backgroundSaveProgress}`}
                  className="border-line-strong bg-surface text-mist flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border px-2.5 text-[10px] shadow-[0_8px_24px_var(--app-shadow)] sm:h-10 sm:px-3"
                >
                  <LoaderCircle className="size-3 animate-spin" />
                  <span className="hidden sm:inline">Saving</span>
                  <span className="font-mono text-cloud">
                    {backgroundSaveProgress}
                  </span>
                </span>
              )}
              {footerSaveState === "finalizing" ? (
                <Button
                  className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-5"
                  disabled
                  aria-label={`Finishing review, ${backgroundSaveProgress}`}
                >
                  <LoaderCircle className="size-4 animate-spin" />
                  Finishing {backgroundSaveProgress}…
                </Button>
              ) : reviewComplete ? (
                <div className="flex min-w-0 items-center justify-end gap-2">
                  {activeConceptProgress?.status === "signed_off" && (
                    <Button
                      variant="secondary"
                      className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-4"
                      onClick={unreviewActiveUnit}
                    >
                      <Undo2 className="size-4" />
                      <span className="hidden sm:inline">Undo concept</span>
                      <span className="sm:hidden">Undo</span>
                      <ShortcutHint
                        shortcut={reviewShortcuts.undoReview}
                        className="hidden sm:inline-flex"
                      />
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    className="h-10 px-3 sm:h-11 sm:px-4"
                    onClick={() => setCompletionOpen(true)}
                  >
                    {providerReviewState.data?.decision === "approved" ? (
                      <CheckCircle2 className="size-4 text-lime" />
                    ) : providerReviewState.isFetching ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="size-4" />
                    )}
                    <span className="hidden sm:inline">
                      {providerReviewState.data?.decision === "approved"
                        ? "Approved"
                        : "Provider approval"}
                    </span>
                  </Button>
                  {nextReview ? (
                    <Button
                      className="h-10 px-3 sm:h-11 sm:px-5"
                      loading={navigationPending}
                      onClick={openNextReview}
                    >
                      Next review
                      {!navigationPending && (
                        <ChevronRight className="size-4" />
                      )}
                      <ShortcutHint
                        shortcut={reviewShortcuts.nextReview}
                        className="hidden sm:inline-flex"
                      />
                    </Button>
                  ) : (
                    <Button
                      className="h-10 px-3 sm:h-11 sm:px-5"
                      loading={navigationPending}
                      onClick={openPullRequests}
                    >
                      {!navigationPending && <ArrowLeft className="size-4" />}
                      Pull requests
                      <ShortcutHint
                        shortcut={reviewShortcuts.dashboard}
                        className="hidden sm:inline-flex"
                      />
                    </Button>
                  )}
                </div>
              ) : reviewCaughtUp ? (
                <div className="flex min-w-0 items-center justify-end gap-2">
                  {canStopWaiting && (
                    <Button
                      variant={activeUnitAnswered ? "primary" : "secondary"}
                      className="h-10 px-3 sm:h-11 sm:px-4"
                      onClick={stopWaitingOnActive}
                    >
                      {activeUnitAnswered ? (
                        <MessageSquareText className="size-4" />
                      ) : (
                        <Clock3 className="size-4" />
                      )}
                      <span className="hidden sm:inline">
                        {fileWaitingUnitIds.length > 1
                          ? `Resume waiting (${fileWaitingUnitIds.length})`
                          : activeUnitAnswered
                            ? "Resume review"
                            : "Stop waiting"}
                      </span>
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    className="h-10 px-3 sm:h-11 sm:px-4"
                    onClick={() => setWaitingCompletionOpen(true)}
                  >
                    {answeredWaitCount > 0 ? (
                      <MessageSquareText className="text-lime size-4" />
                    ) : (
                      <Clock3 className="text-cyan size-4" />
                    )}
                    <span className="hidden sm:inline">
                      {answeredWaitCount > 0
                        ? `View ${answeredWaitCount} ${answeredWaitCount === 1 ? "response" : "responses"}`
                        : `View ${waitingCount} waiting`}
                    </span>
                    <span className="sm:hidden">
                      {answeredWaitCount > 0 ? "Responses" : "Waiting"}
                    </span>
                  </Button>
                  {nextReview ? (
                    <Button
                      className="h-10 px-3 sm:h-11 sm:px-5"
                      onClick={openNextReview}
                    >
                      Next review
                      <ChevronRight className="size-4" />
                    </Button>
                  ) : (
                    <Button
                      className="h-10 px-3 sm:h-11 sm:px-5"
                      onClick={openPullRequests}
                    >
                      <ArrowLeft className="size-4" />
                      Pull requests
                      <ShortcutHint
                        shortcut={reviewShortcuts.dashboard}
                        className="hidden sm:inline-flex"
                      />
                    </Button>
                  )}
                </div>
              ) : (
                <div className="flex min-w-0 items-center justify-end gap-2">
                  {canSignOffDeletedFiles && footerSaveState !== "active" && (
                    <Button
                      variant="secondary"
                      className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-4"
                      title={`Sign off ${deletedUnitsToSignOff.length} remaining ${deletedUnitsToSignOff.length === 1 ? "unit" : "units"} from files deleted in this pull request`}
                      onClick={signOffDeletedFiles}
                    >
                      <CheckCheck className="size-4" />
                      <span className="hidden sm:inline">Sign off deletes</span>
                      <span className="sm:hidden">Deletes</span>
                      <ShortcutHint
                        shortcut={reviewShortcuts.signOffDeletions}
                        className="hidden sm:inline-flex"
                      />
                    </Button>
                  )}
                  {activeUnit.status === "signed_off" &&
                    activeWaitStatus !== "waiting" &&
                    footerSaveState !== "active" && (
                      <Button
                        variant="secondary"
                        className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-4"
                        onClick={unreviewActiveUnit}
                      >
                        <Undo2 className="size-4" />
                        <span className="hidden sm:inline">Undo review</span>
                        <span className="sm:hidden">Undo</span>
                        <ShortcutHint
                          shortcut={reviewShortcuts.undoReview}
                          className="hidden sm:inline-flex"
                        />
                      </Button>
                    )}
                  {canStopWaiting && !fileIsFullyWaiting ? (
                    // Waiting is reversible from the file itself: the clock
                    // in the sidebar, the card pill, and this footer control
                    // all return the paused units without a detour.
                    <Button
                      variant={activeUnitAnswered ? "primary" : "secondary"}
                      className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-4"
                      title={
                        fileWaitingUnitIds.length > 1
                          ? `Take back ${fileWaitingUnitIds.length} waits in this file and return them to the review path`
                          : activeUnitAnswered
                            ? "The conversation has a response — return this work to your review path"
                            : "Take back the wait and return this work to your review path"
                      }
                      onClick={stopWaitingOnActive}
                    >
                      {activeUnitAnswered ? (
                        <MessageSquareText className="size-4" />
                      ) : (
                        <Clock3 className="size-4" />
                      )}
                      <span className="hidden sm:inline">
                        {fileWaitingUnitIds.length > 1
                          ? `Resume waiting (${fileWaitingUnitIds.length})`
                          : activeUnitAnswered
                            ? "Resume review"
                            : "Stop waiting"}
                      </span>
                      <span className="sm:hidden">Resume</span>
                      <ShortcutHint
                        shortcut={reviewShortcuts.undoReview}
                        className="hidden sm:inline-flex"
                      />
                    </Button>
                  ) : (
                    hasLiveConversation &&
                    footerSaveState !== "active" && (
                      <Button
                        variant="secondary"
                        className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-4"
                        title={`Pause this unit until ${providerLabel(initialData.pullRequest.provider)} receives a reply or the code changes`}
                        onClick={awaitActiveResponse}
                        disabled={!canAwaitUnit}
                      >
                        {awaitPending ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <Clock3 className="size-4" />
                        )}
                        <span className="hidden sm:inline">
                          {awaitPending ? "Saving…" : "Await response"}
                        </span>
                        <span className="sm:hidden">
                          {awaitPending ? "Saving…" : "Await"}
                        </span>
                        {!awaitPending && (
                          <ShortcutHint
                            shortcut={reviewShortcuts.awaitResponse}
                            className="hidden sm:inline-flex"
                          />
                        )}
                      </Button>
                    )
                  )}
                  {(!primaryIsContinue || hasNextActionableUnit) &&
                    (conceptActionAvailable && !primaryIsContinue ? (
                      <SplitActionButton
                        icon={<Check className="size-4" />}
                        label={primaryActionLabel}
                        mobileLabel={
                          activeSignOffPending
                            ? signOffQueueProgress
                            : "Sign off"
                        }
                        menuLabel="Choose what to sign off"
                        pending={activeSignOffPending}
                        primary={{
                          disabled: !canUsePrimaryAction,
                          label: primaryActionLabel,
                          onSelect: runPrimaryAction,
                          shortcut: reviewShortcuts.signOff,
                        }}
                        options={[
                          {
                            description:
                              reviewMode === "files" && activeReviewFile
                                ? `Record all ${activeFileOutstandingUnits} outstanding units in this file`
                                : cardActionAvailable
                                  ? `Record all ${outstandingCardMembers.length} outstanding units represented by this file card`
                                  : "Record this unit and open the next card in the concept",
                            disabled:
                              reviewMode === "files"
                                ? !canSignOffActiveFile
                                : cardActionAvailable
                                  ? !canSignOffCard
                                  : !canSignOffUnit,
                            label:
                              reviewMode === "files"
                                ? "Sign off file"
                                : cardActionAvailable
                                  ? "Sign off card"
                                  : "Sign off unit",
                            onSelect:
                              reviewMode === "files" && activeReviewFile
                                ? () => toggleReviewFile(activeReviewFile)
                                : cardActionAvailable
                                  ? signOffActiveCard
                                  : signOffActiveUnit,
                            shortcut: reviewShortcuts.signOff,
                          },
                          {
                            description: `Record all ${activeConceptMembers.length} units of this concept at once`,
                            disabled: !canSignOffConcept,
                            label: "Sign off concept",
                            onSelect: signOffActiveConcept,
                            shortcut: reviewShortcuts.signOffConcept,
                          },
                        ]}
                      />
                    ) : (
                      <Button
                        className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-5"
                        onClick={runPrimaryAction}
                        disabled={!canUsePrimaryAction}
                      >
                        <Check className="size-4" />
                        {primaryActionLabel}
                        {!activeSignOffPending && (
                          <ShortcutHint
                            shortcut={reviewShortcuts.signOff}
                            className="hidden sm:inline-flex"
                          />
                        )}
                        <ChevronRight className="size-3.5" />
                      </Button>
                    ))}
                </div>
              )}
            </div>
          </div>
        </main>
        <aside
          id="code-explanation-panel"
          aria-label="AI assistance"
          className={cn(
            "bg-panel min-h-0 flex-col overflow-hidden border-l border-line",
            completionChromeHidden
              ? "hidden"
              : insightsPanelOpen
                ? "fixed top-16 right-0 bottom-0 z-40 flex w-[min(360px,calc(100vw-3rem))] shadow-2xl"
                : "hidden",
            !completionChromeHidden &&
              (insightsPanelCollapsed
                ? "xl:hidden"
                : "xl:relative xl:flex xl:w-auto xl:bg-panel/30 xl:shadow-none"),
          )}
        >
          {!insightsPanelCollapsed && (
            <ReviewPanelResizeHandle
              className="xl:flex"
              controls="code-explanation-panel"
              defaultWidth={REVIEW_INSIGHTS_PANEL_WIDTHS.default}
              label="Resize AI assistance"
              maximumWidth={REVIEW_INSIGHTS_PANEL_WIDTHS.maximum}
              minimumWidth={REVIEW_INSIGHTS_PANEL_WIDTHS.minimum}
              side="right"
              width={insightsPanelWidth}
              onResize={setInsightsPanelWidth}
              onCollapse={hideInsightsPanel}
            />
          )}
          <div className="border-violet/15 bg-panel z-10 flex shrink-0 flex-col gap-2.5 border-b px-4 py-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
                AI assistance
              </p>
              {renderPullRequestDetailsButton({
                className: "h-7 px-1.5 text-[10px]",
                label: "About this PR",
              })}
            </div>
            {renderAiActionButtons()}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="rounded-xl border border-line bg-surface/55 p-3">
              <div className="flex items-center gap-2">
                <Badge className="capitalize">{activeUnit.kind}</Badge>
                <span className="text-fog text-[9px]">
                  Lines {activeUnit.startLine}–{activeUnit.endLine}
                </span>
              </div>
              <p className="text-cloud mt-2 truncate font-mono text-xs">
                {activeUnit.name}
              </p>
              <p className="text-fog mt-1 truncate font-mono text-[9px]">
                {activeUnit.path}
              </p>
            </div>

            {activeUnit.kind === "binary" ? (
              <div className="mt-4 rounded-xl border border-dashed border-line p-4">
                <p className="text-mist text-xs leading-5">
                  Binary content is intentionally not sent to an AI model.
                </p>
              </div>
            ) : aiStatus.data?.status === "completed" &&
              aiStatus.data.result ? (
              <div className="border-violet/15 bg-violet/[.035] mt-4 rounded-xl border p-4">
                <p className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
                  Overall explanation
                </p>
                <ProviderCommentBody
                  body={aiStatus.data.result.summary}
                  className="mt-2 max-w-none text-xs leading-5"
                />
                {explanationAnnotations.length > 0 && (
                  <div className="mt-4 border-t border-violet/15 pt-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-violet text-[9px] font-semibold tracking-[.12em] uppercase">
                        Inline walkthrough
                      </p>
                      <span className="text-fog text-[9px]">
                        {explanationAnnotations.length}{" "}
                        {explanationAnnotations.length === 1 ? "note" : "notes"}
                      </span>
                    </div>
                    <div className="mt-2 grid gap-1">
                      {explanationAnnotations.map((annotation, index) => (
                        <button
                          key={`${annotation.line}-${annotation.title}`}
                          type="button"
                          onClick={() =>
                            revealExplanation(
                              annotation.endLine ?? annotation.line,
                              index,
                            )
                          }
                          className="text-mist hover:bg-violet/[.06] hover:text-cloud flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[10px] transition"
                        >
                          <span className="border-violet/20 bg-violet/[.06] text-violet inline-flex min-w-7 shrink-0 justify-center rounded-md border px-1.5 py-0.5 font-mono text-[8px]">
                            {annotation.line}
                          </span>
                          <span className="truncate">{annotation.title}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : explanationRunning ? (
              <ExplanationLoader unitKind={activeUnit.kind} />
            ) : (
              <div className="mt-4 rounded-xl border border-dashed border-line p-4">
                <p className="text-mist text-xs leading-5">
                  Press E or choose Ask to start a focused question beside the
                  code you are reviewing.
                </p>
              </div>
            )}
            {aiStatus.data?.status === "failed" &&
              !startExplanation.isPending && (
                <div
                  role="status"
                  className="mt-3 rounded-lg border border-red-500/20 bg-red-400/10 p-3 text-red-700 dark:border-red-300/15 dark:text-red-200"
                >
                  <p className="text-xs font-medium">
                    {explanationError.title}
                  </p>
                  <p className="mt-1 text-[11px] leading-5 opacity-80">
                    {explanationError.detail}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canUseAi}
                    onClick={explainActiveUnit}
                    className="mt-2 h-7 border border-red-500/15 px-2.5 text-[10px] text-current hover:bg-red-500/10"
                  >
                    <RefreshCw className="size-3" />
                    Try again
                  </Button>
                </div>
              )}
            {renderDeepReviewPanel()}
            {aiUsage.data && (
              <section
                aria-label="AI usage for this pull request"
                className="mt-5 border-t border-line pt-4"
              >
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <p className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
                      AI usage · this PR
                    </p>
                    <p className="text-mist mt-1 text-[10px]">
                      {aiUsage.data.runs}{" "}
                      {aiUsage.data.runs === 1 ? "run" : "runs"}
                    </p>
                  </div>
                  <p className="text-cloud font-mono text-lg leading-none font-medium">
                    {formatTokenCount(aiUsage.data.totalTokens)}
                    <span className="text-fog ml-1 font-sans text-[9px] font-normal">
                      total
                    </span>
                  </p>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line">
                  {[
                    ["Input", aiUsage.data.inputTokens],
                    ["Output", aiUsage.data.outputTokens],
                    ["Cache read", aiUsage.data.cacheReadTokens],
                    ["Cache write", aiUsage.data.cacheWriteTokens],
                  ].map(([label, value]) => (
                    <div key={label} className="bg-surface/80 px-3 py-2.5">
                      <dt className="text-fog text-[9px]">{label}</dt>
                      <dd className="text-cloud mt-1 font-mono text-[11px]">
                        {Number(value).toLocaleString("en-US")}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
            <div className="mt-5 border-t border-line pt-4">
              <p className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
                Why this unit is next
              </p>
              <p className="text-mist mt-2 text-[11px] leading-5">
                {activeUnitFoundation?.foundation
                  ? `This ${activeUnitFoundation.reason === "schema" ? "schema or model" : "data shape"} establishes vocabulary used by later behavior. Its required dependencies still appear first.`
                  : `Dependency depth ${activeUnit.depth}. This path finishes the current dependency branch before moving to the next independent concept.`}
              </p>
            </div>
          </div>
          <div className="shrink-0 border-t border-line p-3">
            <button
              type="button"
              aria-label="Hide AI assistance"
              title="Hide AI assistance"
              onClick={hideInsightsPanel}
              className="text-mist hover:bg-surface-subtle hover:text-cloud flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-[10px] transition"
            >
              <PanelRightClose className="size-3.5" />
              <span>Hide AI assistance</span>
              <ShortcutHint
                shortcut={reviewShortcuts.toggleInsightsPanel}
                className="ml-auto"
              />
            </button>
          </div>
        </aside>

        {peekedSymbol &&
          peekedDefinition.data?.kind === "unresolved" &&
          (() => {
            const message = symbolPeekNotice(peekedDefinition.data.reason);
            return message ? (
              <SymbolPeekMessage message={message} peeked={peekedSymbol} />
            ) : null;
          })()}
        {peekedSymbol && peekedDefinition.data?.kind === "definition" && (
          <SymbolPeekCard
            peeked={peekedSymbol}
            definition={peekedDefinition.data}
            onClose={closeSymbolPeek}
            onHold={holdSymbolPeek}
            onOpenUnit={(unitId) => {
              const index = units.findIndex((unit) => unit.id === unitId);
              if (index >= 0) selectUnit(index);
            }}
          />
        )}

        <CommandCenter
          commands={reviewCommands}
          mode={commandCenterMode}
          onClose={() => setCommandCenterMode(undefined)}
        />
        <ShortcutSequenceIndicator sequence={pendingShortcut} />

        {hierarchyOpen && (
          <ReviewHierarchyDialog
            roots={reviewHierarchy}
            activeUnitId={activeUnit.id}
            onSelect={selectUnit}
            onClose={() => setHierarchyOpen(false)}
          />
        )}

        {resetDialogOpen && (
          <ConfirmationDialog
            title="Reset this review?"
            description={
              <>
                ReviewDuck will sync the latest pull request changes and clear
                all of your sign-offs for this PR. Comments, conversations, and
                AI results will remain.
              </>
            }
            confirmLabel="Reset review"
            pendingLabel={
              <>
                <LoaderCircle className="size-4 animate-spin" />
                Resetting…
              </>
            }
            pending={resetReview.isPending}
            icon={<RotateCcw className="text-coral size-4" />}
            onCancel={() => setResetDialogOpen(false)}
            onConfirm={() =>
              resetReview.mutate({
                pullRequestId: initialData.pullRequest.id,
              })
            }
          />
        )}

        {aiReviewDialogOpen && (
          <ConfirmationDialog
            title="Review this pull request with AI?"
            description={
              <>
                The review agent will inspect all changed files and add
                evidence-backed findings beside the relevant code. This uses
                your configured model and contributes to this PR&apos;s token
                usage.
              </>
            }
            confirmLabel="Start AI review"
            pendingLabel={
              <>
                <LoaderCircle className="size-4 animate-spin" />
                Starting…
              </>
            }
            pending={startPullRequestReview.isPending}
            icon={<Sparkles className="text-violet size-4" />}
            onCancel={() => setAiReviewDialogOpen(false)}
            onConfirm={reviewPullRequestWithAi}
          />
        )}

        {conceptGroupingDialogOpen && (
          <ConfirmationDialog
            title="Regroup this review with AI?"
            description={
              <>
                The model reads the changed code and rebuilds your personal
                concepts around what the change is trying to do, so related
                edits across files are reviewed together. Every atomic unit
                stays in the review — only the grouping changes. This uses your
                configured model and contributes to this PR&apos;s token usage.
              </>
            }
            confirmLabel="Improve grouping"
            icon={<Sparkles className="text-violet size-4" />}
            onCancel={() => setConceptGroupingDialogOpen(false)}
            onConfirm={improveGroupingWithAi}
          />
        )}

        {splitConceptDialogOpen && activeConcept && (
          <ConfirmationDialog
            title="Split this concept?"
            description={
              <>
                Each of the {activeConcept.memberIds.length} units in &ldquo;
                {activeConcept.title}&rdquo; will become its own concept in your
                personal layout. Code, comments, sign-offs, and review coverage
                will not change — only how this review is grouped.
              </>
            }
            confirmLabel={`Split into ${activeConcept.memberIds.length} concepts`}
            icon={<GitBranch className="text-cyan size-4" />}
            iconClassName="bg-cyan/10"
            onCancel={() => setSplitConceptDialogOpen(false)}
            onConfirm={splitActiveConcept}
          />
        )}

        {pullRequestDetailsOpen && (
          <PullRequestDetailsDialog
            pullRequest={initialData.pullRequest}
            onClose={() => setPullRequestDetailsOpen(false)}
          />
        )}

        {moveMemberDialogOpen && activeConcept && (
          <ConceptMoveDialog
            concepts={initialData.concepts}
            currentConceptId={activeConcept.id}
            pending={movingMember}
            unitName={activeUnit.name}
            onSelect={moveActiveMemberToConcept}
            onClose={() => setMoveMemberDialogOpen(false)}
          />
        )}

        {importPreview && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-preview-title"
            className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-3 backdrop-blur-sm sm:p-6"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setImportPreview(undefined);
              }
            }}
          >
            <div className="bg-panel flex max-h-[88dvh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-line shadow-2xl">
              <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-4 sm:px-5">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="bg-cyan/10 grid size-9 shrink-0 place-items-center rounded-xl">
                    <FileCode2 className="text-cyan size-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2
                        id="import-preview-title"
                        className="text-cloud truncate font-mono text-sm font-medium"
                      >
                        {importPreview.name === "*"
                          ? importPreview.path.split("/").at(-1)
                          : importPreview.name}
                      </h2>
                      <Badge className="capitalize">
                        {importPreview.language}
                      </Badge>
                    </div>
                    <p className="text-fog mt-1 truncate font-mono text-[10px]">
                      {importPreview.path} · lines {importPreview.startLine}–
                      {importPreview.endLine}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Close source preview"
                  onClick={() => setImportPreview(undefined)}
                  className="text-mist hover:text-cloud grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-surface-subtle"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="border-cyan/15 bg-cyan/[.03] border-b px-4 py-2.5 sm:px-5">
                <p className="text-mist text-[10px] leading-4">
                  {importPreview.inReviewPath
                    ? "Read-only source context. This import is in the pull request, but is not mapped to a standalone review unit."
                    : "Read-only source context from the pull request revision. This file is outside the changed review path."}
                </p>
              </div>
              <div className="min-h-0 flex-1 overflow-auto bg-code py-4 font-mono text-xs leading-[21px] font-medium">
                {importPreviewLines.map((line, index) => (
                  <div
                    key={`${importPreview.path}-${index}`}
                    ref={
                      importPreview.focusLine ===
                      importPreview.startLine + index
                        ? importPreviewFocusRef
                        : undefined
                    }
                    className={cn(
                      "grid min-w-max grid-cols-[55px_1fr] border-l-2 border-transparent px-4 hover:bg-surface-subtle",
                      importPreview.focusLine ===
                        importPreview.startLine + index &&
                        "border-cyan bg-cyan/[.055]",
                    )}
                  >
                    <span className="pr-3 text-right text-fog select-none">
                      {importPreview.startLine + index}
                    </span>
                    <pre className="syntax-code pr-6 text-cloud">
                      <HighlightedTokens tokens={line.tokens} />
                    </pre>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 sm:px-5">
                <span className="text-fog text-[9px]">
                  Esc closes this preview
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setImportPreview(undefined)}
                  >
                    Close
                  </Button>
                  {previewModuleIndex >= 0 && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        selectUnit(previewModuleIndex);
                        setImportPreview(undefined);
                      }}
                    >
                      Open file unit
                      <ChevronRight className="size-3" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
