import { createHash } from "node:crypto";

export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type FindingCategory =
  | "bug"
  | "security"
  | "performance"
  | "maintainability"
  | "test"
  | "style"
  | "documentation"
  | "other";

/** Ordered worst-first so the index doubles as the sort rank. */
const findingSeverities: readonly FindingSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
];

const findingCategories: readonly FindingCategory[] = [
  "bug",
  "security",
  "performance",
  "maintainability",
  "test",
  "style",
  "documentation",
  "other",
];

const severityValues = new Set<string>(findingSeverities);
const categoryValues = new Set<string>(findingCategories);

/** Degrades an unrecognized severity to the least alarming value, never rejecting. */
export function normalizeFindingSeverity(value: unknown): FindingSeverity {
  if (typeof value !== "string") return "low";
  const normalized = value.trim().toLowerCase();
  return severityValues.has(normalized)
    ? (normalized as FindingSeverity)
    : "low";
}

/** Degrades an unrecognized category to `other`, never rejecting the finding. */
export function normalizeFindingCategory(value: unknown): FindingCategory {
  if (typeof value !== "string") return "other";
  const normalized = value.trim().toLowerCase();
  return categoryValues.has(normalized)
    ? (normalized as FindingCategory)
    : "other";
}

/** Ranks severities from 0 for `critical` to 3 for `low`, worst surfaced first. */
export function findingSeverityRank(severity: FindingSeverity): number {
  return findingSeverities.indexOf(severity);
}

/** Strips whitespace and one diff marker so a reported line matches file text. */
function normalizeSnippetLine(line: string): string {
  const trimmed = line.trim();
  const marked = trimmed.startsWith("+") || trimmed.startsWith("-");
  return (marked ? trimmed.slice(1) : trimmed).trim();
}

/** Reduces reported code to the anchoring form both sides compare against. */
export function normalizeSnippet(code: string): string {
  return code
    .split("\n")
    .map(normalizeSnippetLine)
    .filter((line) => line !== "")
    .join("\n");
}

/** Derives a finding id that survives replay and never collides within a call. */
export function deepReviewFindingId(input: {
  toolCallId: string;
  index: number;
}): string {
  // The persisted tool-call id plus the position within that call is the only
  // pair that is both stable across a replayed durable step and unique between
  // two findings a model reports with identical text.
  return createHash("sha256")
    .update(`${input.toolCallId}\0${input.index}`)
    .digest("hex")
    .slice(0, 32);
}

interface OrderableFinding {
  severity: FindingSeverity;
  path: string | null;
  startLine: number | null;
  id: string;
}

/** Sorts nulls after values, keeping unanchored findings below located ones. */
function compareNullable<T extends string | number>(
  left: T | null,
  right: T | null,
): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

/** Orders findings by severity, then location, then id as the total tiebreak. */
export function orderFindings<T extends OrderableFinding>(
  findings: readonly T[],
): T[] {
  return [...findings].sort((left, right) => {
    const bySeverity =
      findingSeverityRank(left.severity) - findingSeverityRank(right.severity);
    if (bySeverity !== 0) return bySeverity;
    const byPath = compareNullable(left.path, right.path);
    if (byPath !== 0) return byPath;
    const byLine = compareNullable(left.startLine, right.startLine);
    if (byLine !== 0) return byLine;
    return compareNullable(left.id, right.id);
  });
}
