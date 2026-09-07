"use client";

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import {
  FILES_VIEWER_PREVIEW_RADIUS,
  outstandingReviewFileUnits,
  type ReviewMode,
  reviewFileCardsInTreeOrder,
  reviewFileEntries,
} from "~/lib/review-files";
import {
  PrivateWorkspaceSourceStore,
  type WorkspaceSourcePriority,
  type WorkspaceSourceStatus,
} from "~/lib/private-workspace-source-store";
import type { RouterOutputs } from "~/trpc/react";

type WorkspaceData = RouterOutputs["review"]["workspace"];
type ReviewUnit = WorkspaceData["units"][number];

const EMPTY_SET = new Set<string>();

/** Returns a stable no-op unsubscribe function for absent stores. */
const subscribeToNothing = () => () => undefined;

/** Returns the initial revision exposed while no store exists. */
const zeroRevision = () => 0;

/** Removes source payloads from the mutable review ledger. */
function reviewUnitWithoutSource(unit: ReviewUnit): ReviewUnit {
  return { ...unit, source: "", previousSource: null };
}

/** Preserves live review decisions while applying one store-owned source slice. */
function mergeReviewUnitSource(current: ReviewUnit, hydrated: ReviewUnit) {
  return {
    ...hydrated,
    status: current.status,
    changedSinceSignOff: current.changedSinceSignOff,
    waitingSince: current.waitingSince,
    signOffOrigin: current.signOffOrigin,
  };
}

/** Returns unique paths without losing the navigation order that predicted them. */
function uniquePaths(paths: Array<string | undefined>, activePath?: string) {
  return [
    ...new Set(
      paths.filter(
        (path): path is string => Boolean(path) && path !== activePath,
      ),
    ),
  ];
}

export interface WorkspaceSourcePlan {
  activePath?: string;
  nextPaths: string[];
  previewPaths: string[];
}

/**
 * Translates File or Guided navigation semantics into source-loading intent.
 *
 * The store remains mode-agnostic. File mode follows the file tree and its
 * visible previews; Guided mode follows the active concept's member order and
 * then warms every file in the next actionable concept.
 */
export function workspaceSourcePlan(
  data: Pick<WorkspaceData, "concepts" | "files">,
  units: readonly ReviewUnit[],
  activeUnitId: string | undefined,
  mode: ReviewMode,
): WorkspaceSourcePlan {
  const active = units.find(({ id }) => id === activeUnitId) ?? units[0];
  const activePath = active?.path;
  if (!active) return { activePath, nextPaths: [], previewPaths: [] };

  if (mode === "files") {
    const cards = reviewFileCardsInTreeOrder(
      reviewFileEntries(data.files, units),
    );
    const activeIndex = cards.findIndex(({ path }) => path === active.path);
    const next = Array.from(
      { length: Math.max(0, cards.length - 1) },
      (_, offset) =>
        cards[(Math.max(0, activeIndex) + offset + 1) % cards.length],
    ).find(
      (card) =>
        card && outstandingReviewFileUnits({ units: card.members }).length > 0,
    );
    const previewPaths =
      activeIndex < 0
        ? []
        : cards
            .slice(
              Math.max(0, activeIndex - FILES_VIEWER_PREVIEW_RADIUS),
              activeIndex + FILES_VIEWER_PREVIEW_RADIUS + 1,
            )
            .map(({ path }) => path);
    return {
      activePath,
      nextPaths: uniquePaths([next?.path], activePath),
      previewPaths: uniquePaths(previewPaths, activePath).filter(
        (path) => path !== next?.path,
      ),
    };
  }

  const activeConcept = data.concepts.find(({ memberIds }) =>
    memberIds.includes(active.id),
  );
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const conceptMembers = activeConcept?.memberIds
    .map((id) => unitById.get(id))
    .filter((unit): unit is ReviewUnit => Boolean(unit));
  const actionableConceptPaths = uniquePaths(
    (conceptMembers ?? [])
      .filter(
        ({ id, status }) =>
          id !== active.id && status !== "signed_off" && status !== "waiting",
      )
      .map(({ path }) => path),
    activePath,
  );
  const nextGlobal = units.find(
    ({ id, status, path }) =>
      id !== active.id &&
      path !== activePath &&
      status !== "signed_off" &&
      status !== "waiting" &&
      !actionableConceptPaths.includes(path),
  );
  const nextConcept = nextGlobal
    ? data.concepts.find(({ memberIds }) => memberIds.includes(nextGlobal.id))
    : undefined;
  const nextConceptPaths = uniquePaths(
    (nextConcept?.memberIds ?? [])
      .map((id) => unitById.get(id))
      .filter(
        (unit): unit is ReviewUnit =>
          unit !== undefined &&
          unit.status !== "signed_off" &&
          unit.status !== "waiting",
      )
      .map(({ path }) => path),
    activePath,
  ).filter((path) => !actionableConceptPaths.includes(path));
  return {
    activePath,
    nextPaths: actionableConceptPaths,
    previewPaths: nextConceptPaths,
  };
}

/** Materializes source fields for the files that the shared store has loaded. */
function materializeUnits(
  units: readonly ReviewUnit[],
  store:
    | PrivateWorkspaceSourceStore<
        ReviewUnit,
        WorkspaceData["fileContexts"][number]
      >
    | undefined,
) {
  if (!store) return [...units];
  return units.map((unit) => {
    const hydrated = store
      .result(unit.path)
      ?.units.find(({ id }) => id === unit.id);
    return hydrated ? mergeReviewUnitSource(unit, hydrated) : unit;
  });
}

