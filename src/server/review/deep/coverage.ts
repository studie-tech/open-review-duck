export type DeepReviewItemState =
  | "selected"
  | "completed"
  | "reused"
  | "failed"
  | "waived";

export type ReviewFailureClass =
  | "provider"
  | "timeout"
  | "budget"
  | "cancelled"
  | "tool_limit"
  | "unknown";

export type DeepReviewTerminalState =
  | "complete"
  | "partial"
  | "failed"
  | "skipped";

export interface CoverageItem {
  state: DeepReviewItemState;
  path?: string;
}

interface CoveragePartitionInput {
  selectedCount: number;
  items: readonly CoverageItem[];
  paths?: readonly string[];
}

/** Derives the run's terminal state from coverage alone, never from findings. */
export function deepReviewTerminalState(
  items: readonly { state: DeepReviewItemState }[],
): DeepReviewTerminalState {
  if (items.length === 0) return "skipped";
  let failed = 0;
  for (const item of items) {
    // finalize sweeps every lingering `selected` before deriving state, so one
    // reaching here means the sweep was skipped and the denominator is a lie.
    if (item.state === "selected") {
      throw new Error(
        'deepReviewTerminalState received an item still in state "selected"',
      );
    }
    if (item.state === "failed") failed += 1;
  }
  // `waived` is a stated decision to exclude a file, so it covers the file.
  if (failed === 0) return "complete";
  return failed === items.length ? "failed" : "partial";
}

/** Reports every way the coverage items fail to partition the sealed plan. */
export function coveragePartitionErrors(
  input: CoveragePartitionInput,
): string[] {
  const { selectedCount, items } = input;
  const errors: string[] = [];

  if (!Number.isInteger(selectedCount) || selectedCount < 0) {
    errors.push(
      `sealed denominator ${selectedCount} is not a non-negative integer`,
    );
  } else if (items.length !== selectedCount) {
    errors.push(
      `coverage holds ${items.length} item(s) but the sealed denominator is ${selectedCount}`,
    );
  }

  const lingering = items.flatMap((item, index) =>
    item.state === "selected" ? [describeCoverageItem(item, index)] : [],
  );
  if (lingering.length > 0) {
    errors.push(
      `${lingering.length} item(s) never left state "selected": ${lingering.join(", ")}`,
    );
  }

  const paths = input.paths ?? coverageItemPaths(items);
  if (input.paths && input.paths.length !== items.length) {
    errors.push(
      `path list holds ${input.paths.length} entry/entries but coverage holds ${items.length} item(s)`,
    );
  }
  for (const path of duplicatePaths(paths)) {
    errors.push(`path is covered by more than one item: ${path}`);
  }

  return errors;
}

/** Names a coverage item for an assertion message, by path when it has one. */
function describeCoverageItem(item: CoverageItem, index: number): string {
  return item.path ?? `#${index}`;
}

/** Collects the paths the items carry themselves, ignoring those without one. */
function coverageItemPaths(items: readonly CoverageItem[]): string[] {
  return items.flatMap((item) => (item.path ? [item.path] : []));
}

/** Returns each path that occurs more than once, in first-seen order. */
function duplicatePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) duplicates.add(path);
    seen.add(path);
  }
  return [...duplicates];
}

const TIMEOUT_MARKERS = [
  "timeout",
  "timed out",
  "etimedout",
  "esockettimedout",
  "deadline exceeded",
];
const TIMEOUT_ERROR_NAMES = new Set([
  "aborterror",
  "timeouterror",
  "connecttimeouterror",
  "headerstimeouterror",
  "bodytimeouterror",
]);
const CANCEL_MARKERS = ["cancel"];
const ABORT_MARKERS = ["abort"];
const TOOL_LIMIT_MARKERS = [
  "tool call limit",
  "tool limit",
  "investigation limit",
  "max tool calls",
  "too many tool calls",
];
const RATE_LIMIT_MARKERS = ["rate limit", "too many requests"];
const BUDGET_MARKERS = [
  "quota",
  "budget",
  "token limit",
  "cost limit",
  "spend limit",
  "out of credits",
];
const PROVIDER_MARKERS = [
  "provider",
  "fetch failed",
  "bad gateway",
  "service unavailable",
  "internal server error",
  "server error",
  "socket hang up",
  "econnreset",
  "econnrefused",
  "enotfound",
  "epipe",
  "overloaded",
  "upstream",
  "api error",
];

const HTTP_STATUS_PATTERN = /(?:status|http|code)[^0-9]{0,12}([45]\d{2})\b/g;
const MAX_CAUSE_DEPTH = 8;

interface ErrorEvidence {
  text: string;
  names: string[];
  statuses: number[];
}

/** Classifies a thrown value into the failure class persisted on the item. */
export function classifyReviewItemError(cause: unknown): ReviewFailureClass {
  const evidence = collectErrorEvidence(cause);
  const { text } = evidence;

  if (matchesAny(text, TIMEOUT_MARKERS)) return "timeout";
  if (matchesAny(text, CANCEL_MARKERS)) return "cancelled";
  if (matchesAny(text, TOOL_LIMIT_MARKERS)) return "tool_limit";
  // A rate limit is the provider throttling us, not the workspace running out
  // of budget, so it is settled before the "quota" wording reaches the budget
  // markers below.
  if (matchesAny(text, RATE_LIMIT_MARKERS)) return "provider";
  if (matchesAny(text, BUDGET_MARKERS)) return "budget";
  // An AbortError names no reason of its own, so it only outranks the bare word
  // "aborted": every wording that does explain the abort was matched already.
  if (evidence.names.some((name) => TIMEOUT_ERROR_NAMES.has(name))) {
    return "timeout";
  }
  if (matchesAny(text, ABORT_MARKERS)) return "cancelled";
  if (matchesAny(text, PROVIDER_MARKERS)) return "provider";
  if (evidence.statuses.some((status) => status >= 400 && status <= 599)) {
    return "provider";
  }
  return "unknown";
}

/** Flattens a thrown value into the text, error names and statuses it carries. */
function collectErrorEvidence(cause: unknown): ErrorEvidence {
  const fragments: string[] = [];
  const names: string[] = [];
  const statuses: number[] = [];
  const seen = new Set<object>();

  /** Absorbs one link of the cause graph, guarding against cycles and depth. */
  const visit = (value: unknown, depth: number) => {
    if (value === null || value === undefined || depth > MAX_CAUSE_DEPTH)
      return;
    if (typeof value === "string") {
      fragments.push(value);
      return;
    }
    if (typeof value === "number") {
      statuses.push(value);
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    const record = value as Record<string, unknown>;
    if (typeof record.name === "string") names.push(record.name.toLowerCase());
    if (typeof record.message === "string") fragments.push(record.message);
    if (typeof record.code === "string") fragments.push(record.code);
    for (const key of ["status", "statusCode", "code"]) {
      const raw = record[key];
      if (typeof raw === "number") statuses.push(raw);
    }
    for (const key of ["cause", "error", "response", "data"]) {
      visit(record[key], depth + 1);
    }
    if (Array.isArray(record.errors)) {
      for (const nested of record.errors) visit(nested, depth + 1);
    }
  };

  visit(cause, 0);
  const text = normalizeErrorText(fragments.join(" "));
  for (const match of text.matchAll(HTTP_STATUS_PATTERN)) {
    statuses.push(Number(match[1]));
  }
  return { text, names, statuses };
}

/** Folds separators away so "quota_limit" and "timed-out" match plain wording. */
function normalizeErrorText(text: string): string {
  return text.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Reports whether the normalized error text contains any of the markers. */
function matchesAny(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}
