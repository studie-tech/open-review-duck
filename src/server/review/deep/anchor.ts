export type AnchorTier =
  | "unit_current"
  | "changed_current"
  | "file_current"
  | "file_previous"
  | "relocated"
  | "ambiguous"
  | "none";

export type AnchorSide = "current" | "previous";

export interface AnchorRange {
  startLine: number;
  endLine: number;
}

export interface AnchorResult {
  tier: AnchorTier;
  side: AnchorSide | null;
  startLine: number | null;
  endLine: number | null;
  ambiguous: boolean;
}

export interface AnchorLine {
  line: number;
  content: string;
}

export interface AnchorInput {
  existingCode: string;
  currentSource: string | null;
  previousSource: string | null;
  changedRanges: readonly AnchorRange[];
  unitRanges?: readonly AnchorRange[];
  evidenceRanges?: readonly AnchorRange[];
}

const UNRESOLVED: AnchorResult = {
  tier: "none",
  side: null,
  startLine: null,
  endLine: null,
  ambiguous: false,
};

const AMBIGUOUS: AnchorResult = {
  tier: "ambiguous",
  side: null,
  startLine: null,
  endLine: null,
  ambiguous: true,
};

/** Trims one source line and strips a single leading diff marker. */
function normalizeLine(line: string): string {
  const trimmed = line.trim();
  const marked = trimmed.startsWith("+") || trimmed.startsWith("-");
  return (marked ? trimmed.slice(1) : trimmed).trim();
}

/**
 * Splits a snippet into normalized lines, dropping blanks so that
 * "consecutive" means adjacent non-blank lines on both sides of a match.
 */
export function normalizeSnippetLines(snippet: string): string[] {
  return snippet
    .split("\n")
    .map(normalizeLine)
    .filter((line) => line.length > 0);
}

/** Pairs every non-blank normalized source line with its 1-based number. */
function indexSource(source: string): AnchorLine[] {
  const lines: AnchorLine[] = [];
  const raw = source.split("\n");
  for (let index = 0; index < raw.length; index++) {
    const content = normalizeLine(raw[index] ?? "");
    if (content.length > 0) lines.push({ line: index + 1, content });
  }
  return lines;
}

/**
 * Returns every consecutive match of a needle rather than only the first, so
 * a snippet repeated in one file can be disambiguated instead of guessed.
 */
export function matchAllConsecutive(
  haystackLines: readonly AnchorLine[],
  needle: readonly string[],
): AnchorRange[] {
  const target = needle.map(normalizeLine).filter((line) => line.length > 0);
  const haystack = haystackLines
    .map((entry) => ({
      line: entry.line,
      content: normalizeLine(entry.content),
    }))
    .filter((entry) => entry.content.length > 0);
  if (target.length === 0 || haystack.length < target.length) return [];
  const matches: AnchorRange[] = [];
  for (let start = 0; start <= haystack.length - target.length; start++) {
    const first = haystack[start];
    const last = haystack[start + target.length - 1];
    if (!first || !last) continue;
    const matched = target.every(
      (line, offset) => haystack[start + offset]?.content === line,
    );
    if (matched) {
      matches.push({ startLine: first.line, endLine: last.line });
    }
  }
  return matches;
}

/**
 * Matches inside each range separately so a run cannot span the gap between
 * two disjoint ranges and report a span the file does not contain.
 */
