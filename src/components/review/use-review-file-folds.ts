"use client";

import { useCallback, useRef, useState } from "react";

/** Keeps full-file expansion and its saved unit folds together across navigation. */
export function useReviewFileFolds() {
  const [fullFilePaths, setFullFilePaths] = useState(() => new Set<string>());
  const fullFileFoldSnapshots = useRef(
    new Map<string, Map<string, boolean | undefined>>(),
  );
  const [unitFoldOverrides, setUnitFoldOverrides] = useState(
    () => new Map<string, boolean>(),
  );

  /**
   * Opens every unit in a file or restores its original fold overrides.
   * Absent overrides stay absent so status and inspection still set defaults.
   */
  function toggleFullFile(
    path: string,
    units: readonly { id: string; path: string }[],
  ) {
    const previousFolds = fullFileFoldSnapshots.current.get(path);
    if (previousFolds) {
      fullFileFoldSnapshots.current.delete(path);
      setUnitFoldOverrides((current) => {
        const next = new Map(current);
        for (const [id, override] of previousFolds) {
          if (override === undefined) next.delete(id);
          else next.set(id, override);
        }
        return next;
      });
    } else {
      const fileUnits = units.filter((member) => member.path === path);
      fullFileFoldSnapshots.current.set(
        path,
        new Map(
          fileUnits.map((member) => [
            member.id,
            unitFoldOverrides.get(member.id),
          ]),
        ),
      );
      setUnitFoldOverrides((current) => {
        const next = new Map(current);
        for (const member of fileUnits) next.set(member.id, false);
        return next;
      });
    }
    setFullFilePaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  /** Resets inspection folds unless the file is still in Full file mode. */
  const clearUnitFoldOverrides = useCallback(
    (path: string, unitIds: readonly string[]) => {
      if (fullFileFoldSnapshots.current.has(path)) return;
      setUnitFoldOverrides((current) => {
        if (unitIds.every((id) => !current.has(id))) return current;
        const next = new Map(current);
        for (const id of unitIds) next.delete(id);
        return next;
      });
    },
    [],
  );

  /** Discards folds and saved file views when a new source revision loads. */
  const resetFileFolds = useCallback(() => {
    fullFileFoldSnapshots.current.clear();
    setFullFilePaths(new Set());
    setUnitFoldOverrides(new Map());
  }, []);

  return {
    clearUnitFoldOverrides,
    fullFilePaths,
    resetFileFolds,
    setUnitFoldOverrides,
    toggleFullFile,
    unitFoldOverrides,
  };
}
