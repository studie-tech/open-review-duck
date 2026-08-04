"use client";

import { useMachine } from "@xstate/react";
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
  GitBranch,
  Keyboard,
  LoaderCircle,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  CommandCenter,
  type CommandCenterItem,
  type CommandCenterMode,
  ShortcutAlternatives,
  ShortcutHint,
  ShortcutSequenceIndicator,
  useCommandCenterBindings,
} from "~/components/command-center";
import { ThemeToggle } from "~/components/theme-toggle";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import { aiErrorPresentation } from "~/lib/ai-errors";
import {
  type AiQuestionStreamUpdate,
  consumeAiQuestionStream,
} from "~/lib/ai-question-stream";
import { lockDocumentScroll } from "~/lib/document-scroll-lock";
import {
  findImportedDeclarationLine,
  findImportTargetUnit,
  type ImportReference,
} from "~/lib/import-navigation";
import { commandMenuShortcut } from "~/lib/keyboard-shortcuts";
import { hydratePrivateReviewSources } from "~/lib/private-source-client";
import {
  buildReviewHierarchy,
  createReviewNavigationHistory,
  deletedFileSignOffUnits,
  nextPendingReviewIndex,
  nextPendingReviewIndexPreferring,
  optimisticallySignOffReviewUnits,
  pushReviewNavigationHistory,
  restoreReviewUnitAfterFailedSignOff,
  reviewNavigationHistoryTarget,
  reviewPathSearchMatches,
  reviewPathSections,
} from "~/lib/review-navigation";
import { reviewFoundationPriority } from "~/lib/review-priority";
import {
  acknowledgedReviewRevision,
  acknowledgeReviewRevision,
  type ReviewRevision,
  shortRevision,
} from "~/lib/review-revision";
import {
  afterLayoutSettle,
  scrollTopAfterContextReveal,
  shouldRevealLeadingContext,
  verticalRangesOverlap,
} from "~/lib/review-scroll";
import {
  currentChangedLineIndexes,
  sourceByteOffsetLine,
  sourceStartLine,
} from "~/lib/side-by-side-diff";
import {
  createSignOffQueue,
  nextSignOffBatchSize,
  reviewFooterSaveState,
  signOffQueueReducer,
} from "~/lib/sign-off-queue";
import {
  preloadSyntaxLanguage,
  useHighlightedSource,
} from "~/lib/syntax-highlighting";
import { formatTokenCount } from "~/lib/token-usage";
import { useImportReferences } from "~/lib/tree-sitter-import-navigation";
import { useSettledValue } from "~/lib/use-settled-value";
import { cn } from "~/lib/utils";
import { api, type RouterInputs, type RouterOutputs } from "~/trpc/react";
import { ProviderCommentBody } from "./provider-comment-body";
import { ProviderReviewDecision } from "./provider-review-decision";
import { findNextReview, ReviewCompletion } from "./review-completion";

type WorkspaceData = RouterOutputs["review"]["workspace"];
type ReviewUnit = WorkspaceData["units"][number];
type ImportTarget = RouterOutputs["review"]["importTarget"];
type ImportPreview = Extract<ImportTarget, { kind: "preview" }>;
type SignOffInput = RouterInputs["review"]["signOff"];

/** Extracts the stored disjoint ranges for one side of a review concept. */
function relatedReviewRanges(
  unit: ReviewUnit | undefined,
  side: "current" | "previous",
) {
  if (!unit?.relatedRanges) return undefined;
  return unit.relatedRanges.flatMap((range) => {
    const startLine =
      side === "current" ? range.startLine : range.previousStartLine;
    const endLine = side === "current" ? range.endLine : range.previousEndLine;
    return startLine !== undefined && endLine !== undefined
      ? [{ startLine, endLine }]
      : [];
  });
}

/** Tests a line against disjoint ranges or a unit's contiguous bounds. */
function lineWithinReviewRanges(
  line: number,
  ranges: Array<{ startLine: number; endLine: number }> | undefined,
  fallbackStart: number,
  fallbackEnd: number,
) {
  return ranges
    ? ranges.some(
        ({ startLine, endLine }) => line >= startLine && line <= endLine,
      )
    : line >= fallbackStart && line <= fallbackEnd;
}

/** Clamps a requested line to the closest line in a disjoint review scope. */
function closestReviewLine(
  line: number,
  ranges: Array<{ startLine: number; endLine: number }> | undefined,
  fallbackStart: number,
  fallbackEnd: number,
) {
  const candidates = ranges ?? [
    { startLine: fallbackStart, endLine: fallbackEnd },
  ];
  return candidates.reduce((closest, range) => {
    const candidate = Math.min(range.endLine, Math.max(range.startLine, line));
    return Math.abs(candidate - line) < Math.abs(closest - line)
      ? candidate
      : closest;
  }, candidates[0]?.startLine ?? fallbackStart);
}

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

interface LiveAiQuestion {
  error: string | null;
  focusLine: number;
  id: string;
  jobId?: string;
  progress?: string;
  question: string;
  result: {
    summary: string;
    commentProposals?: Array<{
      body: string;
      line: number;
      path: string;
    }>;
  } | null;
  status: "queued" | "running" | "streaming" | "completed" | "failed";
  threadId: string;
}

