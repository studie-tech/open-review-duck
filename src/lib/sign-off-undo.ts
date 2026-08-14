/** Everything needed to put the reviewer back where a sign-off was made. */
export interface ReviewViewSnapshot {
  contextAfter: number;
  contextBefore: number;
  pathSearch: string;
  scrollTop: number;
  searchLimit: number;
  showDiff: boolean;
  unitIndex: number;
}

export type SignOffUndoEntry =
  | {
      kind: "unit";
      label: string;
      unitIds: string[];
      view: ReviewViewSnapshot;
    }
  | {
      kind: "concept";
      conceptId: string;
      label: string;
      layoutId: string;
      layoutVersion: number;
      unitIds: string[];
      view: ReviewViewSnapshot;
    };

/**
 * How many sign-offs one review session may step back through.
 *
 * Undo exists to take back a decision the reviewer has just seen the
 * consequence of, not to replay the session, and every retained entry pins a
 * unit list that a resync can invalidate.
 */
export const MAX_SIGN_OFF_UNDO_ENTRIES = 20;

/** Records one sign-off as the newest step of a bounded undo history. */
export function rememberSignOff(
  history: readonly SignOffUndoEntry[],
  entry: SignOffUndoEntry,
) {
  return [entry, ...history].slice(0, MAX_SIGN_OFF_UNDO_ENTRIES);
}

/**
 * Finds the newest sign-off that undoing would still change something about.
 *
 * A recorded step stops describing the review the moment its units leave the
 * snapshot or come back to the queue some other way. Those steps are dropped
 * rather than offered, so the shortcut always acts on the last decision that
 * still stands.
 */
export function nextUndoableSignOff<
  Unit extends { id: string; status: string },
>(history: readonly SignOffUndoEntry[], units: readonly Unit[]) {
  const statusById = new Map(units.map((unit) => [unit.id, unit.status]));
  const index = history.findIndex((entry) =>
    entry.unitIds.some((id) => statusById.get(id) === "signed_off"),
  );
  const entry = index < 0 ? undefined : history[index];
  if (!entry) return undefined;
  return { entry, remaining: history.slice(index + 1) };
}

/**
 * Chooses how to take one recorded sign-off back.
 *
 * A concept is undone as a concept while the layout it was signed off under
 * is still the active one. The reviewer's first sign-off replaces a shared
 * baseline layout with a personal copy, which re-mints every concept id, so
 * beyond that the units themselves are the only stable way back.
 */
export function signOffUndoTarget(
  entry: SignOffUndoEntry,
  conceptLayout?: { id: string; version: number },
) {
  if (
    entry.kind === "concept" &&
    conceptLayout?.id === entry.layoutId &&
    conceptLayout.version === entry.layoutVersion
  ) {
    return {
      kind: "concept" as const,
      conceptId: entry.conceptId,
      layoutId: entry.layoutId,
      layoutVersion: entry.layoutVersion,
    };
  }
  return { kind: "units" as const, unitIds: entry.unitIds };
}