function matchWithinRanges(
  lines: readonly AnchorLine[],
  needle: readonly string[],
  ranges: readonly AnchorRange[],
): AnchorRange[] {
  const seen = new Set<string>();
  const matches: AnchorRange[] = [];
  for (const range of ranges) {
    const scoped = lines.filter(
      (entry) => entry.line >= range.startLine && entry.line <= range.endLine,
    );
    for (const match of matchAllConsecutive(scoped, needle)) {
      const key = `${match.startLine}:${match.endLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(match);
    }
  }
  return matches.sort((left, right) => left.startLine - right.startLine);
}

/** Returns whether two inclusive line spans share at least one line. */
function overlaps(left: AnchorRange, right: AnchorRange): boolean {
  return left.startLine <= right.endLine && left.endLine >= right.startLine;
}

/** Returns whether a span falls entirely inside an outer range. */
function contains(outer: AnchorRange, span: AnchorRange): boolean {
  return outer.startLine <= span.startLine && outer.endLine >= span.endLine;
}

/** Returns the gap in lines between a span and a range, zero when they meet. */
function gapTo(span: AnchorRange, range: AnchorRange): number {
  if (overlaps(span, range)) return 0;
  return Math.max(
    range.startLine - span.endLine,
    span.startLine - range.endLine,
  );
}

/** Returns a span's distance to the nearest of the given ranges. */
function nearestGap(span: AnchorRange, ranges: readonly AnchorRange[]): number {
  return ranges.reduce(
    (best, range) => Math.min(best, gapTo(span, range)),
    Number.POSITIVE_INFINITY,
  );
}

/**
 * Narrows repeated matches by change overlap, then unit containment, then
 * evidence proximity; a tie surviving all three stays deliberately unresolved.
 */
function disambiguate(
  candidates: readonly AnchorRange[],
  changedRanges: readonly AnchorRange[],
  unitRanges: readonly AnchorRange[],
  evidenceRanges: readonly AnchorRange[],
): AnchorRange | null {
  let pool = [...candidates];
  const changed = pool.filter((span) =>
    changedRanges.some((range) => overlaps(span, range)),
  );
  if (changed.length > 0) pool = changed;
  if (pool.length === 1) return pool[0] ?? null;
  const inUnit = pool.filter((span) =>
    unitRanges.some((range) => contains(range, span)),
  );
  if (inUnit.length > 0) pool = inUnit;
  if (pool.length === 1) return pool[0] ?? null;
  if (evidenceRanges.length > 0) {
    const nearest = Math.min(
      ...pool.map((span) => nearestGap(span, evidenceRanges)),
    );
    pool = pool.filter((span) => nearestGap(span, evidenceRanges) === nearest);
  }
  return pool.length === 1 ? (pool[0] ?? null) : null;
}

/** Builds a resolved anchor from a single surviving candidate span. */
function anchored(
  tier: AnchorTier,
  side: AnchorSide,
  span: AnchorRange,
): AnchorResult {
  return {
    tier,
    side,
    startLine: span.startLine,
    endLine: span.endLine,
    ambiguous: false,
  };
}

/**
 * Resolves a verbatim snippet to a 1-based line span by narrowing search
 * spaces in turn, because the model reports code and never a line number.
 */
export function resolveAnchor(input: AnchorInput): AnchorResult {
  const needle = normalizeSnippetLines(input.existingCode);
  if (needle.length === 0) return UNRESOLVED;
  const changedRanges = input.changedRanges;
  const unitRanges = input.unitRanges ?? [];
  const evidenceRanges = input.evidenceRanges ?? [];
  const current = input.currentSource ? indexSource(input.currentSource) : [];
  const previous = input.previousSource
    ? indexSource(input.previousSource)
    : [];
  const tiers: {
    tier: AnchorTier;
    side: AnchorSide;
    search: () => AnchorRange[];
  }[] = [
    {
      tier: "unit_current",
      side: "current",
      search: () => matchWithinRanges(current, needle, unitRanges),
    },
    {
      tier: "changed_current",
      side: "current",
      search: () => matchWithinRanges(current, needle, changedRanges),
    },
    {
      tier: "file_current",
      side: "current",
      search: () => matchAllConsecutive(current, needle),
    },
    {
      tier: "file_previous",
      side: "previous",
      search: () => matchAllConsecutive(previous, needle),
    },
  ];
  for (const { tier, side, search } of tiers) {
    const matches = search();
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only) return anchored(tier, side, only);
    if (matches.length === 0) continue;
    const resolved = disambiguate(
      matches,
      changedRanges,
      unitRanges,
      evidenceRanges,
    );
    // A wider tier can only add candidates, so an unresolved tie is final.
    return resolved ? anchored(tier, side, resolved) : AMBIGUOUS;
  }
  return UNRESOLVED;
}

/** Returns whether a resolved span touches any changed line range. */
export function anchorIsInScope(
  anchor: AnchorResult,
  changedRanges: readonly AnchorRange[],
): boolean {
  return touches(anchor, changedRanges);
}

/** Returns whether a resolved span touches any range the agent read. */
export function anchorIsGrounded(
  anchor: AnchorResult,
  evidenceRanges: readonly AnchorRange[],
): boolean {
  return touches(anchor, evidenceRanges);
}

/** Returns an anchor's span, or null when nothing was resolved. */
function spanOf(anchor: AnchorResult): AnchorRange | null {
  if (anchor.startLine === null || anchor.endLine === null) return null;
  return { startLine: anchor.startLine, endLine: anchor.endLine };
}

/** Returns whether an anchor's span overlaps at least one range. */
function touches(
  anchor: AnchorResult,
  ranges: readonly AnchorRange[],
): boolean {
  const span = spanOf(anchor);
  if (!span) return false;
  return ranges.some((range) => overlaps(span, range));
}