import { reviewSessionMachine } from "./review-session-machine";
import {
  aiConversationVisibility,
  CONTEXT_PAGE_LINES,
  ExplanationLoader,
  INITIAL_PATH_ITEMS,
  InlineAiQuestion,
  PATH_PAGE_SIZE,
  ProviderConversation,
  providerLabel,
  ReviewHierarchyDialog,
  ReviewPathUnit,
  ReviewScopeMarker,
  rememberAiConversationVisibility,
  reviewShortcuts,
  SideBySideUnitDiff,
  type SideBySideUnitDiffHandle,
  showAiStartError,
  supportedLanguage,
  UnitImportContext,
} from "./review-workspace-support";
/** Renders the review workspace interface. */
export function ReviewWorkspace({
  initialData,
}: {
  initialData: WorkspaceData;
}) {
  const router = useRouter();
  const [reviewSession, sendReviewSession] = useMachine(reviewSessionMachine);
  useLayoutEffect(() => lockDocumentScroll(document), []);
  const [units, setUnits] = useState(initialData.units);
  const [fileContexts, setFileContexts] = useState(initialData.fileContexts);
  const [hydratedUnitIds, setHydratedUnitIds] = useState(
    () =>
      new Set(
        initialData.sourceDelivery === "direct"
          ? []
          : initialData.units.map(({ id }) => id),
      ),
  );
  const [sourceHydrationPending, setSourceHydrationPending] = useState(
    initialData.sourceDelivery === "direct" && Boolean(initialData.snapshot),
  );
  useEffect(() => {
    if (initialData.sourceDelivery !== "direct" || !initialData.snapshot)
      return;
    const snapshotId = initialData.snapshot.id;
    let active = true;
    const controller = new AbortController();
    setSourceHydrationPending(true);
    setHydratedUnitIds(new Set());
    const cache = new Map<string, Promise<Uint8Array>>();
    void Promise.all([
      hydratePrivateReviewSources(
        initialData.units,
        snapshotId,
        cache,
        4,
        controller.signal,
        (index, hydrated) => {
          if (!active) return;
          const original = initialData.units[index];
          if (!original) return;
          setUnits((current) =>
            current.map((unit) => (unit.id === original.id ? hydrated : unit)),
          );
          if (
            original.kind === "binary" ||
            original.currentBlobId ||
            original.previousBlobId
          ) {
            setHydratedUnitIds((current) => new Set(current).add(original.id));
          }
        },
      ),
      hydratePrivateReviewSources(
        initialData.fileContexts,
        snapshotId,
        cache,
        4,
        controller.signal,
        (index, hydrated) => {
          if (!active) return;
          const original = initialData.fileContexts[index];
          if (!original) return;
          setFileContexts((current) =>
            current.map((context) =>
              context.path === original.path ? hydrated : context,
            ),
          );
        },
      ),
    ]).then(([hydratedUnits, hydratedContexts]) => {
      if (!active) return;
      setSourceHydrationPending(false);
      setUnits(hydratedUnits.units);
      setFileContexts(hydratedContexts.units);
      setHydratedUnitIds(
        new Set(
          hydratedUnits.successfulIndexes.flatMap((index) => {
            const unit = initialData.units[index];
            return unit &&
              (unit.kind === "binary" ||
                unit.currentBlobId ||
                unit.previousBlobId)
              ? [unit.id]
              : [];
          }),
        ),
      );
      const failures = [
        ...hydratedUnits.failures,
        ...hydratedContexts.failures,
      ];
      if (failures.length > 0) {
        const affectedFiles = new Set(failures.map(({ path }) => path)).size;
        toast.error(
          `${affectedFiles} private source ${affectedFiles === 1 ? "file" : "files"} could not be loaded`,
          { description: "The rest of the review remains available." },
        );
      }
    });
    return () => {
      active = false;
      controller.abort();
      cache.clear();
    };
  }, [
    initialData.fileContexts,
    initialData.snapshot,
    initialData.sourceDelivery,
    initialData.units,
  ]);
  const firstPending = Math.max(
    0,
    units.findIndex(
      (unit) => unit.status !== "signed_off" && unit.status !== "waiting",
    ),
  );
  const [activeIndex, setActiveIndex] = useState(firstPending);
  const [navigationHistory, setNavigationHistory] = useState(() =>
    createReviewNavigationHistory(units[firstPending]?.id),
  );
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [showDiff, setShowDiff] = useState(true);
  const [pathSearch, setPathSearch] = useState("");
  const [queueLimit, setQueueLimit] = useState(INITIAL_PATH_ITEMS);
  const [searchLimit, setSearchLimit] = useState(INITIAL_PATH_ITEMS);
  const [reviewedLimit, setReviewedLimit] = useState(INITIAL_PATH_ITEMS);
  const [reviewedExpanded, setReviewedExpanded] = useState(false);
  const [waitingLimit, setWaitingLimit] = useState(INITIAL_PATH_ITEMS);
  const [waitingExpanded, setWaitingExpanded] = useState(true);
  const [pathPanelOpen, setPathPanelOpen] = useState(false);
  const [pathPanelCollapsed, setPathPanelCollapsed] = useState(false);
  const [insightsPanelOpen, setInsightsPanelOpen] = useState(false);
  const [insightsPanelCollapsed, setInsightsPanelCollapsed] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [selectedLine, setSelectedLine] = useState<number>();
  const [keyboardLine, setKeyboardLine] = useState<number>();
  const [contextBefore, setContextBefore] = useState(0);
  const [contextAfter, setContextAfter] = useState(0);
  const [commandCenterMode, setCommandCenterMode] =
    useState<CommandCenterMode>();
  const [hierarchyOpen, setHierarchyOpen] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [aiReviewDialogOpen, setAiReviewDialogOpen] = useState(false);
  const [aiQuestionLine, setAiQuestionLine] = useState<number>();
  const [aiQuestionThreadId, setAiQuestionThreadId] = useState<string>();
  const [focusAiQuestionComposer, setFocusAiQuestionComposer] = useState(false);
  const [aiQuestionPreviewLine, setAiQuestionPreviewLine] = useState<number>();
  const [aiQuestionDraft, setAiQuestionDraft] = useState("");
  const [liveAiQuestions, setLiveAiQuestions] = useState<LiveAiQuestion[]>([]);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [activeSyncId, setActiveSyncId] = useState<string>();
  const [revisionNotice, setRevisionNotice] = useState<{
    previous?: ReviewRevision;
  }>();
  const [importPreview, setImportPreview] = useState<ImportPreview>();
  const [resolvingImport, setResolvingImport] = useState<string>();
  const [importReturn, setImportReturn] = useState<{
    index: number;
    unitName: string;
    importedName: string;
  }>();
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const pathSearchRef = useRef<HTMLInputElement>(null);
  const codeScrollRef = useRef<HTMLDivElement>(null);
  const contextRevealGeneration = useRef(0);
  const aiQuestionMoveAnchor = useRef<
    | {
        cardTop: number;
        scrollTop: number;
      }
    | undefined
  >(undefined);
  const aiQuestionStreams = useRef(new Map<string, AbortController>());
  const dismissedAiQuestionUnits = useRef(new Set<string>());
  const diffContextRef = useRef<SideBySideUnitDiffHandle>(null);
  const reviewUnitStartRef = useRef<HTMLDivElement>(null);
  const importPreviewFocusRef = useRef<HTMLDivElement>(null);
  const [sessionId, setSessionId] = useState<string>();
  const [signOffQueue, dispatchSignOffQueue] = useReducer(
    signOffQueueReducer,
    undefined,
    createSignOffQueue,
  );
  const queuedSignOffs = useRef<QueuedSignOff[]>([]);
  const signOffDrainRunning = useRef(false);
  const utils = api.useUtils();
  const activeUnit = units[activeIndex];
  const activeUnitId = activeUnit?.id;
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
    activeUnit &&
      (initialData.sourceDelivery !== "direct" ||
        hydratedUnitIds.has(activeUnit.id)),
  );
  const settledActiveUnitId = useSettledValue(activeUnitId, 200);
  const previousActiveUnitId = useRef(activeUnitId);
  const activeUnitFoundation = activeUnit
    ? reviewFoundationPriority(activeUnit)
    : undefined;
  useLayoutEffect(() => {
    if (!activeUnit?.id) return;
    const pane = codeScrollRef.current;
    const unitStart = reviewUnitStartRef.current;
    if (!pane) return;
    if (!unitStart) {
      pane.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    const paneTop = pane.getBoundingClientRect().top;
    const unitTop = unitStart.getBoundingClientRect().top;
    pane.scrollTo({
      top: Math.max(0, pane.scrollTop + unitTop - paneTop - 20),
      behavior: "auto",
    });
  }, [activeUnit?.id]);
  useLayoutEffect(() => {
    if (aiQuestionLine === undefined) {
      aiQuestionMoveAnchor.current = undefined;
      return;
    }
    const anchor = aiQuestionMoveAnchor.current;
    if (!anchor) return;
    aiQuestionMoveAnchor.current = undefined;
    const pane = codeScrollRef.current;
    const card = document.getElementById("inline-ai-question");
    if (!pane || !card) return;
    const nextCardTop = card.getBoundingClientRect().top;
    pane.scrollTop = anchor.scrollTop + nextCardTop - anchor.cardTop;
  }, [aiQuestionLine]);
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
  }, [insightsPanelOpen, pathPanelOpen]);
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
  }, []);
  const pathSections = useMemo(
    () => reviewPathSections(units, activeIndex),
    [activeIndex, units],
  );
  const nextUnitToPreload = pathSearch.trim()
    ? (pathSections.upcoming.find(({ unit }) =>
        reviewPathSearchMatches(unit, pathSearch),
      )?.unit ?? pathSections.upcoming[0]?.unit)
    : pathSections.upcoming[0]?.unit;
  useEffect(() => {
    if (!nextUnitToPreload || nextUnitToPreload.kind === "binary") {
      return;
    }
    /** Prepares the next unit's highlighted source outside the input event. */
    const preload = () => {
      void preloadSyntaxLanguage(nextUnitToPreload.language);
    };
    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(preload, { timeout: 400 });
      return () => window.cancelIdleCallback(idleId);
    }
    const timeoutId = window.setTimeout(preload, 0);
    return () => window.clearTimeout(timeoutId);
  }, [nextUnitToPreload]);
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
  const waitingCount = units.filter((unit) => unit.status === "waiting").length;
  const remainingCount = units.length - signedCount;
  const reviewComplete = signedCount === units.length;
  const [completionOpen, setCompletionOpen] = useState(reviewComplete);
  const previousReviewComplete = useRef(reviewComplete);
  const completedFileCount = useMemo(
    () => new Set(units.map(({ path }) => path)).size,
    [units],
  );
  const reviewQueue = api.review.dashboard.useQuery(undefined, {
    enabled: reviewComplete,
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
  const nextReview = useMemo(
    () => findNextReview(reviewQueue.data, initialData.pullRequest.id),
    [initialData.pullRequest.id, reviewQueue.data],
  );
  useEffect(() => {
    sendReviewSession({
      type: reviewComplete ? "REVIEW_COMPLETED" : "REVIEW_REOPENED",
    });
  }, [reviewComplete, sendReviewSession]);
  useEffect(() => {
    if (reviewComplete && !previousReviewComplete.current) {
      setCompletionOpen(true);
    } else if (!reviewComplete) {
      setCompletionOpen(false);
    }
    previousReviewComplete.current = reviewComplete;
  }, [reviewComplete]);
  const revisionReReviewCount = initialData.units.filter(
    ({ changedSinceSignOff }) => changedSinceSignOff,
  ).length;
  const revisionPreservedCount = initialData.units.filter(
    ({ status }) => status === "signed_off",
  ).length;
  const hasNextActionableUnit = nextPendingReviewIndex(units) >= 0;
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
  const diffAvailable = Boolean(
    activeSourceAvailable &&
      activeUnit &&
      activeUnit.kind !== "binary" &&
      (activeUnit.previousSource ||
        activeUnit.changeType === "added" ||
        Boolean(activeModule?.previousSource)),
  );
  const sideBySideVisible = showDiff && diffAvailable;
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
    ? previousUnitStartLine + activeUnit.previousSource.split("\n").length - 1
    : previousUnitStartLine;
  const currentRelatedRanges = useMemo(
    () => relatedReviewRanges(activeUnit, "current"),
    [activeUnit],
  );
  const previousRelatedRanges = useMemo(
    () => relatedReviewRanges(activeUnit, "previous"),
    [activeUnit],
  );
  const firstCurrentReviewLine =
    currentRelatedRanges?.at(0)?.startLine ?? activeUnit?.startLine ?? 1;
  const primaryReviewRanges =
    activeUnit?.changeType === "deleted"
      ? previousRelatedRanges
      : currentRelatedRanges;
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
  const fullFileLines = useMemo(
    () => activeModule?.source.split("\n") ?? [],
    [activeModule?.source],
  );
  const contextAvailable = Boolean(
    activeUnit && activeModule && fullFileLines.length >= activeUnit.endLine,
  );
  const availableBefore =
    contextAvailable && activeUnit ? Math.max(0, activeUnit.startLine - 1) : 0;
  const availableAfter =
    contextAvailable && activeUnit
      ? Math.max(0, fullFileLines.length - activeUnit.endLine)
      : 0;
  const visibleStartLine =
    contextAvailable && activeUnit
      ? activeUnit.startLine - Math.min(contextBefore, availableBefore)
      : (activeUnit?.startLine ?? 1);
  const visibleEndLine =
    contextAvailable && activeUnit
      ? activeUnit.endLine + Math.min(contextAfter, availableAfter)
      : (activeUnit?.endLine ?? 1);
  const contextVisible = contextBefore > 0 || contextAfter > 0;
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
      for (
        let line = activeUnit.startLine;
        line <= activeUnit.endLine;
        line += 1
      ) {
        changedLines.add(line);
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
  }, [activeModule, activeUnit]);
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
    displayedSource,
    activeUnit?.language ?? "text",
  );
  const previousRewriteSource =
    activeUnit?.changeType === "modified" &&
    activeUnit.previousSource &&
    activeUnit.kind !== "binary"
      ? activeUnit.previousSource
      : "";
  const highlightedPreviousRewrite = useHighlightedSource(
    previousRewriteSource,
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
  const importReferences = useImportReferences(
    displayedSource,
    activeUnit?.language ?? "text",
  );
  const importPreviewLines = useHighlightedSource(
    importPreview?.source ?? "",
    importPreview?.language ?? "text",
  );
  /** Opens a review unit and optionally records it in visited-unit history. */
  function selectUnit(index: number, recordHistory = true) {
    const target = units[index];
    if (!target) return;
    setActiveIndex(index);
    if (recordHistory) {
      setNavigationHistory((current) =>
        pushReviewNavigationHistory(current, target.id),
      );
    }
    setShowDiff(true);
    setStartedAt(Date.now());
    setQueueLimit(INITIAL_PATH_ITEMS);
    setKeyboardLine(undefined);
    setContextBefore(0);
    setContextAfter(0);
    setImportReturn(undefined);
    setImportPreview(undefined);
    setPathPanelOpen(false);
    setInsightsPanelOpen(false);
  }

  /** Moves through visited units before falling back to canonical adjacency. */
  function navigateUnit(direction: -1 | 1) {
    const visitedTarget = reviewNavigationHistoryTarget(
      navigationHistory,
      direction,
    );
    if (visitedTarget) {
      const index = units.findIndex((unit) => unit.id === visitedTarget.unitId);
      if (index >= 0) {
        setNavigationHistory(visitedTarget.history);
        selectUnit(index, false);
        return;
      }
    }
    const adjacentIndex = activeIndex + direction;
    if (adjacentIndex >= 0 && adjacentIndex < units.length) {
      selectUnit(adjacentIndex);
    }
  }

  /** Shows or hides source context surrounding the active review unit. */
  function toggleContext() {
    if (!contextAvailable) return;
    if (contextVisible) {
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

  /** Applies several sign-offs immediately while retaining rollback state. */
  function optimisticallyQueueSignOffs(
    inputs: SignOffInput[],
    preferredNextUnit?: (unit: ReviewUnit, index: number) => boolean,
  ) {
    const inputByUnitId = new Map(inputs.map((input) => [input.unitId, input]));
    const alreadyQueued = new Set(
      queuedSignOffs.current.map(({ input }) => input.unitId),
    );
    const scrollTop = codeScrollRef.current?.scrollTop ?? 0;
    const queued = units.flatMap((unit, unitIndex): QueuedSignOff[] => {
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
      units,
      queued.map(({ input }) => input.unitId),
    );
    const nextIndex = nextReviewIndexAfterAction(updated, preferredNextUnit);
    for (const entry of queued) {
      dispatchSignOffQueue({
        type: "enqueue",
        unitId: entry.input.unitId,
      });
    }
    queuedSignOffs.current.push(...queued);
    setUnits(updated);
    if (nextIndex >= 0) {
      setActiveIndex(nextIndex);
      const nextUnit = updated[nextIndex];
      if (nextUnit) {
        setNavigationHistory((history) =>
          pushReviewNavigationHistory(history, nextUnit.id),
        );
      }
    }
    setQueueLimit(INITIAL_PATH_ITEMS);
    setShowDiff(true);
    setContextBefore(0);
    setContextAfter(0);
    codeScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    setStartedAt(Date.now());
    void drainSignOffQueue();
  }

  /** Applies one optimistic sign-off through the shared queue. */
  function optimisticallyQueueSignOff(input: SignOffInput) {
    optimisticallyQueueSignOffs([input]);
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
    setNavigationHistory((history) =>
      pushReviewNavigationHistory(history, rollback.unit.id),
    );
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
      setUpdateAvailable(true);
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
  const undoSignOff = api.review.unreview.useMutation({
    onSuccess: ({ unreviewed }) => {
      if (!activeUnit || !unreviewed) return;
      void Promise.all([
        utils.workspace.guidance.invalidate(),
        utils.review.dashboard.invalidate(),
        utils.review.gamification.invalidate(),
      ]);
      setUnits((current) =>
        current.map((unit) =>
          unit.id === activeUnit.id
            ? {
                ...unit,
                status: "pending" as const,
                changedSinceSignOff: false,
              }
            : unit,
        ),
      );
      setStartedAt(Date.now());
      toast.success("Marked as not reviewed", {
        description: `${activeUnit.name} is back in your review queue.`,
      });
    },
    onError: (error) => toast.error(error.message),
  });
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
  useEffect(() => {
    const terminalJobIds = new Set(
      aiQuestions.data
        ?.filter(({ status }) => ["completed", "failed"].includes(status))
        .map(({ id }) => id) ?? [],
    );
    if (terminalJobIds.size === 0) return;
    setLiveAiQuestions((questions) =>
      questions.filter(({ jobId }) => !jobId || !terminalJobIds.has(jobId)),
    );
  }, [aiQuestions.data]);
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
  ]);
  useEffect(
    () => () => {
      for (const stream of aiQuestionStreams.current.values()) stream.abort();
      aiQuestionStreams.current.clear();
    },
    [],
  );
  const startExplanation = api.ai.start.useMutation({
    onSuccess: () => {
      toast.success("Explanation started");
      void aiStatus.refetch();
    },
    onError: showAiStartError,
  });
  const startAiQuestion = api.ai.start.useMutation({
    onSuccess: () => void aiUsage.refetch(),
  });
  const deleteAiQuestionThread = api.ai.deleteQuestionThread.useMutation({
    onError: (error) => toast.error(error.message),
  });
  const aiConfiguration = api.ai.configuration.useQuery();
  const pullRequestReview = api.ai.reviewStatus.useQuery(
    { pullRequestId: initialData.pullRequest.id },
    {
      refetchInterval: (query) =>
        ["queued", "running"].includes(query.state.data?.status ?? "")
          ? 2_000
          : false,
    },
  );
  const explanationRunning =
    startExplanation.isPending ||
    ["queued", "running"].includes(aiStatus.data?.status ?? "");
  const aiQuestionRunning =
    startAiQuestion.isPending ||
    liveAiQuestions.some(({ status }) =>
      ["queued", "running", "streaming"].includes(status),
    ) ||
    (aiQuestions.data?.some(({ status }) =>
      ["queued", "running"].includes(status),
    ) ??
      false);
  const explanationAnnotations =
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
      : [];
  const discussion = api.review.unitDiscussion.useQuery(
    { unitId: settledActiveUnitId ?? "" },
    { enabled: Boolean(settledActiveUnitId) },
  );
  const providerConversations = api.review.providerConversations.useQuery(
    { pullRequestId: initialData.pullRequest.id },
    {
      retry: false,
      refetchOnWindowFocus: true,
      refetchInterval: waitingCount > 0 ? 45_000 : false,
    },
  );
  const manualSyncPending = reviewSession.matches("synchronizing");
  const pollLatestPullRequest = api.review.poll.useMutation({
    onSuccess: (result) => {
      setActiveSyncId(result.syncId);
      void utils.review.activeSyncs.invalidate();
      toast.info("Pull request synchronization queued", {
        description:
          "ReviewDuck will preserve your current review while it runs.",
      });
    },
  });
  const syncStatus = api.review.syncStatus.useQuery(
    { syncId: activeSyncId ?? "00000000-0000-4000-8000-000000000000" },
    {
      enabled: Boolean(activeSyncId),
      refetchInterval: (query) =>
        ["queued", "running"].includes(query.state.data?.status ?? "")
          ? 1_500
          : false,
    },
  );
  useEffect(() => {
    const status = syncStatus.data?.status;
    if (status === "completed") {
      setActiveSyncId(undefined);
      setUpdateAvailable(true);
      void Promise.all([
        utils.review.activeSyncs.invalidate(),
        utils.review.dashboard.invalidate(),
        utils.review.gamification.invalidate(),
        utils.review.providerReviewState.invalidate({
          pullRequestId: initialData.pullRequest.id,
        }),
      ]);
      sendReviewSession({ type: "SYNC_FINISHED" });
      toast.info("New pull request revision is ready", {
        description:
          "Load the updated review path when you are ready. Your current draft stays in place.",
      });
    } else if (status === "failed" || status === "cancelled") {
      setActiveSyncId(undefined);
      void utils.review.activeSyncs.invalidate();
      sendReviewSession({ type: "SYNC_FINISHED" });
      toast.error(
        status === "cancelled"
          ? "Pull request synchronization was cancelled"
          : "Pull request synchronization failed",
        { description: syncStatus.data?.error ?? "Try again in a moment." },
      );
    }
  }, [
    sendReviewSession,
    syncStatus.data,
    utils.review.activeSyncs.invalidate,
    utils.review.dashboard.invalidate,
    utils.review.gamification.invalidate,
    utils.review.providerReviewState.invalidate,
    initialData.pullRequest.id,
  ]);
  const externalSyncPending =
    manualSyncPending ||
    pollLatestPullRequest.isPending ||
    ["queued", "running"].includes(syncStatus.data?.status ?? "");
  const resetReview = api.review.reset.useMutation({
    onSuccess: (result) => {
      setActiveSyncId(result.syncId);
      setResetDialogOpen(false);
      void Promise.all([
        utils.review.activeSyncs.invalidate(),
        utils.review.dashboard.invalidate(),
        utils.review.gamification.invalidate(),
      ]);
      router.refresh();
      toast.info("Review reset; synchronization queued");
    },
    onError: (error) => {
      toast.error("Review could not be reset", {
        description: error.message,
      });
    },
  });

  /** Queues durable source synchronization and refreshes provider conversations. */
  async function syncExternalData() {
    if (manualSyncPending) return;
    sendReviewSession({ type: "SYNC_STARTED" });
    try {
      await pollLatestPullRequest.mutateAsync({
        pullRequestId: initialData.pullRequest.id,
      });
      const conversationResult = await providerConversations.refetch();
      const conversationError = conversationResult.error;
      if (conversationError) {
        toast.warning(
          `${providerLabel(initialData.pullRequest.provider)} sync queued`,
          {
            description:
              "Review conversations could not be loaded; retry them from the warning above the code.",
          },
        );
      }
    } catch (cause) {
      sendReviewSession({ type: "SYNC_FINISHED" });
      toast.error(
        `Could not queue ${providerLabel(initialData.pullRequest.provider)} synchronization`,
        {
          description:
            cause instanceof Error ? cause.message : "Try again in a moment.",
        },
      );
    }
  }

  /** Persists the exact PR revision currently visible in the workspace. */
  function rememberLoadedRevision() {
    const snapshot = initialData.snapshot;
    if (!snapshot) return;
    acknowledgeReviewRevision(window.localStorage, initialData.pullRequest.id, {
      headSha: snapshot.headSha,
      snapshotId: snapshot.id,
      version: snapshot.version,
    });
  }

  /** Replaces the current review workspace with the newly synced revision. */
  function loadAvailableChanges() {
    rememberLoadedRevision();
    setUpdateAvailable(false);
    router.refresh();
  }

  /** Acknowledges the explanation for the currently loaded PR revision. */
  function acknowledgeLoadedRevision() {
    rememberLoadedRevision();
    setRevisionNotice(undefined);
  }

  const activeProviderThreads =
    providerConversations.data?.threads.filter(
      (thread) => thread.unitId === activeUnit?.id,
    ) ?? [];
  const hasLiveConversation =
    activeProviderThreads.length > 0 ||
    (discussion.data?.comments.some(
      (comment) => comment.status === "published",
    ) ??
      false);
  const handledReopenedUnits = useRef(new Set<string>());
  useEffect(() => {
    const reopenedUnitIds =
      providerConversations.data?.reopenedUnitIds.filter(
        (unitId) => !handledReopenedUnits.current.has(unitId),
      ) ?? [];
    if (reopenedUnitIds.length === 0) return;
    for (const unitId of reopenedUnitIds) {
      handledReopenedUnits.current.add(unitId);
    }
    const reopened = new Set(reopenedUnitIds);
    setUnits((current) =>
      current.map((unit) =>
        reopened.has(unit.id)
          ? {
              ...unit,
              status: "pending" as const,
              waitingSince: null,
            }
          : unit,
      ),
    );
    toast.info(
      reopenedUnitIds.length === 1
        ? "A waiting unit has new activity"
        : `${reopenedUnitIds.length} waiting units have new activity`,
      {
        description:
          "The affected code is back in your review path with the new conversation.",
      },
    );
  }, [providerConversations.data?.reopenedUnitIds]);
  const awaitResponse = api.review.awaitResponse.useMutation({
    onSuccess: () => {
      if (!activeUnit) return;
      setUnits((current) => {
        const updated = current.map((unit) =>
          unit.id === activeUnit.id
            ? {
                ...unit,
                status: "waiting" as const,
                waitingSince: new Date(),
                changedSinceSignOff: false,
              }
            : unit,
        );
        const nextIndex = nextReviewIndexAfterAction(updated);
        if (nextIndex >= 0) {
          setActiveIndex(nextIndex);
          const nextUnit = updated[nextIndex];
          if (nextUnit) {
            setNavigationHistory((history) =>
              pushReviewNavigationHistory(history, nextUnit.id),
            );
          }
        }
        setQueueLimit(INITIAL_PATH_ITEMS);
        setWaitingLimit(INITIAL_PATH_ITEMS);
        return updated;
      });
      setSelectedLine(undefined);
      setFeedback("");
      setShowDiff(true);
      setStartedAt(Date.now());
      toast.success("Waiting for response", {
        description: `${activeUnit.name} will return to your review path when its code or conversation changes.`,
      });
    },
    onError: (error) => toast.error(error.message),
  });
  const publishComment = api.review.publishComment.useMutation({
    onSuccess: () => {
      toast.success("Comment published", {
        description: `Your inline comment is now on ${providerLabel(initialData.pullRequest.provider)}.`,
      });
      setFeedback("");
      setSelectedLine(undefined);
      void discussion.refetch();
      void providerConversations.refetch();
    },
    onError: (error) => toast.error(error.message),
  });
  const replyToThread = api.review.replyToThread.useMutation({
    onSuccess: () => {
      toast.success("Reply published", {
        description: `The conversation was updated on ${providerLabel(initialData.pullRequest.provider)}.`,
      });
      void providerConversations.refetch();
    },
    onError: (error) => toast.error(error.message),
  });

  /** Renders every review artifact attached to one source line in either code view. */
  function renderReviewLineDetails(lineNumber: number) {
    if (!activeUnit) return null;
    const endingExplanations = explanationAnnotations.filter(
      (annotation) =>
        lineNumber >= annotation.line &&
        lineNumber <= (annotation.endLine ?? annotation.line) &&
        (annotation.endLine ?? annotation.line) === lineNumber,
    );
    const lineFindings =
      discussion.data?.findings.filter(
        (finding) => finding.line === lineNumber,
      ) ?? [];
    const allLineQuestions = [
      ...(aiQuestions.data
        ?.filter(
          (question) =>
            question.focusLine === lineNumber &&
            !liveAiQuestions.some(({ jobId }) => jobId === question.id),
        )
        .map((question) => ({
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
                    published:
                      discussion.data?.comments.some(
                        (comment) =>
                          comment.aiJobId === question.id &&
                          comment.aiFindingIndex === index &&
                          comment.status === "published",
                      ) ?? false,
                  }),
                ),
              }
            : null,
          status: question.status,
          threadId: question.conversationId,
        })) ?? []),
      ...liveAiQuestions
        .filter((question) => question.focusLine === lineNumber)
        .map((question) => ({
          error: question.error,
          id: question.id,
          jobId: question.jobId,
          progress: question.progress,
          question: question.question,
          result: question.result,
          status: question.status,
          threadId: question.threadId,
        })),
    ];
    const lineQuestionGroups = new Map<string, typeof allLineQuestions>();
    for (const question of allLineQuestions) {
      const threadId = question.threadId;
      const group = lineQuestionGroups.get(threadId) ?? [];
      group.push(question);
      lineQuestionGroups.set(threadId, group);
    }
    const activeThreadId =
      aiQuestionThreadId && lineQuestionGroups.has(aiQuestionThreadId)
        ? aiQuestionThreadId
        : ([...lineQuestionGroups.keys()].at(-1) ?? aiQuestionThreadId);
    const lineQuestions = activeThreadId
      ? (lineQuestionGroups.get(activeThreadId) ?? [])
      : [];
    const lineThreads = activeProviderThreads.filter(
      (thread) => thread.line === lineNumber,
    );
    const providerThreadIds = new Set(
      lineThreads.map((thread) => thread.externalId),
    );
    const lineComments =
      discussion.data?.comments.filter(
        (comment) =>
          comment.line === lineNumber &&
          comment.status === "published" &&
          comment.source === "user" &&
          (!comment.providerExternalId ||
            !providerThreadIds.has(comment.providerExternalId)),
      ) ?? [];

    return (
      <>
        {endingExplanations.map((annotation) => {
          const annotationIndex = explanationAnnotations.indexOf(annotation);
          const endLine = annotation.endLine ?? annotation.line;
          return (
            <article
              id={`ai-explanation-${annotationIndex}`}
              key={`${annotation.line}-${endLine}-${annotation.title}`}
              className="border-violet/20 bg-violet/[.045] relative mx-4 my-2 ml-[71px] overflow-hidden rounded-xl border p-3 font-sans shadow-[0_10px_30px_var(--app-shadow)]"
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
            draft={aiQuestionDraft}
            entries={lineQuestions}
            line={lineNumber}
            minimumLine={Math.min(activeUnit.startLine, previousUnitStartLine)}
            maximumLine={Math.max(activeUnit.endLine, previousUnitEndLine)}
            onAsk={askAiQuestion}
            onChange={setAiQuestionDraft}
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
              setAiQuestionDraft("");
            }}
            onDeleteThread={async (jobIds) => {
              if (jobIds.length === 0) return;
              await deleteAiQuestionThread.mutateAsync({
                pullRequestId: initialData.pullRequest.id,
                unitId: activeUnit.id,
                jobIds,
              });
              await aiQuestions.refetch();
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
              setAiQuestionDraft("");
              toast.success("AI conversation deleted", {
                description:
                  "Previously published pull-request comments were preserved.",
              });
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
                className="border-violet/15 bg-violet/[.035] text-violet hover:border-violet/30 hover:bg-violet/[.07] mx-4 my-1 ml-[71px] flex items-center gap-2 rounded-lg border px-2.5 py-1.5 font-sans text-[9px] transition"
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
          const published =
            discussion.data?.comments.some(
              (comment) =>
                comment.aiJobId === finding.aiJobId &&
                comment.aiFindingIndex === finding.index &&
                comment.status === "published",
            ) ?? false;
          return (
            <article
              key={`${finding.aiJobId}-${finding.index}`}
              className="mx-4 my-2 ml-[71px] rounded-xl border border-amber-300/20 bg-surface p-3 font-sans"
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
                    {publishComment.isPending ? (
                      <LoaderCircle className="size-3 animate-spin" />
                    ) : (
                      <Send className="size-3" />
                    )}
                    {publishComment.isPending
                      ? "Posting…"
                      : `Post to ${providerLabel(initialData.pullRequest.provider)}`}
                  </Button>
                )}
              </div>
              <p className="text-mist mt-2 text-xs leading-5">{finding.body}</p>
            </article>
          );
        })}
        {lineThreads.map((thread) => (
          <ProviderConversation
            key={thread.externalId}
            provider={initialData.pullRequest.provider}
            thread={thread}
            replying={
              replyToThread.isPending &&
              replyToThread.variables?.threadExternalId === thread.externalId
            }
            onReply={(body) =>
              replyToThread.mutateAsync({
                unitId: activeUnit.id,
                threadExternalId: thread.externalId,
                body,
              })
            }
            publishedByReviewDuck={
              discussion.data?.comments.some(
                (comment) => comment.providerExternalId === thread.externalId,
              ) ?? false
            }
          />
        ))}
        {lineComments.map((comment) => (
          <div
            key={comment.id}
            className="border-cyan/15 bg-cyan/[.035] mx-4 my-2 ml-[71px] rounded-xl border p-3 font-sans"
          >
            <p className="text-cyan text-[9px] font-semibold tracking-wider uppercase">
              Posted to {providerLabel(initialData.pullRequest.provider)}
            </p>
            <p className="text-mist mt-1 text-xs leading-5">{comment.body}</p>
          </div>
        ))}
        {selectedLine === lineNumber && (
          <div className="border-cyan/20 bg-panel mx-4 my-2 ml-[71px] rounded-xl border p-3 font-sans shadow-xl">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <p className="text-cloud flex shrink-0 items-center gap-2 text-xs font-medium">
                <MessageSquareText className="text-cyan size-3.5" />
                Comment on {providerLabel(initialData.pullRequest.provider)} ·
                line {lineNumber}
              </p>
              <span className="text-fog min-w-0 truncate text-right font-mono text-[9px]">
                {activeUnit.path}
              </span>
            </div>
            <textarea
              ref={commentInputRef}
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSelectedLine(undefined);
                  setFeedback("");
                } else if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey) &&
                  feedback.trim() &&
                  !publishComment.isPending
                ) {
                  event.preventDefault();
                  publishComment.mutate({
                    unitId: activeUnit.id,
                    line: lineNumber,
                    body: feedback,
                  });
                }
              }}
              placeholder={`Write an inline ${providerLabel(initialData.pullRequest.provider)} comment…`}
              rows={3}
              className="bg-surface text-cloud focus:border-cyan/45 mt-3 w-full resize-y rounded-lg border border-line px-3 py-2 text-xs leading-5 outline-none"
            />
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-fog flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] leading-4">
                <span>
                  Posts immediately to{" "}
                  {providerLabel(initialData.pullRequest.provider)}.
                </span>
                <span className="flex items-center gap-1">
                  <ShortcutHint shortcut={reviewShortcuts.postComment} />
                  post
                </span>
                <span>· Esc cancels</span>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSelectedLine(undefined);
                    setFeedback("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!feedback.trim() || publishComment.isPending}
                  onClick={() =>
                    publishComment.mutate({
                      unitId: activeUnit.id,
                      line: lineNumber,
                      body: feedback,
                    })
                  }
                >
                  {publishComment.isPending ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : (
                    <Send className="size-3" />
                  )}
                  {publishComment.isPending
                    ? "Posting…"
                    : `Post to ${providerLabel(initialData.pullRequest.provider)}`}
                </Button>
              </div>
            </div>
          </div>
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
    ["queued", "running"].includes(pullRequestReview.data?.status ?? "");
  const aiUsage = api.ai.usage.useQuery(
    { pullRequestId: initialData.pullRequest.id },
    {
      refetchInterval:
        explanationRunning || aiQuestionRunning || reviewRunning
          ? 2_000
          : false,
    },
  );
  const pullReviewRequested = useRef(false);
  useEffect(() => {
    if (
      aiConfiguration.data?.reviewPullRequests &&
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
    setFeedback("");
    setAiQuestionLine(undefined);
    setAiQuestionThreadId(undefined);
    setFocusAiQuestionComposer(false);
    setAiQuestionPreviewLine(undefined);
    setAiQuestionDraft("");
  }, [activeUnitId]);
  useEffect(() => {
    if (selectedLine !== undefined) commentInputRef.current?.focus();
  }, [selectedLine]);
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
  useEffect(() => {
    if (pullRequestReview.data?.status === "completed") {
      void discussion.refetch();
      void aiUsage.refetch();
    }
  }, [aiUsage, discussion, pullRequestReview.data?.status]);
  useEffect(() => {
    if (aiStatus.data?.status === "completed") {
      void aiUsage.refetch();
    }
  }, [aiStatus.data?.status, aiUsage]);
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
  const activeSignOffPending = activeUnit
    ? signOffQueue.ids.has(activeUnit.id)
    : false;
  const deletedUnitsToSignOff = useMemo(
    () => deletedFileSignOffUnits(units, fileContexts),
    [fileContexts, units],
  );
  const canSignOffDeletedFiles =
    activeFileIsDeleted &&
    deletedUnitsToSignOff.length > 0 &&
    deletedUnitsToSignOff.every((unit) =>
      initialData.sourceDelivery === "direct"
        ? hydratedUnitIds.has(unit.id)
        : true,
    ) &&
    !resetReview.isPending;
  const pendingSignOffCount = signOffQueue.ids.size;
  const signOffQueueProgress = `${signOffQueue.completed}/${signOffQueue.total}`;
  const footerSaveState = reviewFooterSaveState({
    activeSavePending: activeSignOffPending,
    pendingSaveCount: pendingSignOffCount,
    reviewComplete,
  });
  const completionVisible =
    reviewComplete && completionOpen && footerSaveState === "idle";
  const openDashboard = useCallback(() => router.push("/dashboard"), [router]);
  const openNextReview = useCallback(() => {
    if (nextReview) router.push(`/review/${nextReview.id}`);
  }, [nextReview, router]);
  useEffect(() => {
    if (!completionVisible) return;

    /** Dismisses the completion state while preserving the completed review. */
    function dismissCompletion(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setCompletionOpen(false);
    }

    document.addEventListener("keydown", dismissCompletion);
    return () => document.removeEventListener("keydown", dismissCompletion);
  }, [completionVisible]);
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
  const canUsePrimaryAction =
    !!activeUnit &&
    (activeSourceAvailable ||
      activeUnit.status === "signed_off" ||
      activeUnit.status === "waiting") &&
    !reviewComplete &&
    !activeSignOffPending &&
    !undoSignOff.isPending &&
    !awaitResponse.isPending &&
    !resetReview.isPending &&
    (activeUnit.status !== "waiting" || hasNextActionableUnit);

  /** Shows the review-path panel as a drawer or persistent desktop column. */
  function showPathPanel() {
    setPathPanelCollapsed(false);
    if (!window.matchMedia("(min-width: 1536px)").matches) {
      setInsightsPanelOpen(false);
      setPathPanelOpen(true);
    }
  }

  /** Hides the review-path drawer or collapses its persistent desktop column. */
  function hidePathPanel() {
    setPathPanelOpen(false);
    if (window.matchMedia("(min-width: 1536px)").matches) {
      setPathPanelCollapsed(true);
    }
  }

  /** Toggles the review-path panel for the active responsive layout. */
  function togglePathPanel() {
    if (window.matchMedia("(min-width: 1536px)").matches) {
      setPathPanelOpen(false);
      setPathPanelCollapsed((current) => !current);
      return;
    }
    if (pathPanelOpen) {
      setPathPanelOpen(false);
    } else {
      setInsightsPanelOpen(false);
      setPathPanelOpen(true);
    }
  }

  /** Shows AI assistance as a drawer or persistent desktop column. */
  function showInsightsPanel() {
    setInsightsPanelCollapsed(false);
    if (!window.matchMedia("(min-width: 1280px)").matches) {
      setPathPanelOpen(false);
      setInsightsPanelOpen(true);
    }
  }

  /** Hides the AI drawer or collapses its persistent desktop column. */
  function hideInsightsPanel() {
    setInsightsPanelOpen(false);
    if (window.matchMedia("(min-width: 1280px)").matches) {
      setInsightsPanelCollapsed(true);
    }
  }

  /** Toggles AI assistance for the active responsive layout. */
  function toggleInsightsPanel() {
    if (window.matchMedia("(min-width: 1280px)").matches) {
      setInsightsPanelOpen(false);
      setInsightsPanelCollapsed((current) => !current);
      return;
    }
    if (insightsPanelOpen) {
      setInsightsPanelOpen(false);
    } else {
      setPathPanelOpen(false);
      setInsightsPanelOpen(true);
    }
  }

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
    dismissedAiQuestionUnits.current.delete(activeUnit.id);
    const pane = codeScrollRef.current;
    const center = pane
      ? pane.getBoundingClientRect().top + pane.clientHeight / 2
      : window.innerHeight / 2;
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>('[id^="review-line-"]'),
    )
      .map((element) => ({
        element,
        line: Number(element.id.replace("review-line-", "")),
      }))
      .filter(
        ({ line }) => Number.isInteger(line) && isPrimaryReviewLine(line),
      );
    const nearest = candidates.sort((left, right) => {
      const leftBounds = left.element.getBoundingClientRect();
      const rightBounds = right.element.getBoundingClientRect();
      return (
        Math.abs(center - (leftBounds.top + leftBounds.height / 2)) -
        Math.abs(center - (rightBounds.top + rightBounds.height / 2))
      );
    })[0]?.line;
    const firstChangedLine = [...changedCurrentLines]
      .filter(isPrimaryReviewLine)
      .sort((left, right) => left - right)[0];
    setSelectedLine(undefined);
    setKeyboardLine(undefined);
    setFocusAiQuestionComposer(true);
    const nextLine = nearest ?? firstChangedLine ?? primaryReviewStart;
    const latestLiveThread = liveAiQuestions
      .filter(({ focusLine }) => focusLine === nextLine)
      .at(-1)?.threadId;
    const latestPersistedThread = aiQuestions.data
      ?.filter(({ focusLine }) => focusLine === nextLine)
      .at(-1)?.conversationId;
    const threadId =
      latestLiveThread ?? latestPersistedThread ?? crypto.randomUUID();
    setAiQuestionLine(nextLine);
    setAiQuestionThreadId(threadId);
    rememberAiConversationVisibility(
      window.localStorage,
      initialData.pullRequest.id,
      activeUnit.id,
      nextLine,
      threadId,
    );
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document
          .getElementById("inline-ai-question")
          ?.scrollIntoView({ block: "center", behavior: "smooth" }),
      ),
    );
  }

  /** Moves the inline AI question while keeping it inside review scope. */
  function moveAiQuestion(line: number) {
    if (!activeUnit) return;
    const nextLine = closestReviewLine(
      line,
      primaryReviewRanges,
      primaryReviewStart,
      primaryReviewEnd,
    );
    if (nextLine === aiQuestionLine) return;
    const pane = codeScrollRef.current;
    const card = document.getElementById("inline-ai-question");
    if (pane && card) {
      aiQuestionMoveAnchor.current = {
        cardTop: card.getBoundingClientRect().top,
        scrollTop: pane.scrollTop,
      };
    }
    setAiQuestionLine(nextLine);
    rememberAiConversationVisibility(
      window.localStorage,
      initialData.pullRequest.id,
      activeUnit.id,
      nextLine,
      aiQuestionThreadId,
    );
  }

  /** Moves the AI question to the next rendered in-scope review line. */
  function stepAiQuestion(direction: -1 | 1) {
    if (!activeUnit || aiQuestionLine === undefined) return;
    const renderedLines = Array.from(
      document.querySelectorAll<HTMLElement>('[id^="review-line-"]'),
    )
      .map((element) => Number(element.id.replace("review-line-", "")))
      .filter(
        (line, index, lines) =>
          Number.isInteger(line) &&
          isPrimaryReviewLine(line) &&
          lines.indexOf(line) === index,
      )
      .sort((left, right) => left - right);
    const nextLine =
      direction === 1
        ? renderedLines.find((line) => line > aiQuestionLine)
        : [...renderedLines].reverse().find((line) => line < aiQuestionLine);
    if (nextLine !== undefined) moveAiQuestion(nextLine);
  }

  /** Applies one durable agent-stream update to an optimistic chat entry. */
  function updateLiveAiQuestion(id: string, update: AiQuestionStreamUpdate) {
    setLiveAiQuestions((questions) =>
      questions.map((question) =>
        question.id === id
          ? {
              ...question,
              error: update.error ?? null,
              progress: update.progress,
              result: update.text
                ? {
                    summary: update.text,
                    commentProposals: update.commentProposals,
                  }
                : question.result,
              status: update.status === "working" ? "running" : update.status,
            }
          : question,
      ),
    );
  }

  /** Follows the persisted durable conversation stream for a focused AI question. */
  async function streamAiQuestion(jobId: string, optimisticId: string) {
    aiQuestionStreams.current.get(optimisticId)?.abort();
    const controller = new AbortController();
    aiQuestionStreams.current.set(optimisticId, controller);
    let cursor = -1;
    let reconnects = 0;
    try {
      while (!controller.signal.aborted) {
        try {
          const query = cursor >= 0 ? `?cursor=${cursor}` : "";
          const response = await fetch(`/api/ai/jobs/${jobId}/stream${query}`, {
            headers: { Accept: "text/event-stream" },
            signal: controller.signal,
          });
          const lastUpdate = await consumeAiQuestionStream(
            response,
            (update) => {
              if (update.cursor !== undefined) cursor = update.cursor;
              updateLiveAiQuestion(optimisticId, update);
            },
          );
          if (
            lastUpdate?.status === "completed" ||
            lastUpdate?.status === "failed"
          ) {
            return;
          }
          throw new Error("AI answer stream ended before completion");
        } catch {
          if (controller.signal.aborted) return;
          reconnects += 1;
          if (reconnects > 5) break;
          setLiveAiQuestions((questions) =>
            questions.map((question) =>
              question.id === optimisticId &&
              !["completed", "failed"].includes(question.status)
                ? {
                    ...question,
                    progress: "Live updates disconnected; reconnecting…",
                    status: "running",
                  }
                : question,
            ),
          );
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(4_000, 250 * 2 ** reconnects)),
          );
        }
      }
      if (!controller.signal.aborted) {
        setLiveAiQuestions((questions) =>
          questions.map((question) =>
            question.id === optimisticId &&
            !["completed", "failed"].includes(question.status)
              ? {
                  ...question,
                  progress: "Live updates unavailable; still working…",
                  status: "running",
                }
              : question,
          ),
        );
      }
    } finally {
      if (aiQuestionStreams.current.get(optimisticId) === controller) {
        aiQuestionStreams.current.delete(optimisticId);
      }
      void aiQuestions.refetch();
      void aiUsage.refetch();
    }
  }

  /** Sends the current line-focused question to the isolated AI reviewer. */
  function askAiQuestion(quickQuestion?: string) {
    if (
      !activeUnit ||
      aiQuestionLine === undefined ||
      !(quickQuestion ?? aiQuestionDraft).trim() ||
      !canAskAi
    ) {
      return;
    }
    const question = (quickQuestion ?? aiQuestionDraft).trim();
    const focusLine = aiQuestionLine;
    const threadId = aiQuestionThreadId ?? crypto.randomUUID();
    if (!aiQuestionThreadId) setAiQuestionThreadId(threadId);
    const optimisticId = `pending-${crypto.randomUUID()}`;
    setLiveAiQuestions((questions) => [
      ...questions,
      {
        error: null,
        focusLine,
        id: optimisticId,
        progress: "Sending question…",
        question,
        result: null,
        status: "queued",
        threadId,
      },
    ]);
    setAiQuestionDraft("");
    startAiQuestion.mutate(
      {
        pullRequestId: initialData.pullRequest.id,
        unitId: activeUnit.id,
        kind: "explain",
        question,
        focusLine,
        threadId,
      },
      {
        onSuccess: (job) => {
          setLiveAiQuestions((questions) =>
            questions.map((entry) =>
              entry.id === optimisticId
                ? {
                    ...entry,
                    jobId: job.id,
                    progress: "Waiting for the AI reviewer…",
                    status: job.status === "running" ? "running" : "queued",
                  }
                : entry,
            ),
          );
          void streamAiQuestion(job.id, optimisticId);
          void aiQuestions.refetch();
        },
        onError: (error) => {
          setLiveAiQuestions((questions) =>
            questions.map((entry) =>
              entry.id === optimisticId
                ? {
                    ...entry,
                    error: error.message,
                    progress: "Question was not sent",
                    status: "failed",
                  }
                : entry,
            ),
          );
          showAiStartError(error);
        },
      },
    );
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

  /** Runs the status-appropriate action for the active review unit. */
  function runPrimaryAction() {
    if (!activeUnit || !canUsePrimaryAction) return;
    if (activeUnit.status === "signed_off" || activeUnit.status === "waiting") {
      continueReview();
      return;
    }
    optimisticallyQueueSignOff({
      unitId: activeUnit.id,
      sessionId,
      durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
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

  /** Returns the active signed-off unit to the pending review queue. */
  function unreviewActiveUnit() {
    if (activeUnit?.status !== "signed_off") return;
    undoSignOff.mutate({
      unitId: activeUnit.id,
      sessionId,
    });
  }

  /** Opens the provider comment composer for one reviewable diff line. */
  function openInlineComment(line: number) {
    setKeyboardLine(undefined);
    setSelectedLine(line);
    setFeedback("");
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() =>
        document
          .getElementById(`review-line-${line}`)
          ?.scrollIntoView({ block: "center" }),
      ),
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
    setFeedback("");
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

  /** Scrolls the code viewport while revealing context at its boundaries. */
  function scrollCode(direction: -1 | 1) {
    const pane = codeScrollRef.current;
    if (!pane) return;
    const atBoundary =
      direction === -1
        ? pane.scrollTop <= 1
        : pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 1;
    const unitStart = reviewUnitStartRef.current;
    const unitStartVisible =
      direction === -1 &&
      unitStart !== null &&
      verticalRangesOverlap(
        pane.getBoundingClientRect(),
        unitStart.getBoundingClientRect(),
      );
    if (sideBySideVisible && atBoundary) {
      const previousScrollTop = pane.scrollTop;
      const previousScrollHeight = pane.scrollHeight;
      if (diffContextRef.current?.revealContext(direction)) {
        const generation = ++contextRevealGeneration.current;
        afterLayoutSettle(
          () => pane.scrollHeight,
          previousScrollHeight,
          () => {
            if (generation !== contextRevealGeneration.current) return;
            pane.scrollTop = scrollTopAfterContextReveal({
              direction,
              previousScrollTop,
              previousScrollHeight,
              nextScrollHeight: pane.scrollHeight,
              viewportHeight: pane.clientHeight,
            });
          },
        );
        return;
      }
    }
    if (
      direction === -1 &&
      shouldRevealLeadingContext({
        atPhysicalBoundary: atBoundary,
        unitStartVisible,
        sideBySideVisible,
        contextAvailable,
        contextBefore,
        availableBefore,
      })
    ) {
      const previousScrollTop = pane.scrollTop;
      const previousScrollHeight = pane.scrollHeight;
      const generation = ++contextRevealGeneration.current;
      setContextBefore((current) =>
        Math.min(current + CONTEXT_PAGE_LINES, availableBefore),
      );
      afterLayoutSettle(
        () => pane.scrollHeight,
        previousScrollHeight,
        () => {
          if (generation !== contextRevealGeneration.current) return;
          pane.scrollTop = scrollTopAfterContextReveal({
            direction: -1,
            previousScrollTop,
            previousScrollHeight,
            nextScrollHeight: pane.scrollHeight,
            viewportHeight: pane.clientHeight,
          });
        },
      );
      return;
    }
    if (
      direction === 1 &&
      pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 1 &&
      contextAvailable &&
      !sideBySideVisible &&
      contextAfter < availableAfter
    ) {
      const previousScrollTop = pane.scrollTop;
      const previousScrollHeight = pane.scrollHeight;
      const generation = ++contextRevealGeneration.current;
      setContextAfter((current) =>
        Math.min(current + CONTEXT_PAGE_LINES, availableAfter),
      );
      afterLayoutSettle(
        () => pane.scrollHeight,
        previousScrollHeight,
        () => {
          if (generation !== contextRevealGeneration.current) return;
          pane.scrollTop = scrollTopAfterContextReveal({
            direction: 1,
            previousScrollTop,
            previousScrollHeight,
            nextScrollHeight: pane.scrollHeight,
            viewportHeight: pane.clientHeight,
          });
        },
      );
      return;
    }
    pane.scrollBy({
      top: direction * 72,
      behavior: "auto",
    });
  }

  /** Renders direct AI controls without hiding their distinct scopes in a menu. */
  function renderAiActionButtons() {
    const aiDisabled = aiConfiguration.data?.mode === "off";
    return (
      <div className="grid w-full grid-cols-2 gap-2">
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
      </div>
    );
  }

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
      id: "next-unit",
      label: "Go forward",
      description:
        reviewNavigationHistoryTarget(navigationHistory, 1) !== undefined
          ? "Return to the next unit in your review history"
          : "Move one step forward in the original review path",
      group: "Review navigation",
      icon: <ChevronDown className="size-4" />,
      shortcut: reviewShortcuts.nextUnit,
      alternateShortcut: reviewShortcuts.nextUnitArrow,
      disabled:
        reviewNavigationHistoryTarget(navigationHistory, 1) === undefined &&
        activeIndex >= units.length - 1,
      onSelect: () => navigateUnit(1),
    },
    {
      id: "previous-unit",
      label: "Go back",
      description:
        reviewNavigationHistoryTarget(navigationHistory, -1) !== undefined
          ? "Return to the unit you visited immediately before this one"
          : "Move one step back in the original review path",
      group: "Review navigation",
      icon: <ChevronRight className="size-4 -rotate-90" />,
      shortcut: reviewShortcuts.previousUnit,
      alternateShortcut: reviewShortcuts.previousUnitArrow,
      disabled:
        reviewNavigationHistoryTarget(navigationHistory, -1) === undefined &&
        activeIndex <= 0,
      onSelect: () => navigateUnit(-1),
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
        if (nextQueueEntry) selectUnit(nextQueueEntry.index);
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
    {
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
      id: "toggle-context",
      label: contextVisible ? "Hide surrounding context" : "Show context",
      description: contextVisible
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
      label:
        activeUnit?.status === "signed_off" || activeUnit?.status === "waiting"
          ? filteredReviewActive
            ? "Continue to next match"
            : "Continue review"
          : "Sign off",
      description: filteredReviewActive
        ? "Continue through the matching review units in planned order"
        : "Remember this unit at the current revision",
      group: "Review actions",
      icon: <Check className="size-4" />,
      shortcut: reviewShortcuts.signOff,
      disabled: !canUsePrimaryAction,
      onSelect: runPrimaryAction,
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
      id: "unreview-unit",
      label: "Undo review",
      description: "Return this unit to the review queue",
      group: "Review actions",
      icon: <Undo2 className="size-4" />,
      shortcut: reviewShortcuts.undoReview,
      disabled:
        activeUnit?.status !== "signed_off" ||
        activeSignOffPending ||
        undoSignOff.isPending,
      onSelect: unreviewActiveUnit,
    },
    {
      id: "await-response",
      label: "Wait for a response",
      description: "Pause this unit until its code or conversation changes",
      group: "Review actions",
      icon: <Clock3 className="size-4" />,
      shortcut: reviewShortcuts.awaitResponse,
      disabled:
        !activeUnit ||
        !hasLiveConversation ||
        activeUnit.status === "waiting" ||
        awaitResponse.isPending ||
        activeSignOffPending,
      onSelect: () => {
        if (activeUnit) awaitResponse.mutate({ unitId: activeUnit.id });
      },
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
      icon: <Undo2 className="size-4" />,
      shortcut: reviewShortcuts.reset,
      disabled:
        signOffQueue.ids.size > 0 ||
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
      disabled: !reviewComplete || !nextReview,
      onSelect: openNextReview,
    },
    {
      id: "return-dashboard",
      label: "Return to pull requests",
      group: "Navigate",
      icon: <ArrowLeft className="size-4" />,
      shortcut: reviewShortcuts.dashboard,
      onSelect: openDashboard,
    },
    {
      id: "configure-ai",
      label: "Configure AI provider",
      description: "Manage assistance, providers, and model options",
      group: "Navigate",
      icon: <Sparkles className="size-4" />,
      shortcut: reviewShortcuts.aiSettings,
      onSelect: () => router.push("/settings/ai"),
    },
    ...units.map(
      (unit, index): CommandCenterItem => ({
        id: `unit-${unit.id}`,
        label: `Open ${unit.name}`,
        description: `${unit.path} · ${unit.kind.replace("_", " ")} · ${unit.status.replace("_", " ")}`,
        group: "Review units",
        keywords: [unit.path, unit.kind, unit.status, String(index + 1)],
        icon: <FileCode2 className="size-4" />,
        disabled: index === activeIndex,
        searchOnly: true,
        onSelect: () => selectUnit(index),
      }),
    ),
  ];
  const pendingShortcut = useCommandCenterBindings({
    commands: reviewCommands,
    onOpen: openCommands,
    onOpenShortcuts: openShortcuts,
    suspended:
      keyboardLine !== undefined ||
      importPreview !== undefined ||
      hierarchyOpen ||
      resetDialogOpen ||
      aiReviewDialogOpen,
  });

  useEffect(() => {
    if (keyboardLine === undefined || !activeUnit) return;
    const startLine = activeUnit.startLine;
    const endLine = activeUnit.endLine;
    const target = document.getElementById(`review-line-${keyboardLine}`);
    target?.scrollIntoView({ block: "nearest" });

    /** Handles keyboard selection and cancellation for inline comments. */
    function onLinePickerKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setKeyboardLine(undefined);
      } else if (event.key === "ArrowDown" || event.key === "j") {
        event.preventDefault();
        setKeyboardLine((current) =>
          Math.min((current ?? startLine) + 1, endLine),
        );
      } else if (event.key === "ArrowUp" || event.key === "k") {
        event.preventDefault();
        setKeyboardLine((current) =>
          Math.max((current ?? startLine) - 1, startLine),
        );
      } else if (event.key === "Enter") {
        event.preventDefault();
        setSelectedLine(keyboardLine);
        setKeyboardLine(undefined);
      }
    }

    document.addEventListener("keydown", onLinePickerKeyDown);
    return () => document.removeEventListener("keydown", onLinePickerKeyDown);
  }, [activeUnit, keyboardLine]);

  if (!initialData.snapshot || !activeUnit) {
    return (
      <main className="bg-ink grid min-h-screen place-items-center p-6 text-center">
        <div>
          <FileCode2 className="text-lime mx-auto size-8" />
          <h1 className="mt-5 text-xl font-medium">
            No reviewable symbols yet
          </h1>
          <p className="text-mist mt-2 text-sm">
            Synchronize this pull request after its first file change.
          </p>
          <Button asChild className="mt-6">
            <Link href="/dashboard">Back to dashboard</Link>
          </Button>
        </div>
      </main>
    );
  }

  return (
    <div className="bg-ink fixed inset-0 flex min-h-0 flex-col overflow-hidden">
      <header className="flex h-16 items-center gap-4 border-b border-line px-4 sm:px-6">
        <Link
          href="/dashboard"
          aria-label="Back to dashboard"
          className="text-mist hover:text-cloud grid size-9 place-items-center rounded-full transition hover:bg-surface-subtle"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {initialData.pullRequest.title}
          </p>
          <p className="text-fog truncate text-[10px]">
            {initialData.pullRequest.repositoryOwner}/
            {initialData.pullRequest.repositoryName} #
            {initialData.pullRequest.number}
          </p>
        </div>
        <div className="hidden items-center gap-3 sm:flex">
          <span className="text-mist text-xs">{progress}% reviewed</span>
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
          onClick={
            updateAvailable
              ? loadAvailableChanges
              : () => void syncExternalData()
          }
          disabled={
            resetReview.isPending || (!updateAvailable && externalSyncPending)
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
              externalSyncPending && !updateAvailable && "animate-spin",
            )}
          />
          <span className="hidden sm:inline">
            {updateAvailable ? (
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
          <Undo2 className="size-4" />
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
            onClick={loadAvailableChanges}
            title="Load the synced code changes (R)"
          >
            <span>Load changes</span>
            <ShortcutHint shortcut={reviewShortcuts.loadChanges} />
          </Button>
        </div>
      )}

      {revisionNotice && (
        <div
          role="status"
          className="border-cyan/20 bg-cyan/[.045] flex shrink-0 items-start gap-3 border-b px-4 py-3 sm:items-center sm:px-6"
        >
          <RefreshCw className="text-cyan mt-0.5 size-4 shrink-0 sm:mt-0" />
          <div className="min-w-0 flex-1">
            <p className="text-cloud text-xs font-medium">
              New pull-request revision loaded
            </p>
            <p className="text-mist mt-0.5 text-[10px] leading-4">
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
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={acknowledgeLoadedRevision}
          >
            Got it
          </Button>
        </div>
      )}

      <div
        className={cn(
          "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-hidden",
          insightsPanelCollapsed
            ? "xl:grid-cols-[minmax(0,1fr)]"
            : "xl:grid-cols-[minmax(0,1fr)_320px]",
          pathPanelCollapsed && insightsPanelCollapsed
            ? "2xl:grid-cols-[minmax(0,1fr)]"
            : pathPanelCollapsed
              ? "2xl:grid-cols-[minmax(0,1fr)_320px]"
              : insightsPanelCollapsed
                ? "2xl:grid-cols-[250px_minmax(0,1fr)]"
                : "2xl:grid-cols-[250px_minmax(0,1fr)_320px]",
        )}
      >
        {pathPanelOpen && (
          <button
            type="button"
            aria-label="Close review path"
            onClick={() => setPathPanelOpen(false)}
            className="fixed top-16 right-0 bottom-0 left-0 z-30 bg-black/55 backdrop-blur-[2px] 2xl:hidden"
          />
        )}
        {insightsPanelOpen && (
          <button
            type="button"
            aria-label="Close AI assistance"
            onClick={() => setInsightsPanelOpen(false)}
            className="fixed top-16 right-0 bottom-0 left-0 z-30 bg-black/55 backdrop-blur-[2px] xl:hidden"
          />
        )}
        <aside
          id="review-path-panel"
          aria-label="Review path"
          className={cn(
            "min-h-0 flex-col overflow-hidden border-r border-line bg-panel",
            pathPanelOpen
              ? "fixed top-16 bottom-0 left-0 z-40 flex w-[min(320px,calc(100vw-3rem))] shadow-2xl"
              : "hidden",
            pathPanelCollapsed
              ? "2xl:hidden"
              : "2xl:static 2xl:flex 2xl:w-auto 2xl:shadow-none",
          )}
        >
          <div className="shrink-0 border-b border-line px-4 py-4">
            <div className="flex items-center justify-between">
              <span className="text-fog text-[10px] font-semibold tracking-[.16em] uppercase">
                Review path
              </span>
              <Badge>{units.length} units</Badge>
            </div>
            <div className="mt-3 flex items-center gap-2 text-[9px]">
              <span className="text-cloud">{remainingCount} remaining</span>
              <span aria-hidden="true" className="text-line-strong">
                ·
              </span>
              <span className="text-fog">{signedCount} reviewed</span>
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
                aria-label="Filter review path"
                placeholder="Find a symbol or file"
                className="bg-surface text-cloud focus:border-cyan/45 h-9 w-full rounded-lg border border-line px-3 pr-9 text-xs outline-none"
              />
              <ShortcutHint
                shortcut={reviewShortcuts.search}
                className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2"
              />
            </div>
          </div>
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
                        onSelect={selectUnit}
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
                  {pathSections.waiting.slice(0, waitingLimit).map((entry) => (
                    <ReviewPathUnit
                      key={entry.unit.id}
                      entry={entry}
                      active={false}
                      onSelect={selectUnit}
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
                title={`Canonical path position ${activeIndex + 1} of ${units.length}`}
              >
                1
              </span>
            </div>
            {pathSections.current && (
              <ReviewPathUnit
                entry={pathSections.current}
                active
                onSelect={selectUnit}
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
                    {pathSections.upcoming.slice(0, queueLimit).map((entry) => (
                      <ReviewPathUnit
                        key={entry.unit.id}
                        entry={entry}
                        active={false}
                        onSelect={selectUnit}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-mist rounded-xl border border-dashed border-line px-3 py-4 text-center text-[10px]">
                    No units left in the queue.
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
          <div className="shrink-0 border-t border-line p-3">
            <button
              type="button"
              aria-label="Hide review path"
              title="Hide review path"
              onClick={hidePathPanel}
              className="text-mist hover:bg-surface-subtle hover:text-cloud flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-[10px] transition"
            >
              <PanelLeftClose className="size-3.5" />
              <span>Hide review path</span>
              <ShortcutHint
                shortcut={reviewShortcuts.togglePathPanel}
                className="ml-auto"
              />
            </button>
          </div>
        </aside>

        <main className="relative flex min-h-0 min-w-0 flex-col overflow-hidden">
          {completionVisible && (
            <ReviewCompletion
              completedFiles={completedFileCount}
              completedUnits={signedCount}
              dashboardShortcut={reviewShortcuts.dashboard}
              dismissShortcut={[{ key: "Escape" }]}
              nextReview={nextReview}
              nextReviewShortcut={reviewShortcuts.nextReview}
              providerReview={
                <ProviderReviewDecision
                  state={providerReviewState.data}
                  error={providerReviewState.error?.message}
                  loading={providerReviewState.isFetching}
                  mutationPending={setProviderReviewDecision.isPending}
                  repositoryUrl={initialData.pullRequest.repositoryWebUrl}
                  pullRequestUrl={initialData.pullRequest.webUrl}
                  onRefresh={() => void providerReviewState.refetch()}
                  onDecision={(action, body) =>
                    setProviderReviewDecision.mutate({
                      pullRequestId: initialData.pullRequest.id,
                      action,
                      body,
                    })
                  }
                />
              }
              queueLoading={reviewQueue.isLoading}
              onDashboard={openDashboard}
              onDismiss={() => setCompletionOpen(false)}
              onNextReview={openNextReview}
            />
          )}
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 border-b border-line px-3 py-3 sm:flex-nowrap sm:gap-4 sm:px-5 sm:py-4 lg:px-7">
            <button
              type="button"
              aria-label="Show review path"
              aria-controls="review-path-panel"
              aria-expanded={pathPanelOpen}
              title="Show review path"
              onClick={showPathPanel}
              className={cn(
                "text-mist hover:text-cyan h-8 shrink-0 items-center gap-2 rounded-lg border border-line px-2 transition hover:border-cyan/25 hover:bg-cyan/[.05]",
                pathPanelCollapsed ? "flex" : "flex 2xl:hidden",
              )}
            >
              <PanelLeftOpen className="size-3.5" />
              <span className="hidden text-[10px] sm:inline">Review path</span>
              <ShortcutHint
                shortcut={reviewShortcuts.togglePathPanel}
                className="hidden lg:inline-flex"
              />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <h1
                  className="truncate font-mono text-sm font-medium"
                  title={`${activeUnit.path}, lines ${activeUnit.startLine}–${activeUnit.endLine}`}
                >
                  {activeUnit.path}
                </h1>
                {activeUnit.status === "waiting" && (
                  <Badge className="border-cyan/25 bg-cyan/10 text-cyan">
                    <Clock3 className="size-3" />
                    Waiting for response
                  </Badge>
                )}
                {activeUnit.changedSinceSignOff && (
                  <Badge className="border-amber-600/25 bg-amber-400/10 text-amber-800 dark:border-amber-300/20 dark:text-amber-200">
                    Changed
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
                <span className="text-mist font-mono">{activeUnit.name}</span>
                <span aria-hidden="true">·</span>
                <span className="shrink-0">
                  Lines {activeUnit.startLine}–{activeUnit.endLine}
                </span>
              </p>
            </div>
            <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
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
                <button
                  type="button"
                  aria-pressed={sideBySideVisible}
                  aria-label={
                    sideBySideVisible
                      ? "Show current source with review comments"
                      : "Show code diff"
                  }
                  title={
                    sideBySideVisible
                      ? "Show current source with review comments"
                      : "Show side-by-side code diff"
                  }
                  onClick={() => {
                    setShowDiff((value) => !value);
                    setContextBefore(0);
                    setContextAfter(0);
                  }}
                  className="text-mist hover:text-cloud h-8 rounded-lg border border-line px-2.5 text-[10px] transition"
                >
                  {sideBySideVisible ? "Current" : "Diff"}
                </button>
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
                <span className="hidden text-[10px] sm:inline">Details</span>
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
          {activeUnit.changedSinceSignOff && !activeUnit.previousSource && (
            <div className="border-cyan/15 bg-cyan/[.035] text-cyan border-b px-5 py-2 text-[10px] sm:px-7">
              This source is unchanged, but a dependency it relies on changed.
            </div>
          )}
          {providerConversations.isError && (
            <div className="flex items-center justify-between gap-3 border-b border-amber-500/20 bg-amber-400/[.06] px-5 py-2 sm:px-7">
              <p className="text-[10px] text-amber-800 dark:text-amber-200">
                {providerLabel(initialData.pullRequest.provider)} conversations
                could not be loaded.
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
            className="min-h-0 flex-1 overflow-auto bg-code py-5 font-mono text-[11px] leading-5 [overflow-anchor:none]"
          >
            {keyboardLine !== undefined && (
              <div
                role="status"
                className="border-cyan/20 bg-panel/95 text-mist sticky top-0 z-20 mx-4 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2 font-sans text-[10px] shadow-xl backdrop-blur"
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
            {sideBySideVisible && (
              <div className="px-4">
                <div className="border-line bg-surface/35 text-fog flex items-center justify-between gap-3 rounded-t-xl border border-b-0 px-3 py-2 font-sans text-[10px]">
                  <span>
                    {activeUnit.changeType === "added"
                      ? "Added code · select a line to comment"
                      : activeUnit.changeType === "deleted"
                        ? "Deleted code · select a base line to comment"
                        : "Side-by-side diff · select either changed side to comment"}
                  </span>
                  <span className="text-addition shrink-0">PR changes</span>
                </div>
                <SideBySideUnitDiff
                  key={activeUnit.id}
                  ref={diffContextRef}
                  previousSource={diffPreviousSource}
                  currentSource={diffCurrentSource}
                  language={activeUnit.language}
                  previousStartLine={1}
                  currentStartLine={1}
                  previousFocusRanges={
                    activeUnit.relatedRanges ? previousRelatedRanges : undefined
                  }
                  currentFocusRanges={
                    activeUnit.relatedRanges ? currentRelatedRanges : undefined
                  }
                  previousFocusStartLine={
                    activeUnit.changeType === "added"
                      ? null
                      : previousUnitStartLine
                  }
                  previousFocusEndLine={
                    activeUnit.changeType === "added"
                      ? null
                      : previousUnitEndLine
                  }
                  currentFocusStartLine={
                    activeUnit.changeType === "deleted"
                      ? null
                      : activeUnit.startLine
                  }
                  currentFocusEndLine={
                    activeUnit.changeType === "deleted"
                      ? null
                      : activeUnit.endLine
                  }
                  selectedLine={selectedLine}
                  keyboardLine={keyboardLine ?? aiQuestionPreviewLine}
                  onSelectReviewLine={openInlineComment}
                  renderLineDetails={renderReviewLineDetails}
                />
              </div>
            )}
            {sourceHydrationPending && !activeSourceAvailable && (
              <div className="text-mist grid min-h-72 place-items-center font-sans text-sm">
                Loading and verifying private source…
              </div>
            )}
            {!sourceHydrationPending && !activeSourceAvailable && (
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
                    This private source could not be verified and loaded. Reload
                    the review before signing off this unit.
                  </p>
                </div>
              </div>
            )}
            {!sideBySideVisible && activeSourceAvailable && activeModule && (
              <UnitImportContext
                key={activeUnit.id}
                fileSource={activeModule.source}
                previousFileSource={activeModule.previousSource ?? undefined}
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
            {!sideBySideVisible &&
              activeSourceAvailable &&
              contextAvailable &&
              contextBefore < availableBefore && (
                <div className="mb-3 flex items-center gap-3 px-4 font-sans">
                  <span className="h-px flex-1 bg-line" />
                  <button
                    type="button"
                    onClick={() =>
                      setContextBefore((current) =>
                        Math.min(current + CONTEXT_PAGE_LINES, availableBefore),
                      )
                    }
                    className="text-fog hover:border-cyan/25 hover:bg-cyan/[.05] hover:text-cyan flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[9px] transition"
                  >
                    <ChevronDown className="size-3 rotate-180" />
                    Show{" "}
                    {Math.min(
                      CONTEXT_PAGE_LINES,
                      availableBefore - contextBefore,
                    )}{" "}
                    {contextBefore > 0 ? "more " : ""}lines above
                  </button>
                  <span className="h-px flex-1 bg-line" />
                </div>
              )}
            {activeSourceAvailable && activeUnit.kind === "binary" && (
              <div className="mx-auto grid min-h-72 max-w-lg place-items-center px-6 py-12 font-sans">
                <div className="w-full rounded-2xl border border-line bg-surface/45 p-8 text-center shadow-[0_18px_60px_var(--app-shadow)]">
                  <span className="bg-cyan/10 text-cyan mx-auto grid size-11 place-items-center rounded-xl">
                    <FileCode2 className="size-5" aria-hidden="true" />
                  </span>
                  <p className="text-cloud mt-4 text-sm font-medium">
                    Binary file
                  </p>
                  <p className="text-mist mt-2 text-xs leading-5">
                    ReviewDuck detected binary content. Its bytes are not
                    displayed, sent to AI, or available for line comments.
                  </p>
                  <p className="text-fog mt-3 truncate font-mono text-[10px]">
                    {activeUnit.path}
                  </p>
                </div>
              </div>
            )}
            {!sideBySideVisible &&
              activeSourceAvailable &&
              activeUnit.kind !== "binary" &&
              lines.map((line, index) => {
                const lineNumber = visibleStartLine + index;
                const isUnitLine = isPrimaryReviewLine(lineNumber);
                const isChangedLine =
                  isUnitLine && changedCurrentLines.has(lineNumber);
                const isContextLine = !isUnitLine;
                const coveringExplanations = isUnitLine
                  ? explanationAnnotations.filter(
                      (annotation) =>
                        lineNumber >= annotation.line &&
                        lineNumber <= (annotation.endLine ?? annotation.line),
                    )
                  : [];
                return (
                  <Fragment key={`${activeUnit.id}-${index}`}>
                    {contextBefore > 0 &&
                      lineNumber === activeUnit.startLine && (
                        <ReviewScopeMarker
                          edge="start"
                          line={activeUnit.startLine}
                        />
                      )}
                    {lineNumber === activeUnit.startLine &&
                      previousRewriteLines.map((line, previousIndex) => {
                        const previousLineNumber =
                          previousUnitStartLine + previousIndex;
                        return (
                          <div
                            key={`${activeUnit.id}-previous-${previousIndex}`}
                            className="group grid grid-cols-[55px_1fr] border-l-2 border-l-red-400/45 bg-red-400/[.07] px-4 hover:bg-red-400/[.1]"
                          >
                            <span className="flex items-center justify-end pr-3 text-right text-red-700 opacity-80 select-none dark:text-red-200">
                              {previousLineNumber}
                            </span>
                            <pre className="syntax-code overflow-visible text-cloud/80 line-through opacity-80">
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
                        );
                      })}
                    <div
                      ref={
                        lineNumber === activeUnit.startLine
                          ? reviewUnitStartRef
                          : undefined
                      }
                      id={`review-line-${lineNumber}`}
                      className={cn(
                        "group grid grid-cols-[55px_1fr] border-l-2 border-transparent px-4 hover:bg-surface-subtle",
                        contextVisible &&
                          isUnitLine &&
                          "border-l-cyan/35 bg-cyan/[.012]",
                        isChangedLine &&
                          "border-l-addition/45 bg-addition/[.075] hover:bg-addition/[.105]",
                        isContextLine &&
                          "bg-surface-subtle/15 opacity-55 hover:opacity-80",
                        coveringExplanations.length > 0 &&
                          "bg-violet/[.025] shadow-[inset_2px_0_0_var(--app-ai)]",
                        selectedLine === lineNumber && "bg-violet/[.055]",
                        keyboardLine === lineNumber &&
                          "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
                        aiQuestionPreviewLine === lineNumber &&
                          "bg-violet/[.075] shadow-[inset_2px_0_0_var(--app-ai)]",
                      )}
                    >
                      {isUnitLine && activeUnit.kind !== "binary" ? (
                        <button
                          type="button"
                          aria-label={`Comment on line ${lineNumber}`}
                          aria-pressed={selectedLine === lineNumber}
                          onClick={() => {
                            setKeyboardLine(undefined);
                            setSelectedLine((current) =>
                              current === lineNumber ? undefined : lineNumber,
                            );
                            setFeedback("");
                          }}
                          className={cn(
                            "hover:text-violet flex items-center justify-end gap-1.5 pr-3 text-right text-fog transition select-none",
                            isChangedLine && "bg-addition/[.11] text-addition",
                          )}
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
                      ) : (
                        <span className="flex items-center justify-end pr-3 text-right text-fog select-none">
                          {lineNumber}
                        </span>
                      )}
                      <pre className="syntax-code overflow-visible text-cloud/80">
                        {line.tokens.length
                          ? line.tokens.map((token, tokenIndex) => {
                              const importReference = importReferences.find(
                                (reference) =>
                                  reference.from >= token.from &&
                                  reference.to <= token.to,
                              );
                              const resolutionKey = importReference
                                ? `${activeUnit.id}:${importReference.from}:${importReference.to}`
                                : undefined;
                              return importReference ? (
                                <button
                                  type="button"
                                  key={`${tokenIndex}-${token.text.length}`}
                                  aria-label={`Open ${importReference.local} from ${importReference.specifier}`}
                                  title={`Open ${importReference.specifier}`}
                                  disabled={resolvingImport === resolutionKey}
                                  onClick={() =>
                                    void followImport(importReference)
                                  }
                                  className={cn(
                                    "text-cyan decoration-cyan/55 hover:bg-cyan/[.09] cursor-pointer rounded-sm underline decoration-dotted underline-offset-4 transition",
                                    token.className,
                                    resolvingImport === resolutionKey &&
                                      "animate-pulse cursor-wait",
                                  )}
                                >
                                  {token.text}
                                </button>
                              ) : (
                                <span
                                  key={`${tokenIndex}-${token.text.length}`}
                                  className={token.className || undefined}
                                >
                                  {token.text}
                                </span>
                              );
                            })
                          : " "}
                      </pre>
                    </div>
                    {isUnitLine && renderReviewLineDetails(lineNumber)}
                    {contextAfter > 0 && lineNumber === activeUnit.endLine && (
                      <ReviewScopeMarker edge="end" line={activeUnit.endLine} />
                    )}
                  </Fragment>
                );
              })}
            {!sideBySideVisible &&
              contextAvailable &&
              contextAfter < availableAfter && (
                <div className="mt-3 flex items-center gap-3 px-4 font-sans">
                  <span className="h-px flex-1 bg-line" />
                  <button
                    type="button"
                    onClick={() =>
                      setContextAfter((current) =>
                        Math.min(current + CONTEXT_PAGE_LINES, availableAfter),
                      )
                    }
                    className="text-fog hover:border-cyan/25 hover:bg-cyan/[.05] hover:text-cyan flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[9px] transition"
                  >
                    <ChevronDown className="size-3" />
                    Show{" "}
                    {Math.min(
                      CONTEXT_PAGE_LINES,
                      availableAfter - contextAfter,
                    )}{" "}
                    {contextAfter > 0 ? "more " : ""}lines below
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
          <div className="border-violet/15 bg-violet/[.025] flex items-center justify-end border-t px-3 py-3 sm:px-4 xl:hidden">
            {renderAiActionButtons()}
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
              ) : (
                <span className="hidden items-center gap-3 xl:flex">
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    <ShortcutAlternatives
                      shortcut={reviewShortcuts.scrollUp}
                      alternateShortcut={reviewShortcuts.scrollDown}
                    />
                    {aiQuestionLine === undefined ? "Scroll" : "Move question"}
                  </span>
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    <ShortcutAlternatives
                      shortcut={reviewShortcuts.previousUnit}
                      alternateShortcut={reviewShortcuts.previousUnitArrow}
                    />
                    Previous
                  </span>
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    <ShortcutAlternatives
                      shortcut={reviewShortcuts.nextUnit}
                      alternateShortcut={reviewShortcuts.nextUnitArrow}
                    />
                    Next
                  </span>
                </span>
              )}
            </div>
            {footerSaveState === "background" && (
              <span
                role="status"
                aria-label={`Saving reviews, ${signOffQueue.completed} of ${signOffQueue.total} complete`}
                className="border-line-strong bg-surface text-mist flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border px-2.5 text-[10px] shadow-[0_8px_24px_var(--app-shadow)] sm:h-10 sm:px-3"
              >
                <LoaderCircle className="size-3 animate-spin" />
                <span className="hidden sm:inline">Saving</span>
                <span className="font-mono text-cloud">
                  {signOffQueueProgress}
                </span>
              </span>
            )}
            {footerSaveState === "finalizing" ? (
              <Button
                className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-5"
                disabled
                aria-label={`Finishing review, ${signOffQueue.completed} of ${signOffQueue.total} saves complete`}
              >
                <LoaderCircle className="size-4 animate-spin" />
                Finishing {signOffQueueProgress}…
              </Button>
            ) : reviewComplete ? (
              <div className="flex min-w-0 items-center justify-end gap-2">
                {activeUnit.status === "signed_off" && (
                  <Button
                    variant="secondary"
                    className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-4"
                    onClick={unreviewActiveUnit}
                    disabled={undoSignOff.isPending}
                  >
                    {undoSignOff.isPending ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <Undo2 className="size-4" />
                    )}
                    <span className="hidden sm:inline">
                      {undoSignOff.isPending ? "Undoing…" : "Undo review"}
                    </span>
                    <span className="sm:hidden">
                      {undoSignOff.isPending ? "Undoing…" : "Undo"}
                    </span>
                    {!undoSignOff.isPending && (
                      <ShortcutHint
                        shortcut={reviewShortcuts.undoReview}
                        className="hidden sm:inline-flex"
                      />
                    )}
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
                    onClick={openNextReview}
                  >
                    Next review
                    <ChevronRight className="size-4" />
                    <ShortcutHint
                      shortcut={reviewShortcuts.nextReview}
                      className="hidden sm:inline-flex"
                    />
                  </Button>
                ) : (
                  <Button
                    className="h-10 px-3 sm:h-11 sm:px-5"
                    onClick={openDashboard}
                  >
                    <ArrowLeft className="size-4" />
                    Dashboard
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
                  footerSaveState !== "active" && (
                    <Button
                      variant="secondary"
                      className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-4"
                      onClick={unreviewActiveUnit}
                      disabled={undoSignOff.isPending}
                    >
                      {undoSignOff.isPending ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <Undo2 className="size-4" />
                      )}
                      <span className="hidden sm:inline">
                        {undoSignOff.isPending ? "Undoing…" : "Undo review"}
                      </span>
                      <span className="sm:hidden">
                        {undoSignOff.isPending ? "Undoing…" : "Undo"}
                      </span>
                      {!undoSignOff.isPending && (
                        <ShortcutHint
                          shortcut={reviewShortcuts.undoReview}
                          className="hidden sm:inline-flex"
                        />
                      )}
                    </Button>
                  )}
                {activeUnit.status === "waiting" ? (
                  <Button
                    variant="secondary"
                    className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-4"
                    disabled
                  >
                    <Clock3 className="size-4" />
                    <span className="hidden sm:inline">
                      Waiting for response
                    </span>
                    <span className="sm:hidden">Waiting</span>
                  </Button>
                ) : (
                  hasLiveConversation &&
                  footerSaveState !== "active" && (
                    <Button
                      variant="secondary"
                      className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-4"
                      title={`Pause this unit until ${providerLabel(initialData.pullRequest.provider)} receives a reply or the code changes`}
                      onClick={() =>
                        awaitResponse.mutate({ unitId: activeUnit.id })
                      }
                      disabled={awaitResponse.isPending || activeSignOffPending}
                    >
                      {awaitResponse.isPending ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <Clock3 className="size-4" />
                      )}
                      <span className="hidden sm:inline">
                        {awaitResponse.isPending ? "Saving…" : "Await response"}
                      </span>
                      <span className="sm:hidden">
                        {awaitResponse.isPending ? "Saving…" : "Await"}
                      </span>
                      {!awaitResponse.isPending && (
                        <ShortcutHint
                          shortcut={reviewShortcuts.awaitResponse}
                          className="hidden sm:inline-flex"
                        />
                      )}
                    </Button>
                  )
                )}
                {(activeUnit.status !== "waiting" || hasNextActionableUnit) && (
                  <Button
                    className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-5"
                    onClick={runPrimaryAction}
                    disabled={
                      !canUsePrimaryAction ||
                      activeSignOffPending ||
                      undoSignOff.isPending ||
                      awaitResponse.isPending
                    }
                  >
                    <Check className="size-4" />
                    {activeSignOffPending
                      ? `Saving ${signOffQueueProgress}…`
                      : activeUnit.status === "signed_off" ||
                          activeUnit.status === "waiting"
                        ? filteredReviewActive
                          ? "Next match"
                          : "Continue"
                        : "Sign off"}
                    {!activeSignOffPending && (
                      <ShortcutHint
                        shortcut={reviewShortcuts.signOff}
                        className="hidden sm:inline-flex"
                      />
                    )}
                    <ChevronRight className="size-3.5" />
                  </Button>
                )}
              </div>
            )}
          </div>
        </main>
        <aside
          id="code-explanation-panel"
          aria-label="AI assistance"
          className={cn(
            "bg-panel min-h-0 flex-col overflow-hidden border-l border-line",
            insightsPanelOpen
              ? "fixed top-16 right-0 bottom-0 z-40 flex w-[min(360px,calc(100vw-3rem))] shadow-2xl"
              : "hidden",
            insightsPanelCollapsed
              ? "xl:hidden"
              : "xl:static xl:flex xl:w-auto xl:bg-panel/30 xl:shadow-none",
          )}
        >
          <div className="border-violet/15 bg-panel z-10 flex shrink-0 items-center border-b px-4 py-4">
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
                            document
                              .getElementById(`ai-explanation-${index}`)
                              ?.scrollIntoView({
                                behavior: "smooth",
                                block: "center",
                              })
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
            {["queued", "running"].includes(
              pullRequestReview.data?.status ?? "",
            ) && (
              <p className="text-violet mt-4 text-[10px] leading-4">
                AI review is {pullRequestReview.data?.status}. Findings will
                appear directly beneath their relevant code lines.
              </p>
            )}
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
            icon={<Undo2 className="text-coral size-4" />}
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
              <div className="min-h-0 flex-1 overflow-auto bg-code py-4 font-mono text-[11px] leading-5">
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
                    <pre className="syntax-code pr-6 text-cloud/80">
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
