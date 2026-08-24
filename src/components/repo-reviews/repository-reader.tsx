"use client";

import {
  ArrowLeft,
  BookOpenCheck,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileCode2,
  GitBranch,
  History,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  ShieldCheck,
  Undo2,
  X,
} from "lucide-react";
import Link from "next/link";
import {
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
  type CommandCenterItem,
  ShortcutHint,
} from "~/components/command-center";
import { usePageCommandCenter } from "~/components/page-command-center";
import { HighlightedSourceLines } from "~/components/review/highlighted-source-lines";
import { Button } from "~/components/ui/button";
import { LinkPendingSpinner } from "~/components/ui/link-status";
import { lockDocumentScroll } from "~/lib/document-scroll-lock";
import {
  hydratePrivateReviewSources,
  prioritizePrivateReviewSources,
} from "~/lib/private-source-client";
import { readerShortcuts } from "~/lib/review-shortcuts";
import { sourceEndLine } from "~/lib/side-by-side-diff";
import { createSignOffQueue, signOffQueueReducer } from "~/lib/sign-off-queue";
import { knownLanguage, useHighlightedSource } from "~/lib/syntax-highlighting";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

type Workspace = RouterOutputs["review"]["workspace"];
type Monitor = RouterOutputs["repoReviews"]["list"][number];
type RuleSeverity = "critical" | "high" | "medium" | "low";
const CONTEXT_PAGE_LINES = 20;

/** Starts a file-scoped compliance rule beside the code that inspired it. */
function newRuleForm(path: string) {
  return {
    title: "",
    instruction: "",
    pathGlob: path,
    scope: "file" as "file" | "repository",
    severity: "medium" as RuleSeverity,
  };
}

/** Finds the old revision's first line when a symbol moved between snapshots. */
function previousStartLine(unit: Workspace["units"][number] | undefined) {
  const starts =
    unit?.relatedRanges
      ?.map(({ previousStartLine }) => previousStartLine)
      .filter((line): line is number => line !== undefined) ?? [];
  return starts.length > 0 ? Math.min(...starts) : (unit?.startLine ?? 1);
}

