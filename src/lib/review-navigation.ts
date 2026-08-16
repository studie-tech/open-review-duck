interface ReviewNavigationUnit {
  status: "pending" | "signed_off" | "changed" | "waiting";
}

/**
 * Explains, per finding state, why a finding cannot become a review comment.
 *
 * `review_comment.unitId` and `review_comment.line` are both `notNull`, so a
 * finding that never resolved to a line inside a review unit is structurally
 * unpublishable. It is still shown: a discard the reader cannot see is
 * indistinguishable from a finding the reviewer never made.
 */
export const unpublishableFindingReason: Record<string, string> = {
  unanchored: "No line in this revision matched the quoted code",
  out_of_scope: "Anchored outside the lines this pull request changed",
  ungrounded: "The agent never proved it read the code it reported on",
  refuted: "A verification pass could not reproduce this",
};

export type DeepReviewFindingTarget =
  | { kind: "line"; unitIndex: number; line: number }
  | { kind: "unit"; unitIndex: number }
  | { kind: "nowhere"; reason: string };

interface DeepReviewFindingLocation {
  path: string;
  startLine: number | null;
}

interface TargetableDeepReviewFinding {
  unitId: string | null;
  path: string | null;
  startLine: number | null;
  state: string;
  locations: readonly DeepReviewFindingLocation[];
}

interface TargetableReviewUnit {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
}

/** Resolves one path-and-line pair against the units of this revision. */
function reviewUnitTargetForPath(
  location: DeepReviewFindingLocation,
  units: readonly TargetableReviewUnit[],
): DeepReviewFindingTarget | undefined {
  const line = location.startLine;
  if (line !== null) {
    const containing = units.findIndex(
      (unit) =>
        unit.path === location.path &&
        unit.startLine <= line &&
        line <= unit.endLine,
    );
    if (containing >= 0) return { kind: "line", unitIndex: containing, line };
  }
  // The line is outside every unit of this file, so the file itself is the
  // most specific honest destination: no amber line is lit on code the
  // finding does not actually accuse.
  const unitIndex = units.findIndex((unit) => unit.path === location.path);
  return unitIndex >= 0 ? { kind: "unit", unitIndex } : undefined;
}

/** Resolves where opening a deep-review finding sends the code pane. */
export function deepReviewFindingTarget(
  finding: TargetableDeepReviewFinding,
  units: readonly TargetableReviewUnit[],
  locationIndex = 0,
): DeepReviewFindingTarget {
  // A `unitId` from an earlier revision no longer names a unit; failing to
  // match here is what lets the path rule below rescue the click rather than
  // dead-end it.
  const anchoredIndex = finding.unitId
    ? units.findIndex((unit) => unit.id === finding.unitId)
    : -1;
  if (anchoredIndex >= 0) {
    return finding.startLine !== null
      ? { kind: "line", unitIndex: anchoredIndex, line: finding.startLine }
      : { kind: "unit", unitIndex: anchoredIndex };
  }

  const location =
    finding.path !== null
      ? { path: finding.path, startLine: finding.startLine }
      : finding.locations[locationIndex];
  const resolved = location && reviewUnitTargetForPath(location, units);
  if (resolved) return resolved;

  return {
    kind: "nowhere",
    reason:
      unpublishableFindingReason[finding.state] ??
      "This finding never resolved to a line in this revision",
  };
}

export interface IndexedReviewUnit<T extends ReviewNavigationUnit> {
  unit: T;
  index: number;
}

export interface ReviewHierarchyNode<T> {
  unit: T;
  index: number;
  children: ReviewHierarchyNode<T>[];
}

export interface ReviewNavigationHistory {
  unitIds: string[];
  cursor: number;
}

/** Creates a navigation trail anchored to the first visible review unit. */
export function createReviewNavigationHistory(unitId?: string) {
  return {
    unitIds: unitId ? [unitId] : [],
    cursor: unitId ? 0 : -1,
  } satisfies ReviewNavigationHistory;
}

/** Adds a visited unit while discarding any obsolete forward history. */
export function pushReviewNavigationHistory(
  history: ReviewNavigationHistory,
  unitId: string,
) {
  if (history.unitIds[history.cursor] === unitId) return history;
  const unitIds = [...history.unitIds.slice(0, history.cursor + 1), unitId];
  return { unitIds, cursor: unitIds.length - 1 };
}

/** Resolves one backward or forward step in the visited-unit trail. */
export function reviewNavigationHistoryTarget(
  history: ReviewNavigationHistory,
  direction: -1 | 1,
) {
  const cursor = history.cursor + direction;
  const unitId = history.unitIds[cursor];
  if (!unitId) return undefined;
  return {
    unitId,
    history: { ...history, cursor },
  };
}

/** Checks whether a review unit still requires reviewer action. */
function isActionable(unit: ReviewNavigationUnit) {
  return unit.status !== "signed_off" && unit.status !== "waiting";
}

/** Finds the next actionable unit in canonical review order. */
export function nextPendingReviewIndex<T extends ReviewNavigationUnit>(
  units: T[],
  matches: (unit: T, index: number) => boolean = () => true,
) {
  return units.findIndex(
    (unit, index) => isActionable(unit) && matches(unit, index),
  );
}

export type ReviewAvailability = "active" | "caught_up" | "complete";

/** Distinguishes finished work from a review paused entirely on responses. */
export function reviewAvailability<
  T extends ReviewNavigationUnit & { id: string },