/**
 * Owns review decisions separately from demand-loaded private source.
 *
 * Mode changes only replace the intent plan. Verified file results and in-flight
 * object promises survive, and an interactive request can promote queued work
 * without restarting the immutable snapshot.
 */
export function usePrivateWorkspaceSourceHydration(
  initialData: WorkspaceData,
  activeIndex: number,
  reviewMode: ReviewMode,
  intentReady = true,
) {
  const snapshotId = initialData.snapshot?.id;
  const [reviewLedger, setReviewLedger] = useState(() => ({
    snapshotId,
    units: initialData.units.map(reviewUnitWithoutSource),
  }));
  const snapshotChanged = reviewLedger.snapshotId !== snapshotId;
  const reviewUnits = snapshotChanged
    ? initialData.units.map(reviewUnitWithoutSource)
    : reviewLedger.units;
  if (snapshotChanged) {
    setReviewLedger({ snapshotId, units: reviewUnits });
  }
  const activeUnitId = reviewUnits[activeIndex]?.id ?? reviewUnits[0]?.id;
  // A snapshot owns one immutable source manifest. Review-state refreshes must
  // not replace its verified cache or interrupt interactive navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot identity owns its immutable source manifest
  const store = useMemo(
    () =>
      snapshotId
        ? new PrivateWorkspaceSourceStore({
            snapshotId,
            units: initialData.units,
            contexts: initialData.fileContexts,
            concurrency: 4,
            maximumReadyFiles: 24,
            onFailure: (cause) => {
              toast.error("Private source could not be loaded", {
                description:
                  cause instanceof Error
                    ? cause.message
                    : "Retry the affected file.",
              });
            },
            onMeasurement: (measurement) => {
              performance.measure("review-source-file-ready", {
                start: Math.max(
                  0,
                  performance.now() - measurement.totalMilliseconds,
                ),
                duration: measurement.totalMilliseconds,
                detail: measurement,
              });
            },
          })
        : undefined,
    [snapshotId],
  );
  useEffect(() => store?.retain(), [store]);
  const sourceRevision = useSyncExternalStore(
    store?.subscribe ?? subscribeToNothing,
    store?.revision ?? zeroRevision,
    zeroRevision,
  );
  const plan = useMemo(
    () =>
      workspaceSourcePlan(initialData, reviewUnits, activeUnitId, reviewMode),
    [activeUnitId, initialData, reviewMode, reviewUnits],
  );

  useEffect(() => {
    if (!store || !intentReady) return;
    /** Schedules intent without turning a prefetch failure into an unhandled rejection. */
    const request = (path: string, priority: WorkspaceSourcePriority) => {
      void store.request(path, priority).catch(() => undefined);
    };
    if (plan.activePath) request(plan.activePath, "active");
    for (const path of plan.nextPaths) request(path, "next");
    for (const path of plan.previewPaths) request(path, "preview");
  }, [intentReady, plan, store]);

  // Reading the external revision makes every store transition materialize a
  // fresh view below without coupling source ownership to React state.
  void sourceRevision;
  const units = materializeUnits(reviewUnits, store);
  const setUnits: Dispatch<SetStateAction<ReviewUnit[]>> = useCallback(
    (update) => {
      setReviewLedger((current) => {
        const ledgerUnits =
          current.snapshotId === snapshotId
            ? current.units
            : initialData.units.map(reviewUnitWithoutSource);
        const materialized = materializeUnits(ledgerUnits, store);
        const next =
          typeof update === "function" ? update(materialized) : update;
        return { snapshotId, units: next.map(reviewUnitWithoutSource) };
      });
    },
    [initialData.units, snapshotId, store],
  );
  const fileContexts = initialData.fileContexts.map(
    (context) => store?.result(context.path)?.context ?? context,
  );
  const hydratedUnitIds = store
    ? new Set(
        units.flatMap((unit) =>
          store.status(unit.path) === "ready" &&
          (unit.kind === "binary" || unit.currentBlobId || unit.previousBlobId)
            ? [unit.id]
            : [],
        ),
      )
    : EMPTY_SET;
  const settledUnitIds = store
    ? new Set(
        units.flatMap((unit) =>
          ["ready", "error"].includes(store.status(unit.path)) ? [unit.id] : [],
        ),
      )
    : EMPTY_SET;
  const sourceStatus = useCallback(
    (path: string | undefined): WorkspaceSourceStatus =>
      store?.status(path) ?? "idle",
    [store],
  );
  const prepareSourcePath = useCallback(
    (
      path: string,
      priority: WorkspaceSourcePriority = "active",
      retry = false,
    ) =>
      retry
        ? (store?.retry(path, priority) ??
          Promise.reject(new Error("No source snapshot")))
        : (store?.request(path, priority) ??
          Promise.reject(new Error("No source snapshot"))),
    [store],
  );
  const activeStatus = sourceStatus(plan.activePath);

  return {
    fileContexts,
    hydratedUnitIds,
    prepareSourcePath,
    settledUnitIds,
    setUnits,
    sourceHydrationPending:
      intentReady &&
      Boolean(plan.activePath) &&
      (activeStatus === "idle" ||
        activeStatus === "queued" ||
        activeStatus === "loading"),
    sourceStatus,
    units,
  };
}
