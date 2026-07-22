interface ReviewNavigationUnit {
  status: "pending" | "signed_off" | "changed" | "waiting";
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

/** Marks one unit as reviewed locally before its sign-off reaches the server. */
export function optimisticallySignOffReviewUnit<
  T extends ReviewNavigationUnit & {
    id: string;
    changedSinceSignOff: boolean;
  },
>(units: T[], unitId: string) {
  if (!units.some((unit) => unit.id === unitId)) return units;
  return units.map(
    (unit): T =>
      unit.id === unitId
        ? {
            ...unit,
            status: "signed_off",
            changedSinceSignOff: false,
          }
        : unit,
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