/** Focused repository reader: path, source, and one clear completion action. */
export function RepositoryReader({
  initialData,
  monitor,
}: {
  initialData: Workspace;
  monitor: Monitor;
}) {
  const [units, setUnits] = useState(initialData.units);
  const [hydratedFileContext, setHydratedFileContext] = useState<{
    snapshotId: string;
    context: Workspace["fileContexts"][number];
  }>();
  const [activeId, setActiveId] = useState(
    initialData.units.find(({ status }) => status !== "signed_off")?.id ??
      initialData.units[0]?.id,
  );
  const [search, setSearch] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [previousUnitId, setPreviousUnitId] = useState<string>();
  const [contextBefore, setContextBefore] = useState(0);
  const [contextAfter, setContextAfter] = useState(0);
  const [ruleSelection, setRuleSelection] = useState<{
    startLine: number;
    endLine: number;
  }>();
  const [ruleForm, setRuleForm] = useState(() =>
    newRuleForm(initialData.units[0]?.path ?? "**/*"),
  );
  const [signOffQueue, dispatchSignOffQueue] = useReducer(
    signOffQueueReducer,
    undefined,
    createSignOffQueue,
  );
  const [sourceLoading, setSourceLoading] = useState(
    initialData.sourceDelivery === "direct" && Boolean(initialData.snapshot),
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const codeScrollRef = useRef<HTMLDivElement>(null);
  const ruleInstructionRef = useRef<HTMLTextAreaElement>(null);
  const activeIndex = Math.max(
    0,
    units.findIndex(({ id }) => id === activeId),
  );
  const active = units[activeIndex];
  // The reader takes over the viewport like the pull-request workspace, so
  // the shell behind it must stop scrolling out of view.
  useLayoutEffect(() => lockDocumentScroll(document), []);

  // A snapshot is immutable. Keep its download manifest stable so a same-
  // snapshot refresh does not abort and restart verified source downloads.
  // The unit you opened first downloads ahead of everything else.
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot identity owns its immutable source manifest
  const hydrationPlan = useMemo(() => {
    const firstPending =
      initialData.units.find(({ status }) => status !== "signed_off")?.id ??
      initialData.units[0]?.id;
    return {
      snapshotId:
        initialData.sourceDelivery === "direct"
          ? initialData.snapshot?.id
          : undefined,
      units: prioritizePrivateReviewSources(initialData.units, {
        activeId: firstPending,
        activePath: initialData.units.find(({ id }) => id === firstPending)
          ?.path,
      }),
      fileContexts: initialData.fileContexts,
    };
  }, [initialData.snapshot?.id]);

  useEffect(() => {
    if (!hydrationPlan.snapshotId) return;
    let live = true;
    const controller = new AbortController();
    const cache = new Map<string, Promise<Uint8Array>>();
    const hydratedById = new Map<string, Workspace["units"][number]>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    /** Applies all source files hydrated in the same event-loop turn at once. */
    const flushHydrated = () => {
      flushTimer = undefined;
      if (!live || hydratedById.size === 0) return;
      const hydrated = new Map(hydratedById);
      hydratedById.clear();
      setUnits((current) =>
        current.map((unit) => {
          const replacement = hydrated.get(unit.id);
          return replacement
            ? {
                ...replacement,
                status: unit.status,
                changedSinceSignOff: unit.changedSinceSignOff,
                waitingSince: unit.waitingSince,
              }
            : unit;
        }),
      );
    };
    setSourceLoading(true);
    void hydratePrivateReviewSources(
      hydrationPlan.units,
      hydrationPlan.snapshotId,
      cache,
      6,
      controller.signal,
      (_index, hydrated) => {
        if (!live) return;
        hydratedById.set(hydrated.id, hydrated);
        flushTimer ??= setTimeout(flushHydrated, 0);
      },
    )
      .then((result) => {
        if (!live) return;
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        flushHydrated();
        if (result.failures.length > 0) {
          toast.error(
            `${result.failures.length} source file${result.failures.length === 1 ? "" : "s"} could not be loaded`,
          );
        }
      })
      .catch((cause: unknown) => {
        if (!live || controller.signal.aborted) return;
        toast.error("Repository source files could not be loaded", {
          description:
            cause instanceof Error ? cause.message : "Please try again.",
        });
      })
      .finally(() => {
        if (live) setSourceLoading(false);
      });
    return () => {
      live = false;
      controller.abort();
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      cache.clear();
    };
  }, [hydrationPlan]);

  // Full-file context can be much larger than the focused review units. Load
  // only the active path and replace it on navigation so the reader never
  // accumulates every repository file in browser memory.
  useEffect(() => {
    const snapshotId = hydrationPlan.snapshotId;
    if (!snapshotId || !active?.path) return;
    const context = hydrationPlan.fileContexts.find(
      ({ path }) => path === active.path,
    );
    if (!context) {
      setHydratedFileContext(undefined);
      return;
    }
    let live = true;
    const controller = new AbortController();
    setHydratedFileContext(undefined);
    void hydratePrivateReviewSources(
      [context],
      snapshotId,
      new Map<string, Promise<Uint8Array>>(),
      1,
      controller.signal,
    )
      .then((result) => {
        if (!live) return;
        const hydrated = result.units[0];
        if (hydrated && result.successfulIndexes.includes(0)) {
          setHydratedFileContext({
            snapshotId,
            context: hydrated,
          });
        } else if (result.failures.length > 0) {
          toast.error("Surrounding file context could not be loaded");
        }
      })
      .catch((cause: unknown) => {
        if (!live || controller.signal.aborted) return;
        toast.error("Surrounding file context could not be loaded", {
          description:
            cause instanceof Error ? cause.message : "Please try again.",
        });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [active?.path, hydrationPlan]);

  const paths = useMemo(() => {
    const query = search.trim().toLowerCase();
    const grouped = new Map<string, typeof units>();
    for (const unit of units) {
      if (
        query &&
        !unit.path.toLowerCase().includes(query) &&
        !unit.name.toLowerCase().includes(query)
      ) {
        continue;
      }
      grouped.set(unit.path, [...(grouped.get(unit.path) ?? []), unit]);
    }
    return [...grouped.entries()];
  }, [search, units]);
  const pending = useMemo(
    () => units.filter(({ status }) => status !== "signed_off"),
    [units],
  );
  const signed = units.length - pending.length;
  const percent = units.length ? Math.round((signed / units.length) * 100) : 0;

  /**
   * Selects one unit and returns the code pane to its top.
   *
   * Every navigation path funnels through here so keyboard steps, sidebar
   * clicks, and footer buttons share one behaviour.
   */
  const selectUnit = useCallback(
    (unit: Workspace["units"][number] | undefined) => {
      if (!unit) return;
      setActiveId(unit.id);
      setPreviousUnitId(undefined);
      setContextBefore(0);
      setContextAfter(0);
      setRuleSelection(undefined);
      setRuleForm(newRuleForm(unit.path));
      codeScrollRef.current?.scrollTo?.({ top: 0 });
    },
    [],
  );

  const utils = api.useUtils();
  const addRule = api.repoReviews.addRule.useMutation({
    onSuccess: () => {
      setRuleSelection(undefined);
      setRuleForm(newRuleForm(active?.path ?? "**/*"));
      toast.success("Compliance rule added");
      void utils.repoReviews.rules.invalidate({ monitorId: monitor.id });
    },
    onError: (error) =>
      toast.error("Could not save compliance rule", {
        description: error.message,
      }),
  });

  const signOff = api.review.signOff.useMutation({
    onMutate: ({ unitId }) => {
      dispatchSignOffQueue({ type: "enqueue", unitId });
      const previousStatus = units.find(({ id }) => id === unitId)?.status;
      const current = units.findIndex(({ id }) => id === unitId);
      const ordered = [
        ...units.slice(current + 1),
        ...units.slice(0, Math.max(current, 0)),
      ];
      const next = ordered.find(
        ({ id, status }) => id !== unitId && status !== "signed_off",
      );
      setUnits((current) =>
        current.map((unit) =>
          unit.id === unitId
            ? { ...unit, status: "signed_off" as const }
            : unit,
        ),
      );
      // Reading should never wait on persistence. The failed unit is restored
      // to the queue by onError, while the reader can keep moving forward.
      if (next) selectUnit(next);
      return { previousStatus };
    },
    onError: (error, { unitId }, context) => {
      const previousStatus = context?.previousStatus;
      if (previousStatus) {
        setUnits((current) =>
          current.map((unit) =>
            unit.id === unitId ? { ...unit, status: previousStatus } : unit,
          ),
        );
      }
      toast.error("Could not save reading progress", {
        description: error.message,
      });
    },
    onSettled: (_data, _error, { unitId }) => {
      dispatchSignOffQueue({ type: "settle", unitId });
    },
  });
  const unreview = api.review.unreview.useMutation({
    onMutate: ({ unitId }) => {
      const previousStatus = units.find(({ id }) => id === unitId)?.status;
      setUnits((current) =>
        current.map((unit) =>
          unit.id === unitId ? { ...unit, status: "pending" as const } : unit,
        ),
      );
      return { previousStatus };
    },
    onError: (error, { unitId }, context) => {
      const previousStatus = context?.previousStatus;
      if (previousStatus) {
        setUnits((current) =>
          current.map((unit) =>
            unit.id === unitId ? { ...unit, status: previousStatus } : unit,
          ),
        );
      }
      toast.error("Could not restore unit", { description: error.message });
    },
  });

  // The mutation result object is rebuilt on every render, so the callbacks
  // and command registrations below may only depend on its stable members.
  const signOffStart = signOff.mutate;
  const unreviewStart = unreview.mutate;

  /** Advances to the next unread unit, wrapping once past the end. */
  const resumeQueue = useCallback(() => {
    if (pending.length === 0) {
      toast.info("Everything in this snapshot is already read");
      return;
    }
    const next =
      pending.find(
        (unit) => units.findIndex(({ id }) => id === unit.id) > activeIndex,
      ) ?? pending[0];
    selectUnit(next);
  }, [activeIndex, pending, selectUnit, units]);

  /** Steps to the first unit of the neighbouring file that has readable units. */
  const stepFile = useCallback(
    (direction: -1 | 1) => {
      if (!active) return;
      let index = activeIndex + direction;
      while (index >= 0 && index < units.length) {
        if (units[index]?.path !== active.path) {
          selectUnit(units[index]);
          return;
        }
        index += direction;
      }
    },
    [active, activeIndex, selectUnit, units],
  );

  /** Scrolls the source pane by most of a viewport without leaving it. */
  const scrollCode = useCallback((direction: -1 | 1) => {
    const pane = codeScrollRef.current;
    if (!pane) return;
    pane.scrollBy?.({ top: direction * pane.clientHeight * 0.8 });
  }, []);

  /** Reveals the search field, opening the review path panel if needed. */
  const focusSearch = useCallback(() => {
    setSidebarOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const showPrevious = Boolean(active && previousUnitId === activeId);
  const togglePreviousSource = useCallback(() => {
    if (!active || active.previousSource === null) return;
    setPreviousUnitId(showPrevious ? undefined : active.id);
    setContextBefore(0);
    setContextAfter(0);
    setRuleSelection(undefined);
  }, [active, showPrevious]);

  const activeFileContext = active
    ? hydrationPlan.snapshotId
      ? hydratedFileContext?.snapshotId === hydrationPlan.snapshotId &&
        hydratedFileContext.context.path === active.path
        ? hydratedFileContext.context
        : undefined
      : hydrationPlan.fileContexts.find(({ path }) => path === active.path)
    : undefined;
  const unitStartLine = showPrevious
    ? previousStartLine(active)
    : (active?.startLine ?? 1);
  const unitEndLine = showPrevious
    ? sourceEndLine(active?.previousSource ?? "", unitStartLine)
    : (active?.endLine ?? unitStartLine);
  const fullFileSource = showPrevious
    ? activeFileContext?.previousSource
    : activeFileContext?.source;
  const fullFileLines = useMemo(
    () => fullFileSource?.split("\n") ?? [],
    [fullFileSource],
  );
  const fullFileAvailable = Boolean(
    active &&
      fullFileSource &&
      unitStartLine > 0 &&
      fullFileLines.length >= unitEndLine,
  );
  const availableBefore = fullFileAvailable ? unitStartLine - 1 : 0;
  const availableAfter = fullFileAvailable
    ? Math.max(0, fullFileLines.length - unitEndLine)
    : 0;
  const contextAvailable = availableBefore > 0 || availableAfter > 0;
  const contextVisible = contextBefore > 0 || contextAfter > 0;

  /** Keeps the focused unit stationary while inserting context before it. */
  const preserveFocusedLine = useCallback(
    (update: () => void) => {
      const pane = codeScrollRef.current;
      const selector = `[data-source-line="${unitStartLine}"]`;
      const previousTop = pane
        ?.querySelector<HTMLElement>(selector)
        ?.getBoundingClientRect().top;
      update();
      if (!pane || previousTop === undefined) return;
      window.requestAnimationFrame(() => {
        const nextTop = pane
          .querySelector<HTMLElement>(selector)
          ?.getBoundingClientRect().top;
        if (nextTop !== undefined) pane.scrollTop += nextTop - previousTop;
      });
    },
    [unitStartLine],
  );

  /** Reveals preceding source without moving the unit already in view. */
  const revealContextAbove = useCallback(() => {
    preserveFocusedLine(() =>
      setContextBefore((current) =>
        Math.min(current + CONTEXT_PAGE_LINES, availableBefore),
      ),
    );
  }, [availableBefore, preserveFocusedLine]);

  /** Reveals the next page of source following the reviewed unit. */
  const revealContextBelow = useCallback(() => {
    setContextAfter((current) =>
      Math.min(current + CONTEXT_PAGE_LINES, availableAfter),
    );
  }, [availableAfter]);

  /** Shows an initial page on both sides, or returns to the focused unit. */
  const toggleContext = useCallback(() => {
    if (!contextAvailable) return;
    if (contextVisible) {
      setContextBefore(0);
      setContextAfter(0);
      setRuleSelection(undefined);
      codeScrollRef.current?.scrollTo?.({ top: 0, behavior: "auto" });
      return;
    }
    preserveFocusedLine(() => {
      setContextBefore(Math.min(CONTEXT_PAGE_LINES, availableBefore));
      setContextAfter(Math.min(CONTEXT_PAGE_LINES, availableAfter));
    });
  }, [
    availableAfter,
    availableBefore,
    contextAvailable,
    contextVisible,
    preserveFocusedLine,
  ]);

  /** Opens a one-line rule anchor or extends the current anchor with Shift. */
  const selectRuleLine = useCallback(
    (line: number, extend: boolean) => {
      const opening = !extend || !ruleSelection;
      setRuleSelection((current) => {
        if (!extend || !current) return { startLine: line, endLine: line };
        return {
          startLine: Math.min(current.startLine, line),
          endLine: Math.max(current.endLine, line),
        };
      });
      if (active && opening) {
        setRuleForm((current) =>
          current.pathGlob === active.path ? current : newRuleForm(active.path),
        );
      }
      window.requestAnimationFrame(() => ruleInstructionRef.current?.focus());
    },
    [active, ruleSelection],
  );

  /** Saves the compliance rule being drafted beside the selected source. */
  const saveRule = useCallback(() => {
    if (
      !ruleForm.title.trim() ||
      !ruleForm.instruction.trim() ||
      !ruleForm.pathGlob.trim() ||
      addRule.isPending
    ) {
      return;
    }
    addRule.mutate({ monitorId: monitor.id, ...ruleForm });
  }, [addRule, monitor.id, ruleForm]);

  const canSignOff = Boolean(active) && active?.status !== "signed_off";
  const activeSignOffPending = active ? signOffQueue.ids.has(active.id) : false;
  const canUnreview = active?.status === "signed_off" && !activeSignOffPending;
  const signOffQueueProgress = `${signOffQueue.completed}/${signOffQueue.total}`;
  const runSignOff = useCallback(() => {
    if (!active || !canSignOff) return;
    signOffStart({ unitId: active.id, durationSeconds: 0 });
  }, [active, canSignOff, signOffStart]);
  const runUnreview = useCallback(() => {
    if (!active || !canUnreview) return;
    unreviewStart({ unitId: active.id });
  }, [active, canUnreview, unreviewStart]);
  const commands = useMemo<CommandCenterItem[]>(
    () => [
      {
        id: "reader-next-unit",
        label: "Select next unit",
        description: "Step to the next symbol in the reading path",
        group: "Reader navigation",
        icon: <ChevronDown className="size-4" />,
        shortcut: readerShortcuts.nextUnit,
        disabled: activeIndex >= units.length - 1,
        onSelect: () => selectUnit(units[activeIndex + 1]),
      },
      {
        id: "reader-previous-unit",
        label: "Select previous unit",
        description: "Step back to the previous symbol in the reading path",
        group: "Reader navigation",
        icon: <ChevronUp className="size-4" />,
        shortcut: readerShortcuts.previousUnit,
        disabled: activeIndex <= 0,
        onSelect: () => selectUnit(units[activeIndex - 1]),
      },
      {
        id: "reader-next-file",
        label: "Open next file",
        description: "Jump to the first symbol of the following file",
        group: "Reader navigation",
        icon: <ChevronRight className="size-4" />,
        shortcut: readerShortcuts.nextFile,
        disabled: activeIndex >= units.length - 1,
        onSelect: () => stepFile(1),
      },
      {
        id: "reader-previous-file",
        label: "Open previous file",
        description: "Jump to the first symbol of the preceding file",
        group: "Reader navigation",
        icon: <ChevronLeft className="size-4" />,
        shortcut: readerShortcuts.previousFile,
        disabled: activeIndex <= 0,
        onSelect: () => stepFile(-1),
      },
      {
        id: "reader-next-pending",
        label: "Resume the reading queue",
        description:
          signed < units.length
            ? `Open the next of ${units.length - signed} unread units`
            : "Every unit in this snapshot is read",
        group: "Reader navigation",
        icon: <BookOpenCheck className="size-4" />,
        shortcut: readerShortcuts.nextPending,
        disabled: signed >= units.length,
        onSelect: resumeQueue,
      },
      {
        id: "reader-scroll-down",
        label: "Scroll source down",
        description: "Move down through the code view",
        group: "Reader navigation",
        icon: <ChevronDown className="size-4" />,
        shortcut: readerShortcuts.scrollDown,
        onSelect: () => scrollCode(1),
      },
      {
        id: "reader-scroll-up",
        label: "Scroll source up",
        description: "Move up through the code view",
        group: "Reader navigation",
        icon: <ChevronUp className="size-4" />,
        shortcut: readerShortcuts.scrollUp,
        onSelect: () => scrollCode(-1),
      },
      {
        id: "reader-reveal-context-below",
        label: "Show more lines below",
        description: "Reveal the source that follows the reviewed unit",
        group: "Reader navigation",
        icon: <ChevronDown className="size-4" />,
        shortcut: readerShortcuts.revealContextBelow,
        disabled: !contextAvailable || contextAfter >= availableAfter,
        onSelect: revealContextBelow,
      },
      {
        id: "reader-reveal-context-above",
        label: "Show more lines above",
        description: "Reveal the source that precedes the reviewed unit",
        group: "Reader navigation",
        icon: <ChevronUp className="size-4" />,
        shortcut: readerShortcuts.revealContextAbove,
        disabled: !contextAvailable || contextBefore >= availableBefore,
        onSelect: revealContextAbove,
      },
      {
        id: "reader-toggle-context",
        label: contextVisible ? "Hide surrounding context" : "Show context",
        description: contextVisible
          ? "Return to the focused repository unit"
          : "Reveal nearby lines without expanding the review scope",
        group: "Reader navigation",
        icon: <FileCode2 className="size-4" />,
        shortcut: readerShortcuts.context,
        disabled: !contextAvailable,
        onSelect: toggleContext,
      },
      {
        id: "reader-toggle-previous-source",
        label: showPrevious
          ? "Show current revision"
          : "Show previous revision",
        description: "Compare what this symbol looked like before the update",
        group: "Reader navigation",
        icon: <History className="size-4" />,
        shortcut: readerShortcuts.togglePreviousSource,
        disabled: !active || active.previousSource === null,
        onSelect: togglePreviousSource,
      },
      {
        id: "reader-search-path",
        label: "Search the reading path",
        description: "Find a file or symbol in this snapshot",
        group: "Reader actions",
        icon: <Search className="size-4" />,
        shortcut: readerShortcuts.search,
        onSelect: focusSearch,
      },
      {
        id: "reader-toggle-path-panel",
        label: "Toggle review path",
        description: "Show or hide the left reading panel",
        group: "Reader actions",
        icon: <PanelLeftOpen className="size-4" />,
        shortcut: readerShortcuts.togglePathPanel,
        onSelect: () => setSidebarOpen((value) => !value),
      },
      {
        id: "reader-sign-off",
        label: "Sign off",
        description: active
          ? `Record ${active.name} as read and open the next unread unit`
          : "Record this unit as read",
        group: "Reader actions",
        icon: <Check className="size-4" />,
        shortcut: readerShortcuts.signOff,
        alternateShortcut: readerShortcuts.signOffHere,
        disabled: !canSignOff,
        onSelect: runSignOff,
      },
      {
        id: "reader-mark-unread",
        label: "Mark unread",
        description: "Return this unit to the reading queue",
        group: "Reader actions",
        icon: <Undo2 className="size-4" />,
        shortcut: readerShortcuts.undoSignOff,
        disabled: !canUnreview,
        onSelect: runUnreview,
      },
    ],
    [
      active,
      activeIndex,
      availableAfter,
      availableBefore,
      canSignOff,
      canUnreview,
      contextAfter,
      contextAvailable,
      contextBefore,
      contextVisible,
      focusSearch,
      revealContextAbove,
      revealContextBelow,
      resumeQueue,
      runSignOff,
      runUnreview,
      scrollCode,
      selectUnit,
      showPrevious,
      signed,
      stepFile,
      togglePreviousSource,
      toggleContext,
      units,
    ],
  );
  usePageCommandCenter(commands);

  const language = knownLanguage(active?.language ?? "text");
  const displayedStartLine = contextVisible
    ? unitStartLine - Math.min(contextBefore, availableBefore)
    : unitStartLine;
  const displayedEndLine = contextVisible
    ? unitEndLine + Math.min(contextAfter, availableAfter)
    : unitEndLine;
  const displayedSource =
    contextVisible && fullFileAvailable
      ? fullFileLines.slice(displayedStartLine - 1, displayedEndLine).join("\n")
      : showPrevious
        ? (active?.previousSource ?? active?.source)
        : active?.source;
  const highlightedLines = useHighlightedSource(
    displayedSource ?? "",
    language ?? "text",
  );

  return (
    <div className="bg-ink fixed inset-0 z-40 flex flex-col overflow-hidden">
      <header className="bg-panel flex h-16 shrink-0 items-center gap-3 border-b border-line px-3 sm:px-5">
        <Button size="icon" variant="ghost" asChild>
          <Link href="/repo-reviews" aria-label="Back to repo reviews">
            <ArrowLeft className="size-4" />
            <LinkPendingSpinner />
          </Link>
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="w-auto px-2.5"
          aria-label={sidebarOpen ? "Hide review path" : "Show review path"}
          onClick={() => setSidebarOpen((value) => !value)}
        >
          {sidebarOpen ? (
            <PanelLeftClose className="size-4 shrink-0" />
          ) : (
            <PanelLeftOpen className="size-4 shrink-0" />
          )}
          <ShortcutHint
            shortcut={readerShortcuts.togglePathPanel}
            className="max-lg:hidden"
          />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="text-cloud truncate text-sm font-semibold">
            {monitor.repositoryOwner}/{monitor.repositoryName}
          </div>
          <div className="text-mist mt-0.5 flex items-center gap-2 text-[11px]">
            <GitBranch className="size-3" /> {monitor.branch}
            <span>·</span>
            <span className="font-mono">
              {monitor.snapshot?.headSha.slice(0, 7)}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={focusSearch}
          className="text-mist hover:text-cloud hover:bg-surface-hover hidden items-center gap-2 rounded-xl border border-line bg-surface/75 px-3 text-xs transition sm:flex"
        >
          <Search className="size-3.5" />
          Find file or symbol
          <ShortcutHint shortcut={readerShortcuts.search} />
        </button>
        <div className="hidden w-44 sm:block">
          <div className="text-mist flex items-center justify-between text-[11px]">
            <span>
              {signed}/{units.length} read
            </span>
            <span>{percent}%</span>
          </div>
          <div className="bg-surface-subtle mt-1.5 h-1.5 overflow-hidden rounded-full">
            <div
              className="bg-lime h-full rounded-full transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <aside className="bg-panel border-line w-[320px] shrink-0 overflow-y-auto border-r max-md:absolute max-md:inset-y-16 max-md:left-0 max-md:z-20 max-md:shadow-2xl">
            <div className="bg-panel border-line sticky top-0 z-10 border-b p-3">
              <label className="relative block">
                <Search className="text-mist absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                <input
                  ref={searchInputRef}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setSearch("");
                      event.currentTarget.blur();
                    }
                  }}
                  placeholder="Find file or symbol"
                  aria-label="Find file or symbol"
                  className="border-line bg-surface text-cloud focus:border-lime/50 h-10 w-full rounded-xl border pr-3 pl-9 text-xs outline-none"
                />
              </label>
              {pending.some(
                ({ changedSinceSignOff }) => changedSinceSignOff,
              ) && (
                <div className="border-lime/20 bg-lime/7 text-lime mt-3 rounded-xl border px-3 py-2 text-[11px]">
                  Changed since your last read is pinned into the path below.
                </div>
              )}
            </div>
            <div className="p-2">
              {paths.length === 0 && (
                <div
                  className="border-line mx-2 mt-4 rounded-xl border border-dashed px-4 py-6 text-center"
                  aria-live="polite"
                >
                  <Search className="text-fog mx-auto size-5" />
                  <p className="text-cloud mt-3 text-xs font-medium">
                    {search.trim()
                      ? `No files or symbols match “${search.trim()}”.`
                      : "No reviewable symbols are available in this snapshot."}
                  </p>
                  {search.trim() && (
                    <button
                      type="button"
                      className="text-lime hover:text-lime-bright mt-3 text-xs font-medium"
                      onClick={() => setSearch("")}
                    >
                      Clear search
                    </button>
                  )}
                </div>
              )}
              {paths.map(([path, pathUnits]) => (
                <div key={path} className="mb-2">
                  <div className="text-mist flex items-center gap-2 px-2 py-2 text-[11px] font-medium">
                    <FileCode2 className="size-3.5 shrink-0" />
                    <span className="truncate">{path}</span>
                  </div>
                  {pathUnits.map((unit) => (
                    <button
                      key={unit.id}
                      type="button"
                      aria-current={active?.id === unit.id ? "true" : undefined}
                      onClick={() => {
                        selectUnit(unit);
                        if (window.innerWidth < 768) setSidebarOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left transition",
                        active?.id === unit.id
                          ? "bg-lime/9 text-cloud"
                          : "text-mist hover:bg-surface-hover hover:text-cloud",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-1 size-2 shrink-0 rounded-full",
                          unit.status === "signed_off"
                            ? "bg-lime"
                            : unit.changedSinceSignOff
                              ? "bg-amber-400"
                              : "border-line-strong border",
                        )}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium">
                          {unit.name}
                        </span>
                        <span className="text-fog mt-0.5 block text-[10px]">
                          {unit.kind} · lines {unit.startLine}-{unit.endLine}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </aside>
        )}

        <section className="bg-code flex min-w-0 flex-1 flex-col">
          {active ? (
            <>
              <div className="bg-panel border-line flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-cloud truncate text-xs font-medium">
                    {active.path}
                  </div>
                  <div className="text-mist mt-0.5 truncate text-[11px]">
                    {active.kind} · {active.name} · Unit {activeIndex + 1}/
                    {units.length}
                  </div>
                </div>
                {active.changedSinceSignOff && (
                  <span className="border-amber-400/25 bg-amber-400/8 text-amber-300 rounded-lg border px-2 py-1 text-[10px] font-semibold">
                    Changed since read
                  </span>
                )}
                {contextAvailable && (
                  <Button
                    size="sm"
                    variant={contextVisible ? "secondary" : "ghost"}
                    aria-pressed={contextVisible}
                    onClick={toggleContext}
                  >
                    <FileCode2 className="size-3.5" />
                    {contextVisible ? "Hide context" : "Show context"}
                    <ShortcutHint
                      shortcut={readerShortcuts.context}
                      className="max-sm:hidden"
                    />
                  </Button>
                )}
                {active.previousSource !== null && (
                  <Button
                    size="sm"
                    variant={showPrevious ? "secondary" : "ghost"}
                    aria-pressed={showPrevious}
                    onClick={togglePreviousSource}
                  >
                    <History className="size-3.5" />
                    {showPrevious ? "Current revision" : "Previous revision"}
                    <ShortcutHint
                      shortcut={readerShortcuts.togglePreviousSource}
                      className="max-sm:hidden"
                    />
                  </Button>
                )}
              </div>
              <div
                ref={codeScrollRef}
                className="min-h-0 flex-1 overflow-auto [overflow-anchor:none]"
              >
                {sourceLoading && !displayedSource ? (
                  <div className="text-mist flex h-full items-center justify-center gap-2 text-sm">
                    <LoaderCircle className="size-4 animate-spin" /> Loading
                    verified source…
                  </div>
                ) : (
                  <>
                    {contextBefore < availableBefore && (
                      <div className="flex items-center gap-3 px-4 pt-3 font-sans">
                        <span className="h-px flex-1 bg-line" />
                        <button
                          type="button"
                          onClick={revealContextAbove}
                          className="text-fog hover:border-cyan/25 hover:bg-cyan/[.05] hover:text-cyan flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[9px] transition"
                        >
                          <ChevronUp className="size-3" />
                          Show{" "}
                          {Math.min(
                            CONTEXT_PAGE_LINES,
                            availableBefore - contextBefore,
                          )}{" "}
                          {contextBefore > 0 ? "more " : ""}lines above
                          <ShortcutHint
                            shortcut={readerShortcuts.revealContextAbove}
                            className="ml-1"
                          />
                        </button>
                        <span className="h-px flex-1 bg-line" />
                      </div>
                    )}
                    <HighlightedSourceLines
                      lines={highlightedLines}
                      startLine={displayedStartLine}
                      focusRange={{
                        startLine: unitStartLine,
                        endLine: unitEndLine,
                      }}
                      selectedRange={ruleSelection}
                      onSelectLine={selectRuleLine}
                      renderAfterLine={(lineNumber) =>
                        ruleSelection?.endLine === lineNumber ? (
                          <div className="border-cyan/20 bg-panel mx-4 my-2 ml-[82px] rounded-xl border p-4 font-sans shadow-xl">
                            <div className="flex min-w-0 items-start justify-between gap-3">
                              <div>
                                <p className="text-cloud flex items-center gap-2 text-xs font-semibold">
                                  <ShieldCheck className="text-cyan size-3.5" />
                                  Create compliance rule
                                </p>
                                <p className="text-fog mt-1 font-mono text-[9px]">
                                  {active.path} · lines{" "}
                                  {ruleSelection.startLine}
                                  {ruleSelection.endLine !==
                                    ruleSelection.startLine &&
                                    `–${ruleSelection.endLine}`}
                                </p>
                              </div>
                              <button
                                type="button"
                                aria-label="Close compliance rule editor"
                                className="text-fog hover:bg-surface-hover hover:text-cloud rounded-lg p-1.5 transition"
                                onClick={() => setRuleSelection(undefined)}
                              >
                                <X className="size-3.5" />
                              </button>
                            </div>
                            <div className="mt-4 grid gap-3 lg:grid-cols-2">
                              <label className="text-mist text-[10px] font-medium">
                                <span className="mb-1.5 block">Rule name</span>
                                <input
                                  aria-label="Rule name"
                                  value={ruleForm.title}
                                  onChange={(event) =>
                                    setRuleForm({
                                      ...ruleForm,
                                      title: event.target.value,
                                    })
                                  }
                                  placeholder="Validate authorization at boundaries"
                                  className="form-input"
                                />
                              </label>
                              <label className="text-mist text-[10px] font-medium">
                                <span className="mb-1.5 block">Applies to</span>
                                <input
                                  aria-label="Rule path glob"
                                  value={ruleForm.pathGlob}
                                  onChange={(event) =>
                                    setRuleForm({
                                      ...ruleForm,
                                      pathGlob: event.target.value,
                                    })
                                  }
                                  className="form-input font-mono"
                                />
                              </label>
                            </div>
                            <label className="text-mist mt-3 block text-[10px] font-medium">
                              <span className="mb-1.5 block">Instruction</span>
                              <textarea
                                ref={ruleInstructionRef}
                                aria-label="Rule instruction"
                                value={ruleForm.instruction}
                                onChange={(event) =>
                                  setRuleForm({
                                    ...ruleForm,
                                    instruction: event.target.value,
                                  })
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Escape") {
                                    event.preventDefault();
                                    setRuleSelection(undefined);
                                  } else if (
                                    event.key === "Enter" &&
                                    (event.metaKey || event.ctrlKey)
                                  ) {
                                    event.preventDefault();
                                    saveRule();
                                  }
                                }}
                                placeholder="Describe the convention that compliance checks should enforce…"
                                rows={3}
                                className="form-input h-auto resize-y py-3"
                              />
                            </label>
                            <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
                              <div className="flex gap-3">
                                <label className="text-mist text-[10px] font-medium">
                                  <span className="mb-1.5 block">Scope</span>
                                  <select
                                    aria-label="Rule scope"
                                    value={ruleForm.scope}
                                    onChange={(event) =>
                                      setRuleForm({
                                        ...ruleForm,
                                        scope: event.target
                                          .value as typeof ruleForm.scope,
                                      })
                                    }
                                    className="form-input w-auto"
                                  >
                                    <option value="file">Per file</option>
                                    <option value="repository">
                                      Repository-wide
                                    </option>
                                  </select>
                                </label>
                                <label className="text-mist text-[10px] font-medium">
                                  <span className="mb-1.5 block">Severity</span>
                                  <select
                                    aria-label="Rule severity"
                                    value={ruleForm.severity}
                                    onChange={(event) =>
                                      setRuleForm({
                                        ...ruleForm,
                                        severity: event.target
                                          .value as RuleSeverity,
                                      })
                                    }
                                    className="form-input w-auto"
                                  >
                                    <option value="low">Low</option>
                                    <option value="medium">Medium</option>
                                    <option value="high">High</option>
                                    <option value="critical">Critical</option>
                                  </select>
                                </label>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-fog hidden text-[9px] sm:inline">
                                  Shift-click another line to extend · ⌘ Enter
                                  to save
                                </span>
                                <Button
                                  size="sm"
                                  loading={addRule.isPending}
                                  disabled={
                                    !ruleForm.title.trim() ||
                                    !ruleForm.instruction.trim() ||
                                    !ruleForm.pathGlob.trim()
                                  }
                                  onClick={saveRule}
                                >
                                  Add rule
                                </Button>
                              </div>
                            </div>
                          </div>
                        ) : null
                      }
                    />
                    {contextAfter < availableAfter && (
                      <div className="flex items-center gap-3 px-4 pb-3 font-sans">
                        <span className="h-px flex-1 bg-line" />
                        <button
                          type="button"
                          onClick={revealContextBelow}
                          className="text-fog hover:border-cyan/25 hover:bg-cyan/[.05] hover:text-cyan flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[9px] transition"
                        >
                          <ChevronDown className="size-3" />
                          Show{" "}
                          {Math.min(
                            CONTEXT_PAGE_LINES,
                            availableAfter - contextAfter,
                          )}{" "}
                          {contextAfter > 0 ? "more " : ""}lines below
                          <ShortcutHint
                            shortcut={readerShortcuts.revealContextBelow}
                            className="ml-1"
                          />
                        </button>
                        <span className="h-px flex-1 bg-line" />
                      </div>
                    )}
                  </>
                )}
              </div>
              <footer className="bg-panel border-line flex h-16 shrink-0 items-center justify-between gap-3 border-t px-4">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={activeIndex <= 0}
                  onClick={() => selectUnit(units[activeIndex - 1])}
                >
                  <ChevronLeft className="size-4" /> Previous
                  <ShortcutHint
                    shortcut={readerShortcuts.previousUnit}
                    className="max-md:hidden"
                  />
                </Button>
                {signOffQueue.ids.size > 0 && (
                  <span
                    role="status"
                    aria-label={`Saving reviews, ${signOffQueueProgress}`}
                    className="border-line-strong bg-surface text-mist ml-auto flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border px-2.5 text-[10px] shadow-[0_8px_24px_var(--app-shadow)] sm:h-10 sm:px-3"
                  >
                    <LoaderCircle className="size-3 animate-spin" />
                    <span className="hidden sm:inline">Saving</span>
                    <span className="font-mono text-cloud">
                      {signOffQueueProgress}
                    </span>
                  </span>
                )}
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={activeIndex >= units.length - 1}
                    onClick={() => selectUnit(units[activeIndex + 1])}
                  >
                    Next <ChevronRight className="size-4" />
                    <ShortcutHint
                      shortcut={readerShortcuts.nextUnit}
                      className="max-md:hidden"
                    />
                  </Button>
                  {active.status === "signed_off" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={unreview.isPending}
                      disabled={!canUnreview}
                      onClick={runUnreview}
                    >
                      <Undo2 className="size-4" /> Mark unread
                      <ShortcutHint
                        shortcut={readerShortcuts.undoSignOff}
                        className="max-sm:hidden"
                      />
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      loading={activeSignOffPending}
                      onClick={runSignOff}
                    >
                      <Check className="size-4" /> Sign off
                      <ShortcutHint
                        shortcut={readerShortcuts.signOff}
                        className="max-sm:hidden"
                      />
                      <ChevronRight className="size-3.5" />
                    </Button>
                  )}
                </div>
              </footer>
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <CheckCircle2 className="text-lime mx-auto size-9" />
                <h2 className="text-cloud mt-4 font-semibold">
                  No reviewable source units
                </h2>
                <p className="text-mist mt-2 text-sm">
                  The snapshot contains no supported code symbols.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
