"use client";

import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { deepReviewFindingTarget } from "~/lib/review-navigation";
import type { RouterOutputs } from "~/trpc/react";
import { groupDeepReviewFindings } from "./deep-review-findings";

type WorkspaceData = RouterOutputs["review"]["workspace"];
type ReviewUnit = WorkspaceData["units"][number];
type DeepReviewRun = NonNullable<RouterOutputs["review"]["deepReviewFindings"]>;
type DeepReviewFinding = DeepReviewRun["findings"][number];

interface PendingFindingReveal {
  exhausted: boolean;
  fallbackUsed: boolean;
  findingId: string;
  line: number;
  unitId: string;
}

interface DeepReviewFindingControllerInput {
  activeIndex: number;
  activeSourceHydrationPending: boolean;
  activeUnitId?: string;
  codeScrollRef: RefObject<HTMLDivElement | null>;
  findings?: DeepReviewFinding[];
  selectUnit: (index: number) => void;
  setShowDiff: (show: boolean) => void;
  sideBySideVisible: boolean;
  units: ReviewUnit[];
}

/** Owns deep-review filtering, selection, navigation, and deferred revealing. */
export function useDeepReviewFindingController({
  activeIndex,
  activeSourceHydrationPending,
  activeUnitId,
  codeScrollRef,
  findings,
  selectUnit,
  setShowDiff,
  sideBySideVisible,
  units,
}: DeepReviewFindingControllerInput) {
  const [severityFilter, setSeverityFilter] = useState(() => new Set<string>());
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [activeFindingId, setActiveFindingId] = useState<string>();
  const [activeLocationIndex, setActiveLocationIndex] = useState(0);
  const [findingLine, setFindingLine] = useState<number>();
  const [pendingReveal, setPendingReveal] = useState<PendingFindingReveal>();
  const findingsListRef = useRef<HTMLDivElement>(null);

  const filteredFindings = useMemo(
    () =>
      (findings ?? []).filter(
        (finding) =>
          (severityFilter.size === 0 || severityFilter.has(finding.severity)) &&
          (categoryFilter === "all" || finding.category === categoryFilter),
      ),
    [categoryFilter, findings, severityFilter],
  );
  const findingGroups = useMemo(
    () => groupDeepReviewFindings(filteredFindings, units),
    [filteredFindings, units],
  );
  const visibleFindings = useMemo(
    () => findingGroups.flatMap((group) => group.findings),
    [findingGroups],
  );
  const activeFinding = findings?.find(({ id }) => id === activeFindingId);
  const activeFindingTarget = activeFinding
    ? deepReviewFindingTarget(activeFinding, units, activeLocationIndex)
    : undefined;

  /** Brings a finding with no line target into the code viewport. */
  const revealDetachedFinding = useCallback(
    (findingId: string) => {
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          const card = document.getElementById(`finding-${findingId}`);
          if (!card) {
            codeScrollRef.current?.scrollTo({ top: 0 });
            return;
          }
          card.scrollIntoView({ block: "center" });
          card.focus({ preventScroll: true });
        }),
      );
    },
    [codeScrollRef],
  );

  /** Opens one finding beside its target, or as a detached card. */
  function openFinding(finding: DeepReviewFinding, locationIndex = 0) {
    setActiveFindingId(finding.id);
    setActiveLocationIndex(locationIndex);
    const target = deepReviewFindingTarget(finding, units, locationIndex);
    if (target.kind === "nowhere") {
      setFindingLine(undefined);
      setPendingReveal(undefined);
      revealDetachedFinding(finding.id);
      return;
    }
    if (target.unitIndex !== activeIndex) selectUnit(target.unitIndex);
    const unitId = units[target.unitIndex]?.id;
    if (target.kind === "unit" || !unitId) {
      setFindingLine(undefined);
      setPendingReveal(undefined);
      revealDetachedFinding(finding.id);
      return;
    }
    setFindingLine(target.line);
    setPendingReveal({
      exhausted: false,
      fallbackUsed: false,
      findingId: finding.id,
      line: target.line,
      unitId,
    });
  }

  /** Opens the neighbouring finding in visible index order. */
  function stepFinding(delta: 1 | -1) {
    if (visibleFindings.length === 0) return;
    const current = visibleFindings.findIndex(
      ({ id }) => id === activeFindingId,
    );
    const next =
      current < 0
        ? delta === 1
          ? 0
          : visibleFindings.length - 1
        : Math.min(Math.max(current + delta, 0), visibleFindings.length - 1);
    const finding = visibleFindings[next];
    if (!finding) return;
    openFinding(finding);
    window.requestAnimationFrame(() =>
      findingsListRef.current
        ?.querySelector<HTMLElement>(`[data-finding-row="${finding.id}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
  }

  /** Collapses the open finding and restores focus to its index row. */
  function collapseFinding(findingId: string) {
    setActiveFindingId(undefined);
    setFindingLine(undefined);
    setPendingReveal(undefined);
    findingsListRef.current
      ?.querySelector<HTMLElement>(`[data-finding-row="${findingId}"]`)
      ?.focus();
  }

  /** Toggles one severity without disturbing the other selected severities. */
  function toggleFindingSeverity(severity: string) {
    setSeverityFilter((current) => {
      const next = new Set(current);
      if (!next.delete(severity)) next.add(severity);
      return next;
    });
  }

  useEffect(() => {
    if (!activeFindingId || !findings) return;
    if (findings.some(({ id }) => id === activeFindingId)) return;
    setActiveFindingId(undefined);
    setFindingLine(undefined);
    setPendingReveal(undefined);
  }, [activeFindingId, findings]);

  useEffect(() => {
    if (!pendingReveal || pendingReveal.exhausted) return;
    const pending = pendingReveal;
    if (activeUnitId !== pending.unitId) return;
    if (activeSourceHydrationPending) return;
    let frames = 0;
    let handle = 0;

    /** Scrolls to the accused line once its unit has rendered. */
    function attempt() {
      const element = document.getElementById(`review-line-${pending.line}`);
      if (element) {
        element.scrollIntoView({ block: "center", behavior: "smooth" });
        document
          .getElementById(`finding-${pending.findingId}`)
          ?.focus({ preventScroll: true });
        setPendingReveal(undefined);
        return;
      }
      if (frames++ >= 20) {
        if (!pending.fallbackUsed && sideBySideVisible) {
          setShowDiff(false);
          setPendingReveal({ ...pending, fallbackUsed: true });
          toast.info(
            `Showing the current source so line ${pending.line} is visible`,
          );
          return;
        }
        setPendingReveal({ ...pending, exhausted: true });
        revealDetachedFinding(pending.findingId);
        toast.info(`Line ${pending.line} is not rendered for this unit`, {
          description: "The finding is shown above the diff instead.",
        });
        return;
      }
      handle = window.requestAnimationFrame(attempt);
    }

    handle = window.requestAnimationFrame(attempt);
    return () => window.cancelAnimationFrame(handle);
  }, [
    activeSourceHydrationPending,
    activeUnitId,
    pendingReveal,
    revealDetachedFinding,
    setShowDiff,
    sideBySideVisible,
  ]);

  return {
    activeFinding,
    activeFindingId,
    activeFindingTarget,
    activeLocationIndex,
    categoryFilter,
    collapseFinding,
    filteredFindings,
    findingGroups,
    findingLine,
    findingsListRef,
    openFinding,
    pendingReveal,
    revealExhausted:
      pendingReveal?.exhausted === true &&
      pendingReveal.findingId === activeFindingId,
    setActiveFindingId,
    setActiveLocationIndex,
    setCategoryFilter,
    setFindingLine,
    setPendingReveal,
    setSeverityFilter,
    severityFilter,
    stepFinding,
    toggleFindingSeverity,
    visibleFindings,
  };
}
