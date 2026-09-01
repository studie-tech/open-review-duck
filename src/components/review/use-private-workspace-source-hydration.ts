"use client";

import { toast } from "sonner";
import { prioritizePrivateReviewSources } from "~/lib/private-source-client";
import {
  FILES_VIEWER_PAGE_SIZE,
  FILES_VIEWER_PREFETCH_RADIUS,
  nearbyReviewFilePaths,
  reviewFileEntries,
  storedReviewMode,
} from "~/lib/review-files";
import {
  preservePrivateSourceReviewState,
  usePrivateSourceHydration,
} from "~/lib/use-private-source-hydration";
import type { RouterOutputs } from "~/trpc/react";

type WorkspaceData = RouterOutputs["review"]["workspace"];

/** Hydrates private workspace sources while preserving the snapshot manifest. */
export function usePrivateWorkspaceSourceHydration(
  initialData: WorkspaceData,
  activeIndex: number,
) {
  const sourceUnits = initialData.units;
  const visibleUnit = sourceUnits[activeIndex] ?? sourceUnits[0];
  const visibleConcept = visibleUnit
    ? initialData.concepts.find((concept) =>
        concept.memberIds.includes(visibleUnit.id),
      )
    : undefined;
  const relatedIds = new Set(visibleConcept?.memberIds ?? []);
  const filesMode =
    typeof window !== "undefined" &&
    storedReviewMode(window.localStorage) === "files";
  const relatedPaths = filesMode
    ? nearbyReviewFilePaths(
        reviewFileEntries(initialData.files, sourceUnits),
        visibleUnit?.path,
        FILES_VIEWER_PAGE_SIZE + FILES_VIEWER_PREFETCH_RADIUS,
      )
    : new Set(
        sourceUnits
          .filter(({ id }) => relatedIds.has(id))
          .map(({ path }) => path),
      );
  const prioritizedUnits = prioritizePrivateReviewSources(sourceUnits, {
    activeId: visibleUnit?.id,
    activePath: visibleUnit?.path,
    relatedIds,
    relatedPaths,
  });
  const prioritizedContexts = prioritizePrivateReviewSources(
    initialData.fileContexts,
    { activePath: visibleUnit?.path, relatedPaths },
  );
  const {
    pending: sourceHydrationPending,
    relatedSources: fileContexts,
    setSources: setUnits,
    settledSourceKeys: settledUnitIds,
    sources: units,
    successfulSourceKeys,
  } = usePrivateSourceHydration({
    snapshotId: initialData.snapshot?.id,
    sources: sourceUnits,
    hydrationSources: prioritizedUnits,
    sourceKey: ({ id }) => id,
    sourceConcurrency: 6,
    relatedSources: initialData.fileContexts,
    relatedHydrationSources: prioritizedContexts,
    relatedSourceKey: ({ path }) => path,
    relatedConcurrency: 2,
    preserveSourceState: preservePrivateSourceReviewState,
    onFailures: (failures) => {
      const affectedFiles = new Set(failures.map(({ path }) => path)).size;
      toast.error(
        `${affectedFiles} private source ${affectedFiles === 1 ? "file" : "files"} could not be loaded`,
        { description: "The rest of the review remains available." },
      );
    },
  });
  const hydratedUnitIds = new Set(
    units.flatMap((unit) =>
      successfulSourceKeys.has(unit.id) &&
      (unit.kind === "binary" || unit.currentBlobId || unit.previousBlobId)
        ? [unit.id]
        : [],
    ),
  );

  return {
    fileContexts,
    hydratedUnitIds,
    settledUnitIds,
    setUnits,
    sourceHydrationPending,
    units,
  };
}
