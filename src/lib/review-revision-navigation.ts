interface PositionedUnit {
  id: string;
  stableKey?: string;
  path: string;
  name?: string;
  startLine: number;
}

/** Keeps an explicit selection across new unit ids, renames, and removals. */
export function reviewIndexAfterRefresh(
  previous: PositionedUnit | undefined,
  units: readonly PositionedUnit[],
  files: readonly { path: string; previousPath: string | null }[],
) {
  if (!previous || units.length === 0) return 0;
  const exact = units.findIndex(
    (unit) =>
      unit.id === previous.id ||
      (previous.stableKey && unit.stableKey === previous.stableKey),
  );
  if (exact >= 0) return exact;
  const path =
    files.find((file) => file.previousPath === previous.path)?.path ??
    previous.path;
  const sameFile = units
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => unit.path === path)
    .sort(
      (left, right) =>
        Number(right.unit.name === previous.name) -
          Number(left.unit.name === previous.name) ||
        Math.abs(left.unit.startLine - previous.startLine) -
          Math.abs(right.unit.startLine - previous.startLine),
    );
  if (sameFile[0]) return sameFile[0].index;
  const byPath = units
    .map((unit, index) => ({ unit, index }))
    .sort((left, right) => left.unit.path.localeCompare(right.unit.path));
  return (
    byPath.find(({ unit }) => unit.path.localeCompare(path) >= 0)?.index ??
    byPath.at(-1)?.index ??
    0
  );
}