>(units: T[], pausedUnitIds: ReadonlySet<string>) {
  if (units.every(({ status }) => status === "signed_off")) {
    return "complete" satisfies ReviewAvailability;
  }
  const actionable = nextPendingReviewIndex(
    units,
    (unit) => !pausedUnitIds.has(unit.id),
  );
  if (actionable < 0 && units.some(({ status }) => status === "waiting")) {
    return "caught_up" satisfies ReviewAvailability;
  }
  return "active" satisfies ReviewAvailability;
}

/**
 * Prefers one actionable subset, then falls back to canonical review order.
 *
 * `matches` narrows both passes, so a caller that rules a unit out keeps it
 * ruled out when the preferred subset comes up empty.
 */
export function nextPendingReviewIndexPreferring<
  T extends ReviewNavigationUnit,
>(
  units: T[],
  preferred: (unit: T, index: number) => boolean,
  matches: (unit: T, index: number) => boolean = () => true,
) {
  const preferredIndex = nextPendingReviewIndex(
    units,
    (unit, index) => matches(unit, index) && preferred(unit, index),
  );
  return preferredIndex >= 0
    ? preferredIndex
    : nextPendingReviewIndex(units, matches);
}

/** Marks one unit as reviewed locally before its sign-off reaches the server. */
export function optimisticallySignOffReviewUnit<
  T extends ReviewNavigationUnit & {
    id: string;
    changedSinceSignOff: boolean;
  },
>(units: T[], unitId: string) {
  return optimisticallySignOffReviewUnits(units, [unitId]);
}

/** Marks several units as reviewed in one immutable update. */
export function optimisticallySignOffReviewUnits<
  T extends ReviewNavigationUnit & {
    id: string;
    changedSinceSignOff: boolean;
  },
>(units: T[], unitIds: Iterable<string>) {
  const selected = new Set(unitIds);
  if (!units.some((unit) => selected.has(unit.id))) return units;
  return units.map(
    (unit): T =>
      selected.has(unit.id)
        ? {
            ...unit,
            status: "signed_off",
            changedSinceSignOff: false,
          }
        : unit,
  );
}

/** Selects outstanding units that belong to files deleted in their entirety. */
export function deletedFileSignOffUnits<
  T extends ReviewNavigationUnit & { path: string },
>(units: T[], fileContexts: Array<{ changeType: string; path: string }>): T[] {
  const deletedPaths = new Set(
    fileContexts
      .filter(({ changeType }) => changeType === "deleted")
      .map(({ path }) => path),
  );
  return units.filter(
    (unit) => deletedPaths.has(unit.path) && isActionable(unit),
  );
}

/** Restores a failed optimistic sign-off without disturbing newer unit state. */
export function restoreReviewUnitAfterFailedSignOff<
  T extends ReviewNavigationUnit & {
    id: string;
    changedSinceSignOff: boolean;
  },
>(units: T[], original: T) {
  return units.map(
    (unit): T =>
      unit.id === original.id
        ? {
            ...unit,
            status: original.status,
            changedSinceSignOff: original.changedSinceSignOff,
          }
        : unit,
  );
}

/** Checks whether a unit matches the review-path search fields. */
export function reviewPathSearchMatches(
  unit: { name: string; path: string; kind: string },
  search: string,
) {
  const query = search.trim().toLowerCase();
  return (
    query.length > 0 &&
    `${unit.name} ${unit.path} ${unit.kind}`.toLowerCase().includes(query)
  );
}

/** Partitions review units into reviewed, waiting, current, and upcoming groups. */
export function reviewPathSections<T extends ReviewNavigationUnit>(
  units: T[],
  activeIndex: number,
) {
  const entries = units.map((unit, index) => ({ unit, index }));
  const current = entries[activeIndex];

  return {
    current,
    upcoming: entries.filter(
      ({ unit, index }) => index !== activeIndex && isActionable(unit),
    ),
    reviewed: entries.filter(
      ({ unit, index }) =>
        unit.status === "signed_off" && index !== activeIndex,
    ),
    waiting: entries.filter(
      ({ unit, index }) => unit.status === "waiting" && index !== activeIndex,
    ),
  };
}

/** Builds a deterministic dependency forest from units in canonical review order. */
export function buildReviewHierarchy<
  T extends { id: string; dependencies: string[] },
>(units: T[]) {
  const entries = units.map((unit, index) => ({ unit, index }));
  const entryById = new Map(entries.map((entry) => [entry.unit.id, entry]));
  const dependentIds = new Set(
    units.flatMap(({ dependencies }) =>
      dependencies.filter((dependency) => entryById.has(dependency)),
    ),
  );
  const visited = new Set<string>();

  /** Claims one unit and its dependencies for the first concept that reaches it. */
  function visit(entry: (typeof entries)[number]): ReviewHierarchyNode<T> {
    visited.add(entry.unit.id);
    const children = entry.unit.dependencies
      .map((dependency) => entryById.get(dependency))
      .filter(
        (dependency): dependency is (typeof entries)[number] =>
          dependency !== undefined && !visited.has(dependency.unit.id),
      )
      .sort((left, right) => left.index - right.index)
      .map(visit);
    return { ...entry, children };
  }

  const roots = entries
    .filter(({ unit }) => !dependentIds.has(unit.id))
    .sort((left, right) => left.index - right.index);
  const forest = roots.filter(({ unit }) => !visited.has(unit.id)).map(visit);
  for (const entry of entries) {
    if (!visited.has(entry.unit.id)) forest.push(visit(entry));
  }
  return forest;
}
