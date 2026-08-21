"use client";

import { useMachine } from "@xstate/react";
import {
  ArrowLeft,
  Ban,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  CornerUpLeft,
  ExternalLink,
  FileCode2,
  FolderInput,
  GitBranch,
  Info,
  Keyboard,
  LoaderCircle,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";
import {
  CommandCenter,
  type CommandCenterItem,
  type CommandCenterMode,
  ShortcutAlternatives,
  ShortcutHint,
  ShortcutSequenceIndicator,
  useCommandCenterBindings,
} from "~/components/command-center";
import { usePendingNavigation } from "~/components/navigation-progress";
import { ThemeToggle } from "~/components/theme-toggle";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import {
  LinkNavigationStatus,
  LinkPendingSpinner,
} from "~/components/ui/link-status";
import { aiErrorPresentation } from "~/lib/ai-errors";
import {
  type AiQuestionStreamUpdate,
  consumeAiQuestionStream,
} from "~/lib/ai-question-stream";
import { conceptStatusFromMembers } from "~/lib/concept-progress";
import { lockDocumentScroll } from "~/lib/document-scroll-lock";
import {
  findImportedDeclarationLine,
  findImportTargetUnit,
  type ImportReference,
} from "~/lib/import-navigation";
import { commandMenuShortcut } from "~/lib/keyboard-shortcuts";
import {
  hydratePrivateReviewSources,
  prioritizePrivateReviewSources,
} from "~/lib/private-source-client";
import {
  buildReviewHierarchy,
  deepReviewFindingTarget,
  deletedFileSignOffUnits,
  nextPendingReviewIndex,
  nextPendingReviewIndexPreferring,
  optimisticallySignOffReviewUnits,
  restoreReviewUnitAfterFailedSignOff,
  reviewAvailability,
  reviewPathSearchMatches,
  reviewPathSections,
  unpublishableFindingReason,
} from "~/lib/review-navigation";
import { reviewFoundationPriority } from "~/lib/review-priority";
import {
  acknowledgedReviewRevision,
  acknowledgeReviewRevision,
  type ReviewRevision,
  shortRevision,
} from "~/lib/review-revision";
import {
  currentChangedLineIndexes,
  sideBySideDiff,
  sourceByteOffsetLine,
  sourceEndLine,
  sourceStartLine,
} from "~/lib/side-by-side-diff";
import {
  createSignOffQueue,
  nextSignOffBatchSize,
  reviewFooterSaveState,
  signOffQueueReducer,
} from "~/lib/sign-off-queue";
import {
  nextUndoableSignOff,
  type ReviewViewSnapshot,
  rememberSignOff,
  type SignOffUndoEntry,
  signOffUndoTarget,
} from "~/lib/sign-off-undo";
import {
  isPeekableToken,
  SYMBOL_PEEK_ATTRIBUTE,
  SYMBOL_PEEK_LINE_ATTRIBUTE,
} from "~/lib/symbol-peek";
import {
  preloadSyntaxLanguage,
  useHighlightedSource,
} from "~/lib/syntax-highlighting";
import { formatTokenCount } from "~/lib/token-usage";
import { useImportReferences } from "~/lib/tree-sitter-import-navigation";
import { useSettledValue } from "~/lib/use-settled-value";
import { cn } from "~/lib/utils";
import { api, type RouterInputs, type RouterOutputs } from "~/trpc/react";
import { ProviderCommentBody } from "./provider-comment-body";
import { ProviderReviewDecision } from "./provider-review-decision";
import { findNextReview, ReviewCompletion } from "./review-completion";
import {
  overviewMarksFromDiffRows,
  overviewRangeFromDiffRows,
  ReviewScrollOverview,
  shouldShowReviewScrollOverview,
  useReviewCodeOverview,
} from "./review-scroll-overview";
import {
  ReviewWaitingCompletion,
  type WaitingReviewUnit,
} from "./review-waiting-completion";

type WorkspaceData = RouterOutputs["review"]["workspace"];
type ReviewUnit = WorkspaceData["units"][number];
type ReviewConcept = WorkspaceData["concepts"][number];
type ImportTarget = RouterOutputs["review"]["importTarget"];
type ImportPreview = Extract<ImportTarget, { kind: "preview" }>;
type SignOffInput = RouterInputs["review"]["signOff"];
type DeepReviewRun = NonNullable<RouterOutputs["review"]["deepReviewFindings"]>;
type DeepReviewFinding = DeepReviewRun["findings"][number];

// One shared element: every review-unit command renders the same static icon.
const unitCommandIcon = <FileCode2 className="size-4" />;

// Only three of the seven `ai_job_status` values are terminal. A deep-review
// parent sits in `waiting_for_provider` from `startAiJob` until seal-plan marks
// it running, so a predicate written as ["queued", "running"] reads a live
// fan-out as finished: polling stops and the run looks frozen.
const terminalAiJobStatuses = ["completed", "failed", "cancelled"];

/** Reports whether an AI job can still change state without a new request. */
export function aiJobActive(status: string | null | undefined) {
  return Boolean(status) && !terminalAiJobStatuses.includes(status ?? "");
}

interface RefetchableQuery {
  refetch: () => unknown;
}

/** Pulls the review tree once the pull-request review reaches a terminal status. */
export function useTerminalReviewRefetch(
  status: string | null | undefined,
  queries: {
    aiUsage: RefetchableQuery;
    deepReview: RefetchableQuery;
    discussion: RefetchableQuery;
  },
) {
  // A query result is a new object on every render, so the effect hangs off the
  // observer-bound `refetch` methods instead: those keep their identity, and
  // depending on the results themselves refetches on every keystroke.
  const { refetch: refetchAiUsage } = queries.aiUsage;
  const { refetch: refetchDeepReview } = queries.deepReview;
  const { refetch: refetchDiscussion } = queries.discussion;
  useEffect(() => {
    // A failed or cancelled parent still owns coverage rows and whatever its
    // children surfaced before the run stopped, so every terminal status pulls
    // the tree once, not just `completed`.
    if (!status || aiJobActive(status)) return;
    void refetchDiscussion();
    void refetchAiUsage();
    void refetchDeepReview();
  }, [refetchAiUsage, refetchDeepReview, refetchDiscussion, status]);
}

const findingSeverities = ["critical", "high", "medium", "low"] as const;
const findingCategories = [
  "bug",
  "security",
  "performance",
  "maintainability",
  "test",
  "style",
  "documentation",
  "other",
] as const;

// Four severities, not the three the explain path renders. `critical` and
// `high` both have to read as blocking without collapsing into one colour, so
// critical is filled and high is only tinted.
const findingSeverityStyle: Record<string, string> = {
  critical:
    "border-red-500/45 bg-red-500/15 text-red-700 dark:border-red-300/35 dark:text-red-200",
  high: "border-amber-500/40 bg-amber-400/10 text-amber-800 dark:border-amber-300/30 dark:text-amber-200",
  medium: "border-cyan/30 bg-cyan/[.08] text-cyan",
  low: "border-line bg-surface-subtle text-mist",
};

// The index gives one finding three pixels of colour and nothing else, so in
// that column colour may only ever mean severity. Reusing the pill palette
// would tint the rail with the pill's border and background too.
const findingSeverityRail: Record<string, string> = {
  critical: "bg-red-500 dark:bg-red-400",
  high: "bg-amber-500 dark:bg-amber-400",
  medium: "bg-cyan/70",
  low: "bg-line-strong",
};

// Short enough that four counted chips fit one 360px row without wrapping.
const findingSeverityChipLabel: Record<string, string> = {
  critical: "Crit",
  high: "High",
  medium: "Med",
  low: "Low",
};

// The card shell reads its own severity, so the tint stays legible under the
// body text instead of competing with it the way the header pill does.
const findingSeverityShell: Record<string, string> = {
  critical: "border-red-500/25 bg-red-500/[.05]",
  high: "border-amber-400/25 bg-amber-400/[.05]",
  medium: "border-cyan/20 bg-cyan/[.035]",
  low: "border-line bg-surface",
};

const deepReviewTerminalCopy: Record<
  string,
  { label: string; detail: string }
> = {
  complete: { label: "Complete", detail: "Every selected file was reviewed." },
  partial: {
    label: "Partial",
    detail: "Some selected files were never reviewed.",
  },
  failed: { label: "Failed", detail: "No selected file was reviewed." },
  skipped: {
    label: "Skipped",
    detail: "Nothing in this revision was eligible for review.",
  },
};

const reviewFailureClassCopy: Record<string, string> = {
  provider: "The model provider failed or refused the request.",
  timeout: "A file reviewer ran out of time.",
  budget: "The run reached its token or cost ceiling.",
  cancelled: "The run was cancelled.",
  tool_limit: "A file reviewer exhausted its tool turns.",
  unknown: "The cause was not classified.",
};

const deepReviewItemStateCopy: Record<string, string> = {
  selected: "Pending",
  completed: "Reviewed",
  reused: "Reused",
  waived: "Waived",
  failed: "Failed",
};

/** Counts findings per facet value so a filter can hide empty options. */
export function deepReviewFacetCounts<Key extends string>(
  findings: readonly { severity: string; category: string }[],
  facet: "severity" | "category",
  values: readonly Key[],
) {
  return values.map((value) => ({
    value,
    count: findings.filter((finding) => finding[facet] === value).length,
  }));
}

/** Ranks one severity so the most blocking value sorts first. */
function findingSeverityRank(severity: string) {
  const rank = findingSeverities.indexOf(
    severity as (typeof findingSeverities)[number],
  );
  return rank < 0 ? findingSeverities.length : rank;
}

export interface DeepReviewFindingGroup<T> {
  path: string | null;
  label: string;
  kind: "file" | "survey" | "unmatched";
  findings: T[];
}

/**
 * Groups findings by the file they accuse, in the order a triage pass wants.
 *
 * The index shows no path on a row, so the group header is the only place a
 * reader learns which file a claim is about; a finding whose path this
 * revision no longer contains therefore needs its own group rather than a
 * silent home under some unrelated header.
 */
export function groupDeepReviewFindings<
  T extends {
    path: string | null;
    severity: string;
    startLine: number | null;
    orderIndex: number | null;
  },
>(
  findings: readonly T[],
  units: readonly { path: string }[],
): DeepReviewFindingGroup<T>[] {
  const unitPaths = new Set(units.map(({ path }) => path));
  const fileGroups = new Map<string, T[]>();
  const unmatched: T[] = [];
  const survey: T[] = [];
  for (const finding of findings) {
    if (finding.path === null) {
      survey.push(finding);
    } else if (unitPaths.has(finding.path)) {
      const group = fileGroups.get(finding.path) ?? [];
      group.push(finding);
      fileGroups.set(finding.path, group);
    } else {
      unmatched.push(finding);
    }
  }

  /** Orders one group's findings the way the file itself reads. */
  function inReadingOrder(group: T[]) {
    return [...group].sort(
      (left, right) =>
        (left.startLine ?? Number.MAX_SAFE_INTEGER) -
          (right.startLine ?? Number.MAX_SAFE_INTEGER) ||
        (left.orderIndex ?? Number.MAX_SAFE_INTEGER) -
          (right.orderIndex ?? Number.MAX_SAFE_INTEGER),
    );
  }

  const groups = [...fileGroups.entries()]
    .map(([path, group]): DeepReviewFindingGroup<T> => {
      return {
        path,
        label: path,
        kind: "file",
        findings: inReadingOrder(group),
      };
    })
    .sort(
      (left, right) =>
        Math.min(
          ...left.findings.map(({ severity }) => findingSeverityRank(severity)),
        ) -
          Math.min(
            ...right.findings.map(({ severity }) =>
              findingSeverityRank(severity),
            ),
          ) || left.label.localeCompare(right.label),
    );
  // Both trailing groups are dead ends for navigation, so they sit below every
  // file group however severe their findings claim to be.
  if (unmatched.length > 0) {
    groups.push({
      path: null,
      label: "No line matched",
      kind: "unmatched",
      findings: inReadingOrder(unmatched),
    });
  }
  if (survey.length > 0) {
    groups.push({
      path: null,
      label: "Across this pull request",
      kind: "survey",
      findings: inReadingOrder(survey),
    });
  }
  return groups;
}

/** Renders the one status marker an index row or chip is allowed to carry. */
function DeepReviewFindingMarker({
  finding,
  published,
}: {
  finding: Pick<DeepReviewFinding, "publishable" | "state" | "verdict">;
  published: boolean;
}) {
  // Priority, not accumulation: three glyphs in a 14px column would be
  // unreadable, and a published finding's later verdict changes nothing the
  // reviewer can still act on.
  if (published) {
    return (
      <Check className="text-lime size-3" role="img" aria-label="Published" />
    );
  }
  if (finding.verdict === "not_refuted") {
    return (
      <ShieldCheck
        className="text-lime size-3"
        role="img"
        aria-label="Verified"
      />
    );
  }
  if (!finding.publishable) {
    return (
      <Ban
        className="text-fog size-3"
        role="img"
        aria-label={
          unpublishableFindingReason[finding.state] ??
          "Not anchored to a reviewable line"
        }
      />
    );
  }
  return null;
}

/** Renders one finding as a single 24px row of the findings index. */
export function DeepReviewFindingRow({
  active,
  finding,
  inActiveUnit,
  onOpen,
  published,
  tabIndex,
}: {
  active: boolean;
  finding: DeepReviewFinding;
  inActiveUnit: boolean;
  onOpen: () => void;
  published: boolean;
  tabIndex: number;
}) {
  const withheld = published || !finding.publishable;
  return (
    <button
      type="button"
      id={`finding-row-${finding.id}`}
      data-finding-row={finding.id}
      aria-current={active || undefined}
      tabIndex={tabIndex}
      onClick={onOpen}
      className={cn(
        "focus-visible:outline-cyan grid h-6 w-full grid-cols-[3px_minmax(0,1fr)_14px] items-center gap-2 rounded-md pr-1.5 text-left transition hover:bg-surface-subtle focus-visible:outline-2 focus-visible:outline-offset-[-2px]",
        active && "bg-violet/[.07] shadow-[inset_2px_0_0_var(--app-ai)]",
      )}
    >
      <span
        className={cn(
          "h-3.5 w-[3px] rounded-full",
          findingSeverityRail[finding.severity] ?? findingSeverityRail.low,
        )}
      />
      <span
        title={finding.contentAvailable ? finding.title : undefined}
        className={cn(
          "truncate text-[11px] leading-4",
          withheld
            ? "text-mist"
            : inActiveUnit
              ? "text-cloud"
              : "text-cloud/85",
          !finding.contentAvailable && "text-mist italic",
        )}
      >
        {finding.contentAvailable ? finding.title : "Could not be decrypted"}
      </span>
      <span className="flex justify-end">
        <DeepReviewFindingMarker finding={finding} published={published} />
      </span>
    </button>
  );
}

/** Renders a collapsed pill for a finding that accuses this source line. */
function DeepReviewFindingChip({
  finding,
  onOpen,
  published,
}: {
  finding: DeepReviewFinding;
  onOpen: () => void;
  published: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "mx-4 my-1 ml-[82px] flex items-center gap-2 rounded-lg border px-2.5 py-1.5 font-sans text-[9px] transition hover:brightness-110",
        findingSeverityStyle[finding.severity] ??
          findingSeverityStyle.low ??
          "",
      )}
    >
      <span
        className={cn(
          "size-[5px] shrink-0 rounded-full",
          findingSeverityRail[finding.severity] ?? findingSeverityRail.low,
        )}
      />
      <span className="min-w-0 truncate">
        {finding.contentAvailable ? finding.title : "Could not be decrypted"}
      </span>
      <span className="ml-auto flex shrink-0">
        <DeepReviewFindingMarker finding={finding} published={published} />
      </span>
    </button>
  );
}

/**
 * Renders one open finding beside the code it accuses.
 *
 * The body sits in the code column rather than the sidebar because opening a
 * finding navigates, and navigating closes the sidebar below `xl`; a detail
 * view there would be destroyed by the act of reaching it.
 */
export function DeepReviewInlineFinding({
  finding,
  locationIndex,
  onCollapse,
  onEdit,
  onOpenLocation,
  onPublish,
  onShowInCode,
  providerName,
  published,
  publishing,
  variant,
}: {
  finding: DeepReviewFinding;
  locationIndex: number;
  onCollapse: () => void;
  onEdit?: () => void;
  onOpenLocation: (index: number) => void;
  onPublish?: () => void;
  onShowInCode?: () => void;
  providerName: string;
  published: boolean;
  publishing: boolean;
  variant: "line" | "detached";
}) {
  // The read path already decides publishability against the same predicate
  // the publish mutation enforces; restating it here would let the button and
  // the server disagree.
  const blocked = finding.publishable
    ? undefined
    : (unpublishableFindingReason[finding.state] ??
      "Not anchored to a reviewable line");
  const lines =
    finding.startLine === null
      ? ""
      : finding.endLine === null || finding.endLine === finding.startLine
        ? `Line ${finding.startLine}`
        : `Lines ${finding.startLine}–${finding.endLine}`;
  const where =
    variant === "line"
      ? lines
      : finding.path
        ? `${finding.path}${finding.startLine ? `:${finding.startLine}` : ""}`
        : "Across this pull request";
  const canPublish =
    Boolean(onPublish) &&
    finding.publishable &&
    finding.contentAvailable &&
    !published;
  return (
    <article
      id={`finding-${finding.id}`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCollapse();
        } else if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey) &&
          canPublish &&
          !publishing
        ) {
          event.preventDefault();
          onPublish?.();
        }
      }}
      className={cn(
        "relative mx-4 my-2 overflow-hidden rounded-xl border p-3 font-sans shadow-[0_10px_30px_var(--app-shadow)]",
        variant === "line" ? "ml-[82px]" : "border-dashed",
        findingSeverityShell[finding.severity] ?? findingSeverityShell.low,
        // A withheld finding stays fully legible, but its shell must not read
        // as advice the reviewer is expected to put on the pull request.
        blocked && "border-line bg-surface/60 border-dashed",
      )}
    >
      <span
        className={cn(
          "absolute inset-y-0 left-0 w-0.5",
          findingSeverityRail[finding.severity] ?? findingSeverityRail.low,
        )}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[9px] font-semibold tracking-wider uppercase",
            findingSeverityStyle[finding.severity] ??
              findingSeverityStyle.low ??
              "",
          )}
        >
          {finding.severity}
        </span>
        <span className="text-fog border-line bg-surface-subtle inline-flex items-center rounded-md border px-1.5 py-0.5 text-[9px] tracking-wider uppercase">
          {finding.category}
        </span>
        {finding.verdict === "not_refuted" && (
          <span className="text-lime inline-flex items-center gap-1 text-[9px]">
            <ShieldCheck className="size-3" aria-hidden="true" />
            Verified
          </span>
        )}
        {/* Announced, because opening a finding moved the code pane out from
            under a reader who cannot see that it did. */}
        <span
          aria-live="polite"
          className="text-fog ml-auto min-w-0 truncate font-mono text-[9px]"
        >
          {where}
        </span>
      </div>
      {finding.contentAvailable ? (
        <>
          <p className="text-cloud mt-1 text-sm font-medium">{finding.title}</p>
          <p className="text-mist mt-1.5 text-xs leading-5">{finding.body}</p>
        </>
      ) : (
        <p className="text-mist mt-1 text-sm font-medium italic">
          This finding could not be decrypted
        </p>
      )}
      {finding.existingCode && (
        <>
          {/* Fetched by the read path and shown nowhere until now. Sitting the
              quote a few hundred pixels from the real lines is the strongest
              check a reader has on a claim the agent never grounded. */}
          <p className="text-fog mt-2 text-[9px] tracking-[.12em] uppercase">
            Agent quoted
          </p>
          <pre className="bg-code text-mist mt-1 max-h-40 overflow-auto rounded-lg border border-line border-l-2 border-l-red-400/45 p-2 font-mono text-[10px] leading-4">
            {finding.existingCode}
          </pre>
        </>
      )}
      {finding.suggestionCode && (
        <>
          <p className="text-fog mt-2 text-[9px] tracking-[.12em] uppercase">
            Suggested
          </p>
          <pre className="bg-code text-mist mt-1 max-h-40 overflow-auto rounded-lg border border-line border-l-2 border-l-lime/45 p-2 font-mono text-[10px] leading-4">
            {finding.suggestionCode}
          </pre>
        </>
      )}
      {finding.locations.length > 1 && (
        <div className="text-fog mt-2 grid gap-0.5 font-mono text-[9px]">
          {finding.locations.map((location, index) => (
            <button
              key={`${location.path}-${location.startLine ?? 0}`}
              type="button"
              onClick={() => onOpenLocation(index)}
              className={cn(
                "h-6 w-full truncate rounded px-1.5 text-left hover:bg-surface-subtle",
                index === locationIndex && "text-cloud bg-violet/[.06]",
              )}
            >
              {location.path}
              {location.startLine ? `:${location.startLine}` : ""}
            </button>
          ))}
        </div>
      )}
      {blocked && (
        <p className="text-fog border-line mt-2.5 rounded-lg border border-dashed px-2 py-1.5 text-[10px] leading-4">
          Not publishable · {blocked}
          {finding.verdictReason ? ` — ${finding.verdictReason}` : ""}
        </p>
      )}
      {!finding.contentAvailable && (
        <p className="text-fog mt-2 text-[10px] leading-4">
          The body could not be decrypted.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {published ? (
          <Badge className="border-lime/20 bg-lime/8 text-lime px-2 py-0.5 text-[10px]">
            Published
          </Badge>
        ) : (
          canPublish && (
            <>
              <Button
                size="sm"
                variant="secondary"
                className="h-7 px-2 text-[10px]"
                disabled={publishing}
                onClick={onPublish}
              >
                {publishing ? (
                  <LoaderCircle className="size-3 animate-spin" />
                ) : (
                  <Send className="size-3" />
                )}
                {publishing ? "Posting…" : `Post to ${providerName}`}
              </Button>
              <ShortcutHint shortcut={reviewShortcuts.postComment} />
            </>
          )
        )}
        {/* Offered even when the finding itself cannot be published: the
            server only requires the line to sit inside the unit, so a
            reviewer who agrees with an out-of-scope claim can still say so. */}
        {onEdit && finding.contentAvailable && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[10px]"
            onClick={onEdit}
          >
            <MessageSquareText className="size-3" />
            Edit first
          </Button>
        )}
        {onShowInCode && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[10px]"
            onClick={onShowInCode}
          >
            <FileCode2 className="size-3" />
            Show me the file
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 px-2 text-[10px]"
          onClick={onCollapse}
        >
          Collapse
          <ShortcutHint shortcut={[{ key: "Escape" }]} />
        </Button>
      </div>
    </article>
  );
}

/** Derives live concept progress from the canonical atomic-unit ledger. */
function liveConceptStatus(
  concept: ReviewConcept,
  unitsById: Map<string, ReviewUnit>,
) {
  const members = concept.memberIds
    .map((id) => unitsById.get(id))
    .filter((unit): unit is ReviewUnit => Boolean(unit));
  const signed = members.filter(({ status }) => status === "signed_off").length;
  return {
    members,
    signed,
    status: conceptStatusFromMembers(members, concept.memberIds.length),
  };
}

/** Clamps a requested line to the closest line in a disjoint review scope. */
function closestReviewLine(
  line: number,
  ranges: Array<{ startLine: number; endLine: number }> | undefined,
  fallbackStart: number,
  fallbackEnd: number,
) {
  const candidates = ranges ?? [
    { startLine: fallbackStart, endLine: fallbackEnd },
  ];
  return candidates.reduce((closest, range) => {
    const candidate = Math.min(range.endLine, Math.max(range.startLine, line));
    return Math.abs(candidate - line) < Math.abs(closest - line)
      ? candidate
      : closest;
  }, candidates[0]?.startLine ?? fallbackStart);
}

interface SignOffRollback {
  contextAfter: number;
  contextBefore: number;
  pathSearch: string;
  scrollTop: number;
  searchLimit: number;
  showDiff: boolean;
  unit: ReviewUnit;
  unitIndex: number;
}

interface QueuedSignOff {
  input: SignOffInput;
  rollback: SignOffRollback;
}

interface LiveAiQuestion {
  error: string | null;
  focusLine: number;
  id: string;
  jobId?: string;
  progress?: string;
  question: string;
  result: {
    summary: string;
    commentProposals?: Array<{
      body: string;
      line: number;
      path: string;
    }>;
  } | null;
  status: "queued" | "running" | "streaming" | "completed" | "failed";
  threadId: string;
}

import { reviewSessionMachine } from "./review-session-machine";
import {
  AskAiLineButton,
  aiConversationVisibility,
  CONTEXT_PAGE_LINES,
  ConceptMoveDialog,
  conceptMembersInReadingOrder,
  ExplanationLoader,
  INITIAL_PATH_ITEMS,
  InlineAiQuestion,
  knownLanguage,
  lineWithinReviewRanges,
  nextAnchorableLine,
  PATH_PAGE_SIZE,
  PROVIDER_CONVERSATION_REFRESH_MS,
  ProviderConversation,
  type ProviderConversationActions,
  PullRequestDetailsDialog,
  providerLabel,
  ReviewCodeViewSwitch,
  ReviewConceptMemberHeader,
  ReviewConceptMemberPreview,
  ReviewHierarchyDialog,
  ReviewPathUnit,
  ReviewRevisionLoadedNotice,
  ReviewScopeMarker,
  ReviewUnitViewOptions,
  relatedReviewRanges,
  rememberAiConversationVisibility,
  reviewShortcuts,
  SideBySideUnitDiff,
  type SideBySideUnitDiffHandle,
  SplitActionButton,
  showAiStartError,
  supportedLanguage,
  UnitImportContext,
} from "./review-workspace-support";
import {
  SymbolPeekCard,
  SymbolPeekMessage,
  symbolPeekNotice,
  useSymbolPeek,
} from "./symbol-peek";
/** Renders the review workspace interface. */
export function ReviewWorkspace({
  initialData,
}: {
  initialData: WorkspaceData;
}) {
  const router = useRouter();
  const { navigate, pending: navigationPending } = usePendingNavigation();
  const [loadingChanges, startLoadingChanges] = useTransition();
  const [reviewSession, sendReviewSession] = useMachine(reviewSessionMachine);
  useLayoutEffect(() => lockDocumentScroll(document), []);
  const [units, setUnits] = useState(initialData.units);
  const [fileContexts, setFileContexts] = useState(initialData.fileContexts);
  // The workspace opens on work the reviewer can act on. A wait is a
  // property of one unit, so a sibling that is still pending remains a
  // valid first landing even when another member is paused.
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(
      0,
      units.findIndex(
        (unit) => unit.status !== "signed_off" && unit.status !== "waiting",
      ),
    ),
  );
  const [hydratedUnitIds, setHydratedUnitIds] = useState(
    () =>
      new Set(
        initialData.sourceDelivery === "direct"
          ? []
          : initialData.units.map(({ id }) => id),
      ),
  );
  const [sourceHydrationPending, setSourceHydrationPending] = useState(
    initialData.sourceDelivery === "direct" && Boolean(initialData.snapshot),
  );
  const [settledUnitIds, setSettledUnitIds] = useState(
    () =>
      new Set(
        initialData.sourceDelivery === "direct"
          ? []
          : initialData.units.map(({ id }) => id),
      ),
  );
  const sourceSnapshotId = initialData.snapshot?.id;
  // A snapshot is immutable. Keep its first source manifest stable so a
  // same-snapshot router refresh can update server state without aborting and
  // restarting every verified private-object download.
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot identity owns its immutable source manifest
  const sourceHydrationInput = useMemo(
    () => ({
      activeIndex,
      concepts: initialData.concepts,
      fileContexts: initialData.fileContexts,
      units: initialData.units,
    }),
    [sourceSnapshotId],
  );
  useEffect(() => {
    if (initialData.sourceDelivery !== "direct" || !sourceSnapshotId) return;
    const sourceUnits = sourceHydrationInput.units;
    const sourceFileContexts = sourceHydrationInput.fileContexts;
    const visibleUnit =
      sourceUnits[sourceHydrationInput.activeIndex] ?? sourceUnits[0];
    const visibleConcept = visibleUnit
      ? sourceHydrationInput.concepts.find(({ memberIds }) =>
          memberIds.includes(visibleUnit.id),
        )
      : undefined;
    const relatedIds = new Set(visibleConcept?.memberIds ?? []);
    const relatedPaths = new Set(
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
      sourceFileContexts,
      {
        activePath: visibleUnit?.path,
        relatedPaths,
      },
    );
    let active = true;
    const controller = new AbortController();
    setSourceHydrationPending(true);
    setHydratedUnitIds(new Set());
    setSettledUnitIds(new Set());
    const cache = new Map<string, Promise<Uint8Array>>();
    void Promise.all([
      hydratePrivateReviewSources(
        prioritizedUnits,
        sourceSnapshotId,
        cache,
        6,
        controller.signal,
        (index, hydrated) => {
          if (!active) return;
          const original = prioritizedUnits[index];
          if (!original) return;
          setUnits((current) =>
            current.map((unit) =>
              unit.id === original.id
                ? {
                    ...hydrated,
                    status: unit.status,
                    changedSinceSignOff: unit.changedSinceSignOff,
                    waitingSince: unit.waitingSince,
                  }
                : unit,
            ),
          );
          if (
            original.kind === "binary" ||
            original.currentBlobId ||
            original.previousBlobId
          ) {
            setHydratedUnitIds((current) => new Set(current).add(original.id));
          }
          setSettledUnitIds((current) => new Set(current).add(original.id));
        },
        (index) => {
          if (!active) return;
          const original = prioritizedUnits[index];
          if (original) {
            setSettledUnitIds((current) => new Set(current).add(original.id));
          }
        },
      ),
      hydratePrivateReviewSources(
        prioritizedContexts,
        sourceSnapshotId,
        cache,
        2,
        controller.signal,
        (index, hydrated) => {
          if (!active) return;
          const original = prioritizedContexts[index];
          if (!original) return;
          setFileContexts((current) =>
            current.map((context) =>
              context.path === original.path ? hydrated : context,
            ),
          );
        },
      ),
    ]).then(([hydratedUnits, hydratedContexts]) => {
      if (!active) return;
      setSourceHydrationPending(false);
      setHydratedUnitIds(
        new Set(
          hydratedUnits.successfulIndexes.flatMap((index) => {
            const unit = prioritizedUnits[index];
            return unit &&
              (unit.kind === "binary" ||
                unit.currentBlobId ||
                unit.previousBlobId)
              ? [unit.id]
              : [];
          }),
        ),
      );
      const failures = [
        ...hydratedUnits.failures,
        ...hydratedContexts.failures,
      ];
      if (failures.length > 0) {
        const affectedFiles = new Set(failures.map(({ path }) => path)).size;
        toast.error(
          `${affectedFiles} private source ${affectedFiles === 1 ? "file" : "files"} could not be loaded`,
          { description: "The rest of the review remains available." },
        );
      }
    });
    return () => {
      active = false;
      controller.abort();
      cache.clear();
    };
  }, [initialData.sourceDelivery, sourceHydrationInput, sourceSnapshotId]);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [showDiff, setShowDiff] = useState(true);
  const [importContextUnitIds, setImportContextUnitIds] = useState(
    () => new Set<string>(),
  );
  const [fullFileUnitIds, setFullFileUnitIds] = useState(
    () => new Set<string>(),
  );
  const [pathSearch, setPathSearch] = useState("");
  const [queueLimit, setQueueLimit] = useState(INITIAL_PATH_ITEMS);
  const [searchLimit, setSearchLimit] = useState(INITIAL_PATH_ITEMS);
  const [reviewedLimit, setReviewedLimit] = useState(INITIAL_PATH_ITEMS);
  const [reviewedExpanded, setReviewedExpanded] = useState(false);
  const [waitingLimit, setWaitingLimit] = useState(INITIAL_PATH_ITEMS);
  const [waitingExpanded, setWaitingExpanded] = useState(true);
  const [releasingWaitingUnitId, setReleasingWaitingUnitId] =
    useState<string>();
  const [pathPanelOpen, setPathPanelOpen] = useState(false);
  const [pathPanelCollapsed, setPathPanelCollapsed] = useState(false);
  const [insightsPanelOpen, setInsightsPanelOpen] = useState(false);
  const [insightsPanelCollapsed, setInsightsPanelCollapsed] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [selectedLine, setSelectedLine] = useState<number>();
  const [pendingCommentLine, setPendingCommentLine] = useState<{
    line: number;
    unitId: string;
  }>();
  const [keyboardLine, setKeyboardLine] = useState<number>();
  const [contextBefore, setContextBefore] = useState(0);
  const [contextAfter, setContextAfter] = useState(0);
  const [commandCenterMode, setCommandCenterMode] =
    useState<CommandCenterMode>();
  const [hierarchyOpen, setHierarchyOpen] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [aiReviewDialogOpen, setAiReviewDialogOpen] = useState(false);
  const [conceptGroupingDialogOpen, setConceptGroupingDialogOpen] =
    useState(false);
  const [splitConceptDialogOpen, setSplitConceptDialogOpen] = useState(false);
  const [pullRequestDetailsOpen, setPullRequestDetailsOpen] = useState(false);
  const [moveMemberDialogOpen, setMoveMemberDialogOpen] = useState(false);
  // Empty means every severity, so the four chips start as a legend rather
  // than as four filters the reviewer must switch on before seeing anything.
  const [findingSeverityFilter, setFindingSeverityFilter] = useState(
    () => new Set<string>(),
  );
  const [findingCategoryFilter, setFindingCategoryFilter] = useState("all");
  // One id, not a set: "exactly one finding is expanded" is then true by
  // construction, and an id survives a refetch that reorders the run.
  const [activeFindingId, setActiveFindingId] = useState<string>();
  const [activeFindingLocationIndex, setActiveFindingLocationIndex] =
    useState(0);
  // Its own highlight channel. `selectedLine` means "the composer is open
  // here", and reusing it would discard a half-typed comment draft; a stray
  // `keyboardLine` would arm the line picker and suspend the command center.
  const [findingLine, setFindingLine] = useState<number>();
  // State rather than a ref, because the effect that consumes it has to run
  // again once the newly selected unit has actually rendered its lines.
  const [pendingFindingReveal, setPendingFindingReveal] = useState<{
    exhausted: boolean;
    fallbackUsed: boolean;
    findingId: string;
    line: number;
    unitId: string;
  }>();
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [aiQuestionLine, setAiQuestionLine] = useState<number>();
  const [aiQuestionThreadId, setAiQuestionThreadId] = useState<string>();
  const [focusAiQuestionComposer, setFocusAiQuestionComposer] = useState(false);
  const [aiQuestionPreviewLine, setAiQuestionPreviewLine] = useState<number>();
  const [aiQuestionDraft, setAiQuestionDraft] = useState("");
  const [liveAiQuestions, setLiveAiQuestions] = useState<LiveAiQuestion[]>([]);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [activeSyncId, setActiveSyncId] = useState<string>();
  const [revisionNotice, setRevisionNotice] = useState<{
    previous?: ReviewRevision;
  }>();
  const [signOffUndoHistory, setSignOffUndoHistory] = useState<
    SignOffUndoEntry[]
  >([]);
  const [importPreview, setImportPreview] = useState<ImportPreview>();
  const [resolvingImport, setResolvingImport] = useState<string>();
  const [importReturn, setImportReturn] = useState<{
    index: number;
    unitName: string;
    importedName: string;
  }>();
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const pathSearchRef = useRef<HTMLInputElement>(null);
  const codeScrollRef = useRef<HTMLDivElement>(null);
  const findingsListRef = useRef<HTMLDivElement>(null);
  const aiQuestionMoveAnchor = useRef<
    | {
        cardTop: number;
        scrollTop: number;
      }
    | undefined
  >(undefined);
  const aiQuestionStreams = useRef(new Map<string, AbortController>());
  const dismissedAiQuestionUnits = useRef(new Set<string>());
  // Units of a multi-unit undo whose own success is not worth a toast.
  const quietUndoUnitIds = useRef(new Set<string>());
  const undoInFlight = useRef(false);
  const [undoPending, setUndoPending] = useState(false);
  const diffContextRef = useRef<SideBySideUnitDiffHandle>(null);
  const reviewUnitStartRef = useRef<HTMLDivElement>(null);
  const codeOverviewRef = useRef<HTMLDivElement>(null);
  const importPreviewFocusRef = useRef<HTMLDivElement>(null);
  const [sessionId, setSessionId] = useState<string>();
  const [signOffQueue, dispatchSignOffQueue] = useReducer(
    signOffQueueReducer,
    undefined,
    createSignOffQueue,
  );
  const [pendingConceptSignOffIds, setPendingConceptSignOffIds] = useState(
    () => new Set<string>(),
  );
  const queuedSignOffs = useRef<QueuedSignOff[]>([]);
  const signOffDrainRunning = useRef(false);
  const utils = api.useUtils();
  const activeUnit = units[activeIndex];
  const activeUnitId = activeUnit?.id;
  const unitsById = useMemo(
    () => new Map(units.map((unit) => [unit.id, unit])),
    [units],
  );
  const unitIndexById = useMemo(
    () => new Map(units.map((unit, index) => [unit.id, index])),
    [units],
  );
  const conceptByMemberId = useMemo(() => {
    const owners = new Map<string, ReviewConcept>();
    for (const concept of initialData.concepts) {
      for (const memberId of concept.memberIds) {
        if (!owners.has(memberId)) owners.set(memberId, concept);
      }
    }
    return owners;
  }, [initialData.concepts]);
  const activeConcept = activeUnitId
    ? conceptByMemberId.get(activeUnitId)
    : undefined;
  const activeConceptProgress = useMemo(
    () =>
      activeConcept ? liveConceptStatus(activeConcept, unitsById) : undefined,
    [activeConcept, unitsById],
  );
  const conceptLayoutLocked = Boolean(
    initialData.conceptLayout?.locked ||
      units.some(({ status }) => status === "signed_off"),
  );
  const activeConceptMembers = useMemo(
    () => conceptMembersInReadingOrder(activeConceptProgress?.members ?? []),
    [activeConceptProgress],
  );
  const activeConceptMemberIndex = activeUnit
    ? activeConceptMembers.findIndex(({ id }) => id === activeUnit.id)
    : -1;
  const deletedFilePaths = useMemo(
    () =>
      new Set(
        fileContexts
          .filter(({ changeType }) => changeType === "deleted")
          .map(({ path }) => path),
      ),
    [fileContexts],
  );
  const activeFileIsDeleted = activeUnit
    ? deletedFilePaths.has(activeUnit.path)
    : false;
  const activeSourceAvailable = Boolean(
    activeUnit &&
      (initialData.sourceDelivery !== "direct" ||
        hydratedUnitIds.has(activeUnit.id)),
  );
  const activeSourceHydrationPending = Boolean(
    sourceHydrationPending && activeUnit && !settledUnitIds.has(activeUnit.id),
  );
  const settledActiveUnitId = useSettledValue(activeUnitId, 200);
  const previousActiveUnitId = useRef(activeUnitId);
  const activeUnitFoundation = activeUnit
    ? reviewFoundationPriority(activeUnit)
    : undefined;
  useLayoutEffect(() => {
    if (!activeUnit?.id) return;
    const pane = codeScrollRef.current;
    const unitStart = reviewUnitStartRef.current;
    if (!pane) return;
    if (!unitStart) {
      pane.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    const paneTop = pane.getBoundingClientRect().top;
    const unitTop = unitStart.getBoundingClientRect().top;
    pane.scrollTo({
      top: Math.max(0, pane.scrollTop + unitTop - paneTop - 20),
      behavior: "auto",
    });
  }, [activeUnit?.id]);
  useLayoutEffect(() => {
    if (aiQuestionLine === undefined) {
      aiQuestionMoveAnchor.current = undefined;
      return;
    }
    const anchor = aiQuestionMoveAnchor.current;
    if (!anchor) return;
    aiQuestionMoveAnchor.current = undefined;
    const pane = codeScrollRef.current;
    const card = document.getElementById("inline-ai-question");
    if (!pane || !card) return;
    const nextCardTop = card.getBoundingClientRect().top;
    pane.scrollTop = anchor.scrollTop + nextCardTop - anchor.cardTop;
  }, [aiQuestionLine]);
  useEffect(() => {
    const previousUnitId = previousActiveUnitId.current;
    previousActiveUnitId.current = activeUnitId;
    if (!previousUnitId || previousUnitId === activeUnitId) return;
    void Promise.all([
      utils.ai.status.cancel({
        pullRequestId: initialData.pullRequest.id,
        unitId: previousUnitId,
      }),
      utils.review.unitDiscussion.cancel({ unitId: previousUnitId }),
    ]);
  }, [activeUnitId, initialData.pullRequest.id, utils]);
  useEffect(() => {
    if (!pathPanelOpen && !insightsPanelOpen) return;

    /** Closes an overlay panel without interfering with form input. */
    function closeOverlayPanel(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setPathPanelOpen(false);
      setInsightsPanelOpen(false);
    }

    document.addEventListener("keydown", closeOverlayPanel);
    return () => document.removeEventListener("keydown", closeOverlayPanel);
  }, [insightsPanelOpen, pathPanelOpen]);
  useEffect(() => {
    const persistentPath = window.matchMedia("(min-width: 1536px)");
    const persistentInsights = window.matchMedia("(min-width: 1280px)");

    /** Clears overlay-only state when either panel becomes persistent. */
    function settlePersistentPanels() {
      if (persistentPath.matches) setPathPanelOpen(false);
      if (persistentInsights.matches) setInsightsPanelOpen(false);
    }

    persistentPath.addEventListener("change", settlePersistentPanels);
    persistentInsights.addEventListener("change", settlePersistentPanels);
    return () => {
      persistentPath.removeEventListener("change", settlePersistentPanels);
      persistentInsights.removeEventListener("change", settlePersistentPanels);
    };
  }, []);
  // A concept whose members are all absent is dropped, which compacts the
  // list. Entry and lookup are therefore derived from one array, so that the
  // index a reviewer clicks names the concept they are looking at.
  const conceptPathEntries = useMemo(
    () =>
      initialData.concepts.flatMap((concept) => {
        const progress = liveConceptStatus(concept, unitsById);
        const anchor = progress.members[0];
        if (!anchor) return [];
        return [
          {
            concept,
            unit: {
              ...anchor,
              name: concept.title,
              status:
                progress.status === "signed_off" ||
                progress.status === "changed"
                  ? progress.status
                  : progress.members.every(
                        ({ status }) =>
                          status === "signed_off" || status === "waiting",
                      ) &&
                      progress.members.some(
                        ({ status }) => status === "waiting",
                      )
                    ? ("waiting" as const)
                    : ("pending" as const),
              waitingSince:
                progress.members.find(({ waitingSince }) => waitingSince)
                  ?.waitingSince ?? null,
            } satisfies ReviewUnit,
          },
        ];
      }),
    [initialData.concepts, unitsById],
  );
  const conceptPathUnits = useMemo(
    () => conceptPathEntries.map(({ unit }) => unit),
    [conceptPathEntries],
  );
  const activeConceptPathIndex = activeConcept
    ? Math.max(
        0,
        conceptPathEntries.findIndex(
          ({ concept }) => concept.id === activeConcept.id,
        ),
      )
    : 0;
  const pathSections = useMemo(
    () => reviewPathSections(conceptPathUnits, activeConceptPathIndex),
    [activeConceptPathIndex, conceptPathUnits],
  );
  const nextUnitToPreload = pathSearch.trim()
    ? (pathSections.upcoming.find(({ unit }) =>
        reviewPathSearchMatches(unit, pathSearch),
      )?.unit ?? pathSections.upcoming[0]?.unit)
    : pathSections.upcoming[0]?.unit;
  useEffect(() => {
    if (!nextUnitToPreload || nextUnitToPreload.kind === "binary") {
      return;
    }
    /** Prepares the next unit's highlighted source outside the input event. */
    const preload = () => {
      void preloadSyntaxLanguage(nextUnitToPreload.language);
    };
    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(preload, { timeout: 400 });
      return () => window.cancelIdleCallback(idleId);
    }
    const timeoutId = window.setTimeout(preload, 0);
    return () => window.clearTimeout(timeoutId);
  }, [nextUnitToPreload]);
  const reviewHierarchy = useMemo(() => buildReviewHierarchy(units), [units]);
  const searchResults = useMemo(() => {
    if (!pathSearch.trim()) return [];
    return units
      .map((unit, index) => ({ unit, index }))
      .filter(
        ({ unit, index }) =>
          index !== activeIndex && reviewPathSearchMatches(unit, pathSearch),
      );
  }, [activeIndex, pathSearch, units]);
  const progress = units.length
    ? Math.round(
        (units.filter((unit) => unit.status === "signed_off").length /
          units.length) *
          100,
      )
    : 0;
  const signedCount = units.filter(
    (unit) => unit.status === "signed_off",
  ).length;
  const conceptProgress = useMemo(
    () =>
      initialData.concepts.map((concept) => ({
        concept,
        ...liveConceptStatus(concept, unitsById),
      })),
    [initialData.concepts, unitsById],
  );
  const signedConceptCount = conceptProgress.filter(
    ({ status }) => status === "signed_off",
  ).length;
  const conceptChangedLineTotal = units.reduce(
    (total, unit) => total + unit.changedLineCount,
    0,
  );
  const reviewedChangedLines = units.reduce(
    (total, unit) =>
      total + (unit.status === "signed_off" ? unit.changedLineCount : 0),
    0,
  );
  const waitingCount = units.filter((unit) => unit.status === "waiting").length;
  const availability = reviewAvailability(units);
  const hasNextActionableUnit = availability === "active";
  const reviewComplete = availability === "complete";
  const reviewCaughtUp = availability === "caught_up";
  const [completionOpen, setCompletionOpen] = useState(reviewComplete);
  const [waitingCompletionOpen, setWaitingCompletionOpen] =
    useState(reviewCaughtUp);
  const previousReviewComplete = useRef(reviewComplete);
  const previousReviewCaughtUp = useRef(reviewCaughtUp);
  const completedFileCount = useMemo(
    () => new Set(units.map(({ path }) => path)).size,
    [units],
  );
  const reviewQueue = api.review.dashboard.useQuery(undefined, {
    enabled: reviewComplete || reviewCaughtUp,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  const providerReviewState = api.review.providerReviewState.useQuery(
    { pullRequestId: initialData.pullRequest.id },
    {
      enabled: reviewComplete,
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
      staleTime: 0,
    },
  );
  const setProviderReviewDecision =
    api.review.setProviderReviewDecision.useMutation({
      onSuccess: (state) => {
        utils.review.providerReviewState.setData(
          { pullRequestId: initialData.pullRequest.id },
          state,
        );
        void Promise.all([
          utils.review.providerReviewState.invalidate({
            pullRequestId: initialData.pullRequest.id,
          }),
          utils.review.dashboard.invalidate(),
        ]);
        toast.success(
          state.decision === "approved"
            ? "Approval recorded"
            : state.decision === "changes_requested"
              ? state.provider === "azure_devops"
                ? "Rejection recorded"
                : "Changes requested"
              : "Provider decision cleared",
          {
            description: `${providerLabel(state.provider)} is now synchronized with this review.`,
          },
        );
      },
      onError: (error) =>
        toast.error("Provider review decision was not updated", {
          description: error.message,
        }),
    });
  const nextReview = useMemo(
    () => findNextReview(reviewQueue.data, initialData.pullRequest.id),
    [initialData.pullRequest.id, reviewQueue.data],
  );
  useEffect(() => {
    sendReviewSession({
      type: reviewComplete ? "REVIEW_COMPLETED" : "REVIEW_REOPENED",
    });
  }, [reviewComplete, sendReviewSession]);
  useEffect(() => {
    if (reviewComplete && !previousReviewComplete.current) {
      setCompletionOpen(true);
    } else if (!reviewComplete) {
      setCompletionOpen(false);
    }
    previousReviewComplete.current = reviewComplete;
  }, [reviewComplete]);
  useEffect(() => {
    if (reviewCaughtUp && !previousReviewCaughtUp.current) {
      setWaitingCompletionOpen(true);
    } else if (!reviewCaughtUp) {
      setWaitingCompletionOpen(false);
    }
    previousReviewCaughtUp.current = reviewCaughtUp;
  }, [reviewCaughtUp]);
  const revisionReReviewCount = initialData.units.filter(
    ({ changedSinceSignOff }) => changedSinceSignOff,
  ).length;
  const revisionPreservedCount = initialData.units.filter(
    ({ status }) => status === "signed_off",
  ).length;
  const previewHasFileContext = importPreview
    ? fileContexts.some((context) => context.path === importPreview.path)
    : false;
  const previewModuleIndex = importPreview
    ? previewHasFileContext
      ? -1
      : units.findIndex(
          (unit) => unit.path === importPreview.path && unit.kind === "module",
        )
    : -1;
  const activeModule = activeUnit
    ? (fileContexts.find((context) => context.path === activeUnit.path) ??
      units.find(
        (unit) => unit.path === activeUnit.path && unit.kind === "module",
      ))
    : undefined;
  const diffAvailable = Boolean(
    activeSourceAvailable &&
      activeUnit &&
      activeUnit.kind !== "binary" &&
      (activeUnit.previousSource ||
        activeUnit.changeType === "added" ||
        Boolean(activeModule?.previousSource)),
  );
  const sideBySideVisible = showDiff && diffAvailable;
  const importsVisible = activeUnit
    ? importContextUnitIds.has(activeUnit.id)
    : false;
  const fullFileVisible = activeUnit
    ? fullFileUnitIds.has(activeUnit.id)
    : false;
  const previousUnitStartLine =
    activeUnit?.changeType === "deleted"
      ? activeUnit.startLine
      : activeUnit?.previousSource && activeModule
        ? sourceByteOffsetLine(
            activeModule.previousSource ?? undefined,
            activeUnit.previousStartByte,
            sourceStartLine(
              activeModule.previousSource ?? undefined,
              activeUnit.previousSource,
              activeUnit.startLine,
            ),
          )
        : (activeUnit?.startLine ?? 1);
  const previousUnitEndLine = activeUnit?.previousSource
    ? sourceEndLine(activeUnit.previousSource, previousUnitStartLine)
    : previousUnitStartLine;
  const currentRelatedRanges = useMemo(
    () => relatedReviewRanges(activeUnit, "current"),
    [activeUnit],
  );
  const previousRelatedRanges = useMemo(
    () => relatedReviewRanges(activeUnit, "previous"),
    [activeUnit],
  );
  const firstCurrentReviewLine =
    currentRelatedRanges?.at(0)?.startLine ?? activeUnit?.startLine ?? 1;
  const primaryReviewRanges =
    activeUnit?.changeType === "deleted"
      ? previousRelatedRanges
      : currentRelatedRanges;
  const primaryReviewStart =
    primaryReviewRanges?.at(0)?.startLine ??
    (activeUnit?.changeType === "deleted"
      ? previousUnitStartLine
      : firstCurrentReviewLine);
  const primaryReviewEnd =
    primaryReviewRanges?.at(-1)?.endLine ??
    (activeUnit?.changeType === "deleted"
      ? previousUnitEndLine
      : (activeUnit?.endLine ?? 1));
  /** Checks whether a line is reviewable on the unit's provider side. */
  const isPrimaryReviewLine = (line: number) =>
    lineWithinReviewRanges(
      line,
      primaryReviewRanges,
      primaryReviewStart,
      primaryReviewEnd,
    );
  const diffPreviousSource =
    activeModule?.previousSource ?? activeUnit?.previousSource ?? "";
  const diffCurrentSource =
    activeModule?.source ??
    (activeUnit?.changeType === "deleted" ? "" : (activeUnit?.source ?? ""));
  const overviewLineCount = Math.max(
    diffCurrentSource ? diffCurrentSource.split("\n").length : 0,
    diffPreviousSource ? diffPreviousSource.split("\n").length : 0,
  );
  const overviewEnabled =
    Boolean(activeUnit) &&
    activeSourceAvailable &&
    activeUnit?.kind !== "binary" &&
    overviewLineCount >= 24;
  const overviewRows = useMemo(
    () =>
      overviewEnabled
        ? sideBySideDiff(diffPreviousSource, diffCurrentSource)
        : [],
    [diffCurrentSource, diffPreviousSource, overviewEnabled],
  );
  const overviewMarks = useMemo(
    () => overviewMarksFromDiffRows(overviewRows),
    [overviewRows],
  );
  const overviewUnitRange = useMemo(() => {
    if (!activeUnit || overviewRows.length === 0) return undefined;
    return overviewRangeFromDiffRows(
      overviewRows,
      activeUnit.changeType === "deleted"
        ? previousUnitStartLine
        : activeUnit.startLine,
      activeUnit.changeType === "deleted"
        ? previousUnitEndLine
        : activeUnit.endLine,
      {
        currentStartLine: activeModule ? 1 : activeUnit.startLine,
        previousStartLine: activeModule ? 1 : previousUnitStartLine,
      },
    );
  }, [
    activeModule,
    activeUnit,
    overviewRows,
    previousUnitEndLine,
    previousUnitStartLine,
  ]);
  const {
    scrolled: codePaneScrolled,
    seek: seekCodeOverview,
    update: updateCodeOverview,
    viewport: overviewViewport,
  } = useReviewCodeOverview(
    codeScrollRef,
    codeOverviewRef,
    `${activeUnit?.id ?? ""}:${sideBySideVisible}:${overviewLineCount}`,
  );
  const showScrollOverview =
    overviewEnabled &&
    shouldShowReviewScrollOverview(overviewRows, overviewViewport);
  const fullFileLines = useMemo(
    () => activeModule?.source.split("\n") ?? [],
    [activeModule?.source],
  );
  const contextAvailable = Boolean(
    activeUnit && activeModule && fullFileLines.length >= activeUnit.endLine,
  );
  const availableBefore =
    contextAvailable && activeUnit ? Math.max(0, activeUnit.startLine - 1) : 0;
  const availableAfter =
    contextAvailable && activeUnit
      ? Math.max(0, fullFileLines.length - activeUnit.endLine)
      : 0;
  const visibleStartLine = fullFileVisible
    ? 1
    : contextAvailable && activeUnit
      ? activeUnit.startLine - Math.min(contextBefore, availableBefore)
      : (activeUnit?.startLine ?? 1);
  const visibleEndLine = fullFileVisible
    ? fullFileLines.length
    : contextAvailable && activeUnit
      ? activeUnit.endLine + Math.min(contextAfter, availableAfter)
      : (activeUnit?.endLine ?? 1);
  const contextVisible =
    fullFileVisible || contextBefore > 0 || contextAfter > 0;
  const changedCurrentLines = useMemo(() => {
    const changedLines = new Set<number>();
    if (
      !activeUnit ||
      activeUnit.kind === "binary" ||
      activeUnit.changeType === "deleted"
    ) {
      return changedLines;
    }
    if (activeModule?.previousSource) {
      for (const index of currentChangedLineIndexes(
        activeModule.previousSource,
        activeModule.source,
      )) {
        changedLines.add(index + 1);
      }
      return changedLines;
    }
    if (activeUnit.changeType === "added") {
      for (
        let line = activeUnit.startLine;
        line <= activeUnit.endLine;
        line += 1
      ) {
        changedLines.add(line);
      }
      return changedLines;
    }
    if (!activeUnit.previousSource) return changedLines;
    for (const index of currentChangedLineIndexes(
      activeUnit.previousSource,
      activeUnit.source,
    )) {
      changedLines.add(activeUnit.startLine + index);
    }
    return changedLines;
  }, [activeModule, activeUnit]);
  const filteredReviewActive = pathSearch.trim().length > 0;
  const displayedSource = useMemo(() => {
    if (!activeUnit) return "";
    if (!contextAvailable) return activeUnit.source;
    return fullFileLines.slice(visibleStartLine - 1, visibleEndLine).join("\n");
  }, [
    activeUnit,
    contextAvailable,
    fullFileLines,
    visibleEndLine,
    visibleStartLine,
  ]);
  const lines = useHighlightedSource(
    displayedSource,
    activeUnit?.language ?? "text",
  );
  const previousRewriteSource =
    activeUnit?.changeType === "modified" &&
    activeUnit.previousSource &&
    activeUnit.kind !== "binary"
      ? activeUnit.previousSource
      : "";
  const highlightedPreviousRewrite = useHighlightedSource(
    previousRewriteSource,
    activeUnit?.language ?? "text",
  );
  const previousRewriteLines = useMemo(() => {
    if (!activeUnit || !previousRewriteSource) return [];
    for (
      let line = activeUnit.startLine;
      line <= activeUnit.endLine;
      line += 1
    ) {
      if (!changedCurrentLines.has(line)) return [];
    }
    return highlightedPreviousRewrite;
  }, [
    activeUnit,
    changedCurrentLines,
    highlightedPreviousRewrite,
    previousRewriteSource,
  ]);
  const {
    close: closeSymbolPeek,
    holdOpen: holdSymbolPeek,
    peeked: peekedSymbol,
    peekHandlers,
  } = useSymbolPeek(activeSourceAvailable);
  const importReferences = useImportReferences(
    displayedSource,
    activeUnit?.language ?? "text",
  );
  const fileImportReferences = useImportReferences(
    activeModule?.source ?? "",
    activeUnit?.language ?? "text",
  );
  // The name may be bound by an import statement the diff does not show, so
  // the whole file's imports are what say where to look for its declaration.
  const peekedImport = peekedSymbol
    ? fileImportReferences.find(({ local }) => local === peekedSymbol.symbol)
    : undefined;
  // A stored language the grammars no longer cover must not take the render
  // down: the lookup simply has nothing to resolve against and stays off.
  // Plain text is covered by name but has no parser behind it, so it has no
  // declarations to find either.
  const peekedLanguage = knownLanguage(activeUnit?.language ?? "text");
  const peekable = peekedLanguage !== undefined && peekedLanguage !== "text";
  const peekedDefinition = api.review.symbolDefinition.useQuery(
    {
      pullRequestId: initialData.pullRequest.id,
      sourcePath: activeUnit?.path ?? "",
      sourceLanguage: peekedLanguage ?? "text",
      symbol: peekedSymbol?.symbol ?? "",
      line: peekedSymbol?.line,
      ...(peekedImport
        ? {
            specifier: peekedImport.specifier,
            imported: peekedImport.imported,
            kind: peekedImport.kind,
          }
        : {}),
    },
    {
      enabled: Boolean(peekedSymbol && activeUnit && peekable),
      staleTime: 5 * 60_000,
      retry: false,
    },
  );
  const importPreviewLines = useHighlightedSource(
    importPreview?.source ?? "",
    importPreview?.language ?? "text",
  );
  /** Opens the provider comment composer for one reviewable diff line. */
  const openInlineComment = useCallback((line: number) => {
    setKeyboardLine(undefined);
    setSelectedLine(line);
    setFeedback("");
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() =>
        document
          .getElementById(`review-line-${line}`)
          ?.scrollIntoView({ block: "center" }),
      ),
    );
  }, []);
  /** Opens one atomic review unit and selects its concept card. */
  const selectUnit = useCallback(
    (index: number) => {
      const target = units[index];
      if (!target) return;
      setActiveIndex(index);
      setShowDiff(true);
      setStartedAt(Date.now());
      setQueueLimit(INITIAL_PATH_ITEMS);
      setKeyboardLine(undefined);
      // `openFinding` sets the finding line after calling this, and the later
      // set wins in the same batch; a unit reached by ⌘↓, the path panel or a
      // concept card instead arrives with no stale amber line lit.
      setFindingLine(undefined);
      setContextBefore(0);
      setContextAfter(0);
      setImportReturn(undefined);
      setImportPreview(undefined);
      setPathPanelOpen(false);
      setInsightsPanelOpen(false);
    },
    [units],
  );
  /**
   * Opens the composer on a line a reviewer picked in another member's card.
   *
   * The composer, the published threads and the publish call all read the open
   * unit, so the card the line came from has to open first. Opening it clears
   * the composer, which is why the line is held here until that unit is the
   * one on screen rather than passed straight to the composer.
   */
  const commentOnMemberLine = useCallback(
    (unitId: string, line: number) => {
      const index = unitIndexById.get(unitId) ?? -1;
      if (index < 0) return;
      setPendingCommentLine({ unitId, line });
      selectUnit(index);
    },
    [selectUnit, unitIndexById],
  );
  // Concept members are re-rendered only when their own inputs move, so
  // unrelated workspace state never re-reconciles hundreds of source lines.
  const conceptMemberPreviews = useMemo(
    () =>
      activeConceptMembers.map((member, memberIndex) => (
        <ReviewConceptMemberPreview
          key={member.id}
          unit={member}
          index={memberIndex}
          count={activeConceptMembers.length}
          sourceAvailable={
            initialData.sourceDelivery !== "direct" ||
            member.kind === "binary" ||
            hydratedUnitIds.has(member.id)
          }
          sourcePending={
            initialData.sourceDelivery === "direct" &&
            member.kind !== "binary" &&
            sourceHydrationPending &&
            !settledUnitIds.has(member.id)
          }
          onSelect={() => selectUnit(unitIndexById.get(member.id) ?? -1)}
          onCommentLine={(line) => commentOnMemberLine(member.id, line)}
        />
      )),
    [
      activeConceptMembers,
      commentOnMemberLine,
      hydratedUnitIds,
      initialData.sourceDelivery,
      selectUnit,
      settledUnitIds,
      sourceHydrationPending,
      unitIndexById,
    ],
  );

  /** Opens the anchor unit for one concept-first path entry. */
  function selectConceptPath(index: number) {
    // The entry is anchored on the concept's first member that this snapshot
    // still holds. Its own first member id may name one the snapshot dropped,
    // and reading that instead opens nothing.
    const anchorId = conceptPathEntries[index]?.unit.id;
    const unitIndex = anchorId ? (unitIndexById.get(anchorId) ?? -1) : -1;
    if (unitIndex >= 0) selectUnit(unitIndex);
  }

  /** Selects an adjacent atomic member inside the current review concept. */
  function navigateConceptMember(direction: -1 | 1) {
    const member = activeConceptMembers[activeConceptMemberIndex + direction];
    if (!member) return;
    const index = unitIndexById.get(member.id) ?? -1;
    if (index >= 0) selectUnit(index);
  }

  /** Opens the adjacent concept while preserving concept-first navigation. */
  function navigateConcept(direction: -1 | 1) {
    const index = activeConceptPathIndex + direction;
    if (index >= 0 && index < initialData.concepts.length) {
      selectConceptPath(index);
    }
  }

  /** Shows or hides source context surrounding the active review unit. */
  function toggleContext() {
    if (!contextAvailable) return;
    if (contextVisible) {
      setContextBefore(0);
      setContextAfter(0);
      codeScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    setContextBefore(Math.min(CONTEXT_PAGE_LINES, availableBefore));
    setContextAfter(Math.min(CONTEXT_PAGE_LINES, availableAfter));
  }
  /** Navigates an import to its review unit or opens its source context. */
  async function followImport(reference: ImportReference) {
    if (!activeUnit) return;
    const resolutionKey = `${activeUnit.id}:${reference.from}:${reference.to}`;
    const localTarget = findImportTargetUnit(
      activeUnit.path,
      activeUnit.language,
      reference,
      units,
    );
    if (localTarget) {
      const pathUnits = units
        .map((unit, index) => ({ unit, index }))
        .filter(({ unit }) => unit.path === localTarget.targetPath);
      const target = pathUnits.find(
        ({ unit }) => unit.id === localTarget.exactUnit?.id,
      );
      if (target) {
        if (target.index === activeIndex) return;
        const origin = {
          index: activeIndex,
          unitName: activeUnit.name,
          importedName:
            reference.kind === "named" ? reference.imported : target.unit.name,
        };
        selectUnit(target.index);
        setImportReturn(origin);
        toast.success(`Opened ${target.unit.name}`, {
          description: `Reviewing this import out of order. ${activeUnit.name} remains in your path.`,
        });
        return;
      }
      const moduleUnit = pathUnits.find(
        ({ unit }) => unit.id === localTarget.moduleUnit?.id,
      );
      if (moduleUnit) {
        setImportPreview({
          kind: "preview",
          path: moduleUnit.unit.path,
          language: moduleUnit.unit.language,
          name: reference.imported,
          source: moduleUnit.unit.source,
          startLine: moduleUnit.unit.startLine,
          endLine: moduleUnit.unit.endLine,
          focusLine: findImportedDeclarationLine(
            moduleUnit.unit.source,
            reference.imported,
            moduleUnit.unit.language,
            moduleUnit.unit.startLine,
          ),
          inReviewPath: true,
        });
        return;
      }
    }

    setResolvingImport(resolutionKey);
    try {
      const result = await utils.review.importTarget.fetch({
        pullRequestId: initialData.pullRequest.id,
        sourcePath: activeUnit.path,
        sourceLanguage: supportedLanguage(activeUnit.language),
        specifier: reference.specifier,
        imported: reference.imported,
        kind: reference.kind,
      });
      if (result.kind === "unit") {
        const index = units.findIndex((unit) => unit.id === result.unitId);
        if (index >= 0) {
          const origin = {
            index: activeIndex,
            unitName: activeUnit.name,
            importedName: reference.imported,
          };
          selectUnit(index);
          setImportReturn(origin);
          return;
        }
      }
      if (result.kind === "preview") {
        setImportPreview(result);
        return;
      }
      toast.info(
        result.reason === "too_large"
          ? "This source file is too large for the in-app preview"
          : result.reason === "external"
            ? "This import is provided outside the repository"
            : "This import could not be found at the reviewed revision",
      );
    } catch (cause) {
      toast.error(
        cause instanceof Error
          ? cause.message
          : "The imported source could not be opened",
      );
    } finally {
      setResolvingImport((current) =>
        current === resolutionKey ? undefined : current,
      );
    }
  }
  const { mutate: beginSession } = api.review.beginSession.useMutation({
    onSuccess: (session) => setSessionId(session?.id),
    onError: (error) => toast.error(error.message),
  });
  useEffect(() => {
    beginSession({
      pullRequestId: initialData.pullRequest.id,
    });
    // A review workspace starts one resumable session per snapshot.
  }, [beginSession, initialData.pullRequest.id]);
  useEffect(() => {
    const snapshot = initialData.snapshot;
    if (!snapshot) return;
    const current = {
      headSha: snapshot.headSha,
      snapshotId: snapshot.id,
      version: snapshot.version,
    };
    const acknowledged = acknowledgedReviewRevision(
      window.localStorage,
      initialData.pullRequest.id,
    );
    if (acknowledged?.snapshotId === current.snapshotId) {
      setRevisionNotice(undefined);
      return;
    }
    if (acknowledged) {
      setRevisionNotice({ previous: acknowledged });
      return;
    }
    if (revisionReReviewCount > 0) {
      const previous = initialData.previousSnapshot;
      setRevisionNotice({
        previous: previous
          ? {
              headSha: previous.headSha,
              snapshotId: previous.id,
              version: previous.version,
            }
          : undefined,
      });
      return;
    }
    acknowledgeReviewRevision(
      window.localStorage,
      initialData.pullRequest.id,
      current,
    );
  }, [
    initialData.previousSnapshot,
    initialData.pullRequest.id,
    initialData.snapshot,
    revisionReReviewCount,
  ]);
  const signOff = api.review.signOff.useMutation();
  const signOffBatch = api.review.signOffBatch.useMutation();

  /** Applies several sign-offs immediately while retaining rollback state. */
  function optimisticallyQueueSignOffs(
    inputs: SignOffInput[],
    preferredNextUnit?: (unit: ReviewUnit, index: number) => boolean,
  ) {
    const inputByUnitId = new Map(inputs.map((input) => [input.unitId, input]));
    const alreadyQueued = new Set(
      queuedSignOffs.current.map(({ input }) => input.unitId),
    );
    const scrollTop = codeScrollRef.current?.scrollTop ?? 0;
    const queued = units.flatMap((unit, unitIndex): QueuedSignOff[] => {
      const input = inputByUnitId.get(unit.id);
      if (
        !input ||
        alreadyQueued.has(unit.id) ||
        unit.status === "signed_off" ||
        unit.status === "waiting"
      ) {
        return [];
      }
      return [
        {
          input,
          rollback: {
            unit,
            unitIndex,
            pathSearch,
            searchLimit,
            showDiff,
            contextBefore,
            contextAfter,
            scrollTop,
          },
        },
      ];
    });
    if (queued.length === 0) return;
    const updated = optimisticallySignOffReviewUnits(
      units,
      queued.map(({ input }) => input.unitId),
    );
    const first = queued[0];
    if (first) {
      setSignOffUndoHistory((history) =>
        rememberSignOff(history, {
          kind: "unit",
          label:
            queued.length === 1
              ? first.rollback.unit.name
              : `${queued.length} units`,
          unitIds: queued.map(({ input }) => input.unitId),
          view: reviewViewSnapshot(first.rollback),
        }),
      );
    }
    const nextIndex = nextReviewIndexAfterAction(updated, preferredNextUnit);
    for (const entry of queued) {
      dispatchSignOffQueue({
        type: "enqueue",
        unitId: entry.input.unitId,
      });
    }
    queuedSignOffs.current.push(...queued);
    setUnits(updated);
    if (nextIndex >= 0) {
      setActiveIndex(nextIndex);
    }
    setQueueLimit(INITIAL_PATH_ITEMS);
    setShowDiff(true);
    setContextBefore(0);
    setContextAfter(0);
    codeScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    setStartedAt(Date.now());
    void drainSignOffQueue();
  }

  /** Restores failed optimistic saves and returns focus to the first failure. */
  function restoreFailedSignOffs(
    failures: Array<{
      code?: string;
      message: string;
      queued: QueuedSignOff;
    }>,
  ) {
    const first = failures[0];
    if (!first) return;
    setUnits((current) =>
      failures.reduce(
        (restored, { queued }) =>
          restoreReviewUnitAfterFailedSignOff(restored, queued.rollback.unit),
        current,
      ),
    );
    const rollback = first.queued.rollback;
    setActiveIndex(rollback.unitIndex);
    if (rollback.pathSearch.trim()) {
      setPathSearch((current) =>
        current.trim() ? current : rollback.pathSearch,
      );
      setSearchLimit(rollback.searchLimit);
    }
    setShowDiff(rollback.showDiff);
    setContextBefore(rollback.contextBefore);
    setContextAfter(rollback.contextAfter);
    setStartedAt(Date.now());
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        codeScrollRef.current?.scrollTo({
          top: rollback.scrollTop,
          behavior: "auto",
        });
      }),
    );
    if (
      failures.some(({ code }) => code === "CONFLICT" || code === "NOT_FOUND")
    ) {
      setUpdateAvailable(true);
      toast.warning("Review path changed", {
        id: "review-sign-off-save-error",
        description:
          failures.length === 1
            ? `${rollback.unit.name} could not be signed off because its code changed. Load the latest review path to review it again.`
            : `${failures.length} units could not be signed off because the review path changed. Returned to ${rollback.unit.name}.`,
      });
      return;
    }
    toast.error("Sign-off was not saved", {
      id: "review-sign-off-save-error",
      description:
        first.code === "UNAUTHORIZED"
          ? `Returned to ${rollback.unit.name}. Your session could not be refreshed; reload or sign in again.`
          : failures.length === 1
            ? `Returned to ${rollback.unit.name}. ${first.message}`
            : `${failures.length} saves failed. Returned to ${rollback.unit.name}. ${first.message}`,
    });
  }

  /** Drains one immediate save, then coalesces accumulated work into batches. */
  async function drainSignOffQueue() {
    if (signOffDrainRunning.current) return;
    signOffDrainRunning.current = true;
    try {
      while (queuedSignOffs.current.length > 0) {
        const batchSize = nextSignOffBatchSize(queuedSignOffs.current.length);
        const batch = queuedSignOffs.current.splice(0, batchSize);
        let saved = 0;
        try {
          if (batch.length === 1) {
            const queued = batch[0];
            if (!queued) continue;
            await signOff.mutateAsync(queued.input);
            saved = 1;
          } else {
            const results = await signOffBatch.mutateAsync({
              signOffs: batch.map(({ input }) => input),
            });
            const queuedByUnit = new Map(
              batch.map((queued) => [queued.input.unitId, queued]),
            );
            const failures = results.flatMap((result) => {
              if (result.ok) {
                saved += 1;
                return [];
              }
              const queued = queuedByUnit.get(result.unitId);
              return queued
                ? [
                    {
                      code: result.code,
                      message: result.message,
                      queued,
                    },
                  ]
                : [];
            });
            restoreFailedSignOffs(failures);
          }
          if (saved > 0) {
            void Promise.all([
              utils.workspace.guidance.invalidate(),
              utils.review.dashboard.invalidate(),
              utils.review.gamification.invalidate(),
            ]);
          }
        } catch (error) {
          const failure =
            error instanceof Error
              ? error
              : new Error("The sign-off request failed");
          const code =
            typeof error === "object" &&
            error !== null &&
            "data" in error &&
            typeof error.data === "object" &&
            error.data !== null &&
            "code" in error.data &&
            typeof error.data.code === "string"
              ? error.data.code
              : undefined;
          const remaining =
            code === "UNAUTHORIZED" ? queuedSignOffs.current.splice(0) : [];
          const failed = [...batch, ...remaining];
          restoreFailedSignOffs(
            failed.map((queued) => ({
              code,
              message: failure.message,
              queued,
            })),
          );
          for (const { input } of remaining) {
            dispatchSignOffQueue({ type: "settle", unitId: input.unitId });
          }
        } finally {
          for (const { input } of batch) {
            dispatchSignOffQueue({ type: "settle", unitId: input.unitId });
          }
        }
      }
    } finally {
      signOffDrainRunning.current = false;
    }
  }
  // Keyed by the unit the request named rather than the one on screen: undo
  // reaches back to a sign-off the reviewer has since moved on from.
  const undoSignOff = api.review.unreview.useMutation({
    onSuccess: ({ unreviewed }, { unitId }) => {
      if (!unreviewed) return;
      void Promise.all([
        utils.workspace.guidance.invalidate(),
        utils.review.dashboard.invalidate(),
        utils.review.gamification.invalidate(),
      ]);
      setUnits((current) =>
        current.map((unit) =>
          unit.id === unitId
            ? {
                ...unit,
                status: "pending" as const,
                changedSinceSignOff: false,
              }
            : unit,
        ),
      );
      setStartedAt(Date.now());
      // One undo of a many-unit step is one decision, so only the request
      // that finishes it says so.
      if (quietUndoUnitIds.current.delete(unitId)) return;
      toast.success("Marked as not reviewed", {
        description: `${units.find(({ id }) => id === unitId)?.name ?? "The unit"} is back in your review queue.`,
      });
    },
    onError: (error) => toast.error(error.message),
  });
  const signOffConcept = api.review.signOffConcept.useMutation();
  const undoConcept = api.review.unreviewConcept.useMutation({
    onSuccess: ({ unreviewed, unitIds }) => {
      if (!unreviewed) return;
      const affected = new Set(unitIds);
      setUnits((current) =>
        current.map((unit) =>
          affected.has(unit.id)
            ? {
                ...unit,
                status: "pending" as const,
                changedSinceSignOff: false,
              }
            : unit,
        ),
      );
      void Promise.all([
        utils.workspace.guidance.invalidate(),
        utils.review.dashboard.invalidate(),
        utils.review.gamification.invalidate(),
      ]);
      setStartedAt(Date.now());
      toast.success("Concept returned to the review path");
    },
    onError: (error) => toast.error(error.message),
  });
  // Improve, Split, and Move member all funnel into the same layout mutation,
  // so the pressed control is remembered to keep its spinner on that control.
  const [conceptLayoutAction, setConceptLayoutAction] = useState<
    "improve" | "split" | "move"
  >();
  const replaceConceptLayout =
    api.review.replacePersonalConceptLayout.useMutation({
      onSuccess: () => {
        toast.success("Semantic grouping applied", {
          description:
            "Your personal concept layout is ready. Atomic coverage is unchanged.",
        });
        router.refresh();
      },
      onError: (error) => toast.error(error.message),
      onSettled: () => setConceptLayoutAction(undefined),
    });
  const improveConceptGrouping = api.review.improveConceptGrouping.useMutation({
    onSuccess: ({ concepts }) => {
      if (!initialData.snapshot || !initialData.conceptLayout) {
        setConceptLayoutAction(undefined);
        return;
      }
      replaceConceptLayout.mutate({
        pullRequestId: initialData.pullRequest.id,
        snapshotId: initialData.snapshot.id,
        expectedVersion: initialData.conceptLayout.version,
        source: "ai",
        concepts,
      });
    },
    onError: (error) => {
      setConceptLayoutAction(undefined);
      toast.error(error.message);
    },
  });
  // The regrouping spans two mutations: the model proposes concepts, then the
  // layout is replaced. Both stages read as one action to the reviewer.
  const groupingImproving =
    improveConceptGrouping.isPending ||
    (replaceConceptLayout.isPending && conceptLayoutAction === "improve");
  const improveGroupingLabel = improveConceptGrouping.isPending
    ? "Improving grouping…"
    : replaceConceptLayout.isPending && conceptLayoutAction === "improve"
      ? "Applying grouping…"
      : "Improve grouping with AI";
  const movingMember =
    replaceConceptLayout.isPending && conceptLayoutAction === "move";
  const moveMemberLabel = movingMember
    ? "Moving unit…"
    : "Move this unit to another concept";
  /** Finds the next filtered match, then resumes the global review path. */
  function nextReviewIndexAfterAction(
    nextUnits: ReviewUnit[],
    preferred?: (unit: ReviewUnit, index: number) => boolean,
  ) {
    if (pathSearch.trim()) {
      const filteredIndex = nextPendingReviewIndex(
        nextUnits,
        (unit, index) =>
          reviewPathSearchMatches(unit, pathSearch) &&
          (preferred?.(unit, index) ?? true),
      );
      if (filteredIndex >= 0) return filteredIndex;
      setPathSearch("");
      setSearchLimit(INITIAL_PATH_ITEMS);
    }
    return preferred
      ? nextPendingReviewIndexPreferring(nextUnits, preferred)
      : nextPendingReviewIndex(nextUnits);
  }

  /** Completes the current action within the active filter or global path. */
  function continueReview() {
    const nextIndex = nextReviewIndexAfterAction(units);
    if (nextIndex >= 0) {
      selectUnit(nextIndex);
      codeScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    }
  }
  const aiStatus = api.ai.status.useQuery(
    {
      pullRequestId: initialData.pullRequest.id,
      unitId: settledActiveUnitId,
    },
    {
      enabled: Boolean(settledActiveUnitId),
      refetchInterval: (query) =>
        ["queued", "running"].includes(query.state.data?.status ?? "")
          ? 2_000
          : false,
    },
  );
  const explanationError = aiErrorPresentation(aiStatus.data?.error);
  const aiQuestions = api.ai.questions.useQuery(
    {
      pullRequestId: initialData.pullRequest.id,
      unitId: settledActiveUnitId ?? "",
    },
    {
      enabled: Boolean(settledActiveUnitId),
      refetchInterval: (query) =>
        query.state.data?.some(({ status }) =>
          ["queued", "running"].includes(status),
        )
          ? 2_000
          : false,
    },
  );
  useEffect(() => {
    const terminalJobIds = new Set(
      aiQuestions.data
        ?.filter(({ status }) => ["completed", "failed"].includes(status))
        .map(({ id }) => id) ?? [],
    );
    if (terminalJobIds.size === 0) return;
    setLiveAiQuestions((questions) =>
      questions.filter(({ jobId }) => !jobId || !terminalJobIds.has(jobId)),
    );
  }, [aiQuestions.data]);
  useEffect(() => {
    if (
      !activeUnit ||
      !activeUnitId ||
      activeUnitId !== settledActiveUnitId ||
      aiQuestionLine !== undefined ||
      dismissedAiQuestionUnits.current.has(activeUnitId)
    ) {
      return;
    }
    const latestSavedQuestion = aiQuestions.data?.at(-1);
    const remembered = aiConversationVisibility(
      window.localStorage,
      initialData.pullRequest.id,
      activeUnitId,
    );
    if (remembered === null) return;
    const focusLine = remembered
      ? remembered.line
      : latestSavedQuestion?.focusLine;
    const threadId =
      remembered?.threadId ?? latestSavedQuestion?.conversationId;
    if (
      focusLine === null ||
      focusLine === undefined ||
      (!lineWithinReviewRanges(
        focusLine,
        currentRelatedRanges,
        activeUnit.startLine,
        activeUnit.endLine,
      ) &&
        !lineWithinReviewRanges(
          focusLine,
          previousRelatedRanges,
          previousUnitStartLine,
          previousUnitEndLine,
        ))
    ) {
      return;
    }
    setFocusAiQuestionComposer(false);
    setAiQuestionLine(focusLine);
    setAiQuestionThreadId(threadId);
    rememberAiConversationVisibility(
      window.localStorage,
      initialData.pullRequest.id,
      activeUnitId,
      focusLine,
      threadId,
    );
  }, [
    activeUnit,
    activeUnitId,
    aiQuestionLine,
    aiQuestions.data,
    initialData.pullRequest.id,
    previousUnitEndLine,
    previousUnitStartLine,
    currentRelatedRanges,
    previousRelatedRanges,
    settledActiveUnitId,
  ]);
  useEffect(
    () => () => {
      for (const stream of aiQuestionStreams.current.values()) stream.abort();
      aiQuestionStreams.current.clear();
    },
    [],
  );
  const startExplanation = api.ai.start.useMutation({
    onSuccess: () => {
      toast.success("Explanation started");
      void aiStatus.refetch();
    },
    onError: showAiStartError,
  });
  const startAiQuestion = api.ai.start.useMutation({
    onSuccess: () => void aiUsage.refetch(),
  });
  const deleteAiQuestionThread = api.ai.deleteQuestionThread.useMutation({
    onError: (error) => toast.error(error.message),
  });
  const aiConfiguration = api.ai.configuration.useQuery();
  // Absent, never present-and-erroring: until the query resolves the account is
  // treated as unentitled, so no affordance renders that `ai.start` would then
  // refuse.
  const deepReviewAvailable =
    aiConfiguration.data?.deepReviewAvailable ?? false;
  const pullRequestReview = api.ai.reviewStatus.useQuery(
    { pullRequestId: initialData.pullRequest.id },
    {
      refetchInterval: (query) =>
        aiJobActive(query.state.data?.status) ? 2_000 : false,
    },
  );
  const explanationRunning =
    startExplanation.isPending ||
    ["queued", "running"].includes(aiStatus.data?.status ?? "");
  const aiQuestionRunning =
    startAiQuestion.isPending ||
    liveAiQuestions.some(({ status }) =>
      ["queued", "running", "streaming"].includes(status),
    ) ||
    (aiQuestions.data?.some(({ status }) =>
      ["queued", "running"].includes(status),
    ) ??
      false);
  const explanationAnnotations =
    aiStatus.data?.status === "completed" && aiStatus.data.result
      ? [...(aiStatus.data.result.annotations ?? [])]
          .filter(
            (annotation) =>
              annotation.path === activeUnit?.path &&
              annotation.line >= (activeUnit?.startLine ?? 0) &&
              (annotation.endLine ?? annotation.line) <=
                (activeUnit?.endLine ?? 0),
          )
          .sort(
            (left, right) =>
              left.line - right.line ||
              (left.endLine ?? left.line) - (right.endLine ?? right.line),
          )
      : [];
  const discussion = api.review.unitDiscussion.useQuery(
    { unitId: settledActiveUnitId ?? "" },
    { enabled: Boolean(settledActiveUnitId) },
  );
  const providerConversations = api.review.providerConversations.useQuery(
    { pullRequestId: initialData.pullRequest.id },
    {
      retry: false,
      // Every read of this query is a live provider round trip, so the whole
      // workspace refreshes conversations on one declared cadence instead of
      // the generic client default. `staleTime` bounds the mount and focus
      // triggers; the interval below keeps waiting units on the same cadence
      // and, unlike those triggers, always refetches. Explicit refetches after
      // publishing, replying, synchronizing, or retrying stay immediate.
      staleTime: PROVIDER_CONVERSATION_REFRESH_MS,
      refetchOnWindowFocus: true,
      refetchInterval:
        waitingCount > 0 ? PROVIDER_CONVERSATION_REFRESH_MS : false,
    },
  );
  const manualSyncPending = reviewSession.matches("synchronizing");
  const pollLatestPullRequest = api.review.poll.useMutation({
    onSuccess: (result) => {
      setActiveSyncId(result.syncId);
      void utils.review.activeSyncs.invalidate();
      toast.info("Pull request synchronization queued", {
        description:
          "ReviewDuck will preserve your current review while it runs.",
      });
    },
  });
  const syncStatus = api.review.syncStatus.useQuery(
    { syncId: activeSyncId ?? "00000000-0000-4000-8000-000000000000" },
    {
      enabled: Boolean(activeSyncId),
      refetchInterval: (query) =>
        ["queued", "running"].includes(query.state.data?.status ?? "")
          ? 1_500
          : false,
    },
  );
  useEffect(() => {
    if (!activeSyncId) return;
    const status = syncStatus.data?.status;
    if (status === "completed") {
      setActiveSyncId(undefined);
      const snapshot = initialData.snapshot;
      if (snapshot) {
        acknowledgeReviewRevision(
          window.localStorage,
          initialData.pullRequest.id,
          {
            headSha: snapshot.headSha,
            snapshotId: snapshot.id,
            version: snapshot.version,
          },
        );
      }
      setUpdateAvailable(false);
      void Promise.all([
        utils.review.activeSyncs.invalidate(),
        utils.review.dashboard.invalidate(),
        utils.review.gamification.invalidate(),
        utils.review.providerConversations.invalidate({
          pullRequestId: initialData.pullRequest.id,
        }),
        utils.review.providerReviewState.invalidate({
          pullRequestId: initialData.pullRequest.id,
        }),
      ]);
      sendReviewSession({ type: "SYNC_FINISHED" });
      toast.success("Pull request synchronized", {
        description: "The latest review revision is loaded.",
      });
      router.refresh();
    } else if (status === "failed" || status === "cancelled") {
      setActiveSyncId(undefined);
      void utils.review.activeSyncs.invalidate();
      sendReviewSession({ type: "SYNC_FINISHED" });
      toast.error(
        status === "cancelled"
          ? "Pull request synchronization was cancelled"
          : "Pull request synchronization failed",
        { description: syncStatus.data?.error ?? "Try again in a moment." },
      );
    }
  }, [
    activeSyncId,
    sendReviewSession,
    syncStatus.data,
    utils.review.activeSyncs.invalidate,
    utils.review.dashboard.invalidate,
    utils.review.gamification.invalidate,
    utils.review.providerConversations.invalidate,
    utils.review.providerReviewState.invalidate,
    initialData.pullRequest.id,
    initialData.snapshot,
    router,
  ]);
  const externalSyncPending =
    manualSyncPending ||
    pollLatestPullRequest.isPending ||
    ["queued", "running"].includes(syncStatus.data?.status ?? "");
  const resetReview = api.review.reset.useMutation({
    onSuccess: (result) => {
      setActiveSyncId(result.syncId);
      setResetDialogOpen(false);
      void Promise.all([
        utils.review.activeSyncs.invalidate(),
        utils.review.dashboard.invalidate(),
        utils.review.gamification.invalidate(),
      ]);
      router.refresh();
      toast.info("Review reset; synchronization queued");
    },
    onError: (error) => {
      toast.error("Review could not be reset", {
        description: error.message,
      });
    },
  });

  /** Queues durable source synchronization. */
  async function syncExternalData() {
    if (manualSyncPending) return;
    sendReviewSession({ type: "SYNC_STARTED" });
    try {
      await pollLatestPullRequest.mutateAsync({
        pullRequestId: initialData.pullRequest.id,
      });
    } catch (cause) {
      sendReviewSession({ type: "SYNC_FINISHED" });
      toast.error(
        `Could not queue ${providerLabel(initialData.pullRequest.provider)} synchronization`,
        {
          description:
            cause instanceof Error ? cause.message : "Try again in a moment.",
        },
      );
    }
  }

  /** Persists the exact PR revision currently visible in the workspace. */
  function rememberLoadedRevision() {
    const snapshot = initialData.snapshot;
    if (!snapshot) return;
    acknowledgeReviewRevision(window.localStorage, initialData.pullRequest.id, {
      headSha: snapshot.headSha,
      snapshotId: snapshot.id,
      version: snapshot.version,
    });
  }

  /** Replaces the current review workspace with the newly synced revision. */
  function loadAvailableChanges() {
    if (loadingChanges) return;
    rememberLoadedRevision();
    // Inside the transition, the banner stays up (with its button spinning)
    // until the refreshed workspace actually arrives.
    startLoadingChanges(() => {
      setUpdateAvailable(false);
      router.refresh();
    });
  }

  /** Acknowledges the explanation for the currently loaded PR revision. */
  function acknowledgeLoadedRevision() {
    rememberLoadedRevision();
    setRevisionNotice(undefined);
  }

  const answeredWaitUnitIds = useMemo(
    () => new Set(providerConversations.data?.answeredUnitIds ?? []),
    [providerConversations.data?.answeredUnitIds],
  );
  const waitingReviewUnits = useMemo(() => {
    const threads = providerConversations.data?.threads ?? [];
    const conceptTitleByUnitId = new Map(
      conceptProgress.flatMap(({ concept, members }) =>
        members.map((member) => [member.id, concept.title] as const),
      ),
    );
    return units.flatMap((unit): WaitingReviewUnit[] => {
      if (unit.status !== "waiting") return [];
      const unitThreads = threads.filter((thread) => thread.unitId === unit.id);
      const latestComment = [
        ...unitThreads.flatMap(({ comments }) => comments),
      ].sort(
        (left, right) =>
          new Date(right.createdAt).getTime() -
          new Date(left.createdAt).getTime(),
      )[0];
      return [
        {
          answered: answeredWaitUnitIds.has(unit.id),
          commentCount: unitThreads.reduce(
            (total, { comments }) => total + comments.length,
            0,
          ),
          conceptTitle: conceptTitleByUnitId.get(unit.id),
          id: unit.id,
          latestComment: latestComment
            ? {
                author: latestComment.author,
                body: latestComment.body.replace(/\s+/g, " ").trim(),
              }
            : undefined,
          path: unit.path,
          threadCount: unitThreads.length,
          title: unit.name,
          waitingSince: unit.waitingSince,
        },
      ];
    });
  }, [
    conceptProgress,
    providerConversations.data?.threads,
    answeredWaitUnitIds,
    units,
  ]);
  const answeredWaitCount = waitingReviewUnits.filter(
    ({ answered }) => answered,
  ).length;

  const activeProviderThreads =
    providerConversations.data?.threads.filter(
      (thread) => thread.unitId === activeUnit?.id,
    ) ?? [];
  const activeUnitHasConversation =
    activeProviderThreads.length > 0 ||
    (discussion.data?.comments.some(
      (comment) => comment.status === "published",
    ) ??
      false);
  const hasLiveConversation = activeUnitHasConversation;
  const notifiedAnsweredUnits = useRef(new Set<string>());
  useEffect(() => {
    const answeredUnitIds =
      providerConversations.data?.answeredUnitIds.filter(
        (unitId) => !notifiedAnsweredUnits.current.has(unitId),
      ) ?? [];
    if (answeredUnitIds.length === 0) return;
    for (const unitId of answeredUnitIds) {
      notifiedAnsweredUnits.current.add(unitId);
    }
    toast.info(
      answeredUnitIds.length === 1
        ? "A waiting conversation has a response"
        : `${answeredUnitIds.length} waiting conversations have responses`,
      {
        description:
          "The work stays in Waiting until you resume it — open it to see what changed.",
      },
    );
  }, [providerConversations.data?.answeredUnitIds]);
  /**
   * Moves the named units into the waiting section of the review path.
   *
   * The next index is read off the new list before anything is set, the way
   * `optimisticallyQueueSignOffs` does: choosing it clears a path filter that
   * matches nothing any more, which a replayed state updater would repeat.
   */
  function markUnitsWaiting(waitingUnitIds: string[], description: string) {
    const waiting = new Set(waitingUnitIds);
    const updated = units.map((unit) =>
      waiting.has(unit.id)
        ? {
            ...unit,
            status: "waiting" as const,
            waitingSince: new Date(),
            changedSinceSignOff: false,
          }
        : unit,
    );
    const nextIndex = nextReviewIndexAfterAction(updated);
    setUnits(updated);
    if (nextIndex >= 0) {
      setActiveIndex(nextIndex);
    }
    setQueueLimit(INITIAL_PATH_ITEMS);
    setWaitingLimit(INITIAL_PATH_ITEMS);
    setSelectedLine(undefined);
    setFeedback("");
    setShowDiff(true);
    setStartedAt(Date.now());
    toast.success("Waiting for response", { description });
  }
  const awaitResponse = api.review.awaitResponse.useMutation({
    // The reviewer may have moved on while the request was in flight, so the
    // unit that was paused is the one the wait row names, not the open one.
    onSuccess: (wait) => {
      const paused = unitsById.get(wait.unitId);
      if (!paused) return;
      markUnitsWaiting(
        [wait.unitId],
        `${paused.name} will return to your review path when its code or conversation changes.`,
      );
    },
    onError: (error) => toast.error(error.message),
  });

  const releaseReviewWaits = api.review.releaseReviewWaits.useMutation({
    // Every unit the request reached comes back, not only the rows this call
    // deleted: a wait the server had already dropped — answered in another
    // tab, or reopened by a poll this view has not seen — leaves nothing to
    // delete, and reading the deletions alone would leave that member paused
    // on screen with no row behind it.
    onSuccess: ({ authorizedUnitIds }) => {
      const released = new Set(authorizedUnitIds);
      setUnits((current) =>
        current.map((unit) =>
          released.has(unit.id)
            ? { ...unit, status: "pending" as const, waitingSince: null }
            : unit,
        ),
      );
      setQueueLimit(INITIAL_PATH_ITEMS);
      setWaitingLimit(INITIAL_PATH_ITEMS);
      setStartedAt(Date.now());
      toast.success("Back in your review path", {
        description:
          released.size === 1
            ? "The unit no longer waits for a response."
            : `${released.size} units no longer wait for a response.`,
      });
    },
    onError: (error) => toast.error(error.message),
    onSettled: () => setReleasingWaitingUnitId(undefined),
  });
  const publishComment = api.review.publishComment.useMutation({
    onSuccess: () => {
      toast.success("Comment published", {
        description: `Your inline comment is now on ${providerLabel(initialData.pullRequest.provider)}.`,
      });
      setFeedback("");
      setSelectedLine(undefined);
      void discussion.refetch();
      void providerConversations.refetch();
    },
    onError: (error) => toast.error(error.message),
  });
  const replyToThread = api.review.replyToThread.useMutation({
    onSuccess: () => {
      toast.success("Reply published", {
        description: `The conversation was updated on ${providerLabel(initialData.pullRequest.provider)}.`,
      });
      void providerConversations.refetch();
    },
    onError: (error) => toast.error(error.message),
  });
  const setThreadResolution = api.review.setThreadResolution.useMutation({
    onSuccess: ({ resolved }) => {
      toast.success(
        resolved ? "Conversation resolved" : "Conversation reopened",
        {
          description: `The change is live on ${providerLabel(initialData.pullRequest.provider)}.`,
        },
      );
      void providerConversations.refetch();
    },
    onError: (error) => toast.error(error.message),
  });
  const editThreadComment = api.review.editThreadComment.useMutation({
    onSuccess: () => {
      toast.success("Comment updated", {
        description: `The new text is live on ${providerLabel(initialData.pullRequest.provider)}.`,
      });
      void Promise.all([discussion.refetch(), providerConversations.refetch()]);
    },
    onError: (error) => toast.error(error.message),
  });
  const deleteThreadComment = api.review.deleteThreadComment.useMutation({
    onSuccess: () => {
      toast.success("Comment deleted", {
        description: `It is gone from ${providerLabel(initialData.pullRequest.provider)}.`,
      });
      void Promise.all([discussion.refetch(), providerConversations.refetch()]);
    },
    onError: (error) => toast.error(error.message),
  });
  const deleteThread = api.review.deleteThread.useMutation({
    onSuccess: ({ deleted }) => {
      toast.success("Conversation deleted", {
        description: `${deleted} ${deleted === 1 ? "comment is" : "comments are"} gone from ${providerLabel(initialData.pullRequest.provider)}.`,
      });
      void Promise.all([discussion.refetch(), providerConversations.refetch()]);
    },
    onError: (error) => toast.error(error.message),
  });
  /**
   * Reports that one named conversation is mid-change.
   *
   * Every conversation on the line renders from the same mutations, so the
   * pending state has to name the thread it belongs to or resolving one would
   * show the others as busy too.
   */
  function managingThread(threadExternalId: string) {
    return [
      setThreadResolution,
      editThreadComment,
      deleteThreadComment,
      deleteThread,
    ].some(
      (mutation) =>
        mutation.isPending &&
        mutation.variables?.threadExternalId === threadExternalId,
    );
  }

  /** Binds the thread-management mutations to one provider conversation. */
  function providerThreadActions(
    unitId: string,
    threadExternalId: string,
  ): ProviderConversationActions {
    return {
      onDeleteComment: (commentExternalId) =>
        deleteThreadComment.mutateAsync({
          unitId,
          threadExternalId,
          commentExternalId,
        }),
      onDeleteThread: () =>
        deleteThread.mutateAsync({ unitId, threadExternalId }),
      onEditComment: (commentExternalId, body) =>
        editThreadComment.mutateAsync({
          unitId,
          threadExternalId,
          commentExternalId,
          body,
        }),
      onReply: (body) =>
        replyToThread.mutateAsync({ unitId, threadExternalId, body }),
      onResolve: (resolved) =>
        setThreadResolution.mutateAsync({
          unitId,
          threadExternalId,
          resolved,
        }),
    };
  }

  /** Renders the open finding inline beside the line it accuses. */
  function renderInlineFindingCard(
    finding: DeepReviewFinding,
    lineNumber: number,
  ) {
    if (!activeUnit) return null;
    const jobId = deepReview.data?.jobId;
    return (
      <DeepReviewInlineFinding
        key={finding.id}
        finding={finding}
        variant="line"
        locationIndex={activeFindingLocationIndex}
        providerName={providerLabel(initialData.pullRequest.provider)}
        published={findingPublished(finding)}
        publishing={
          publishComment.isPending &&
          publishComment.variables?.aiFindingId === finding.id
        }
        onOpenLocation={(index) => openFinding(finding, index)}
        onPublish={
          jobId
            ? () =>
                publishComment.mutate({
                  unitId: activeUnit.id,
                  line: lineNumber,
                  aiJobId: jobId,
                  aiFindingId: finding.id,
                })
            : undefined
        }
        onEdit={() => {
          setFeedback(`**${finding.title}**\n\n${finding.body}`);
          openInlineComment(lineNumber);
        }}
        onCollapse={() => collapseFinding(finding.id)}
      />
    );
  }

  /** Renders the open finding above the diff when no visible line carries it. */
  function renderDetachedFindingCard() {
    if (!activeFinding || !activeFindingTarget || !activeUnit) return null;
    const target = activeFindingTarget;
    const onThisUnit =
      target.kind !== "nowhere" &&
      units[target.unitIndex]?.id === activeUnit.id;
    // A card never follows the reviewer into unrelated code: it detaches only
    // where the finding itself points, or when it points nowhere at all.
    if (target.kind === "unit" && !onThisUnit) return null;
    // The unified view gives every rendered line a `review-line` id but only
    // hangs details off the reviewed ranges, so a line in the gap between a
    // concept's disjoint ranges resolves and lights up with nowhere to put
    // the body — the one case the reveal effect cannot detect for itself.
    const inlineCardRenders =
      onThisUnit &&
      !findingRevealExhausted &&
      (sideBySideVisible ||
        (target.kind === "line" && isPrimaryReviewLine(target.line)));
    if (target.kind === "line" && (!onThisUnit || inlineCardRenders)) {
      return null;
    }
    const label =
      target.kind === "nowhere"
        ? "Finding with no line in this revision"
        : target.kind === "unit"
          ? "Finding with no line in this file"
          : "Finding whose line this unit does not render";
    return (
      <div className="mb-3">
        <p className="text-fog px-4 text-[9px] tracking-[.14em] uppercase">
          {label}
        </p>
        <DeepReviewInlineFinding
          finding={activeFinding}
          variant="detached"
          locationIndex={activeFindingLocationIndex}
          providerName={providerLabel(initialData.pullRequest.provider)}
          published={findingPublished(activeFinding)}
          publishing={false}
          onOpenLocation={(index) => openFinding(activeFinding, index)}
          onCollapse={() => collapseFinding(activeFinding.id)}
          onShowInCode={
            target.kind === "unit"
              ? () => openFinding(activeFinding, activeFindingLocationIndex)
              : undefined
          }
        />
      </div>
    );
  }

  /** Renders every review artifact attached to one source line in either code view. */
  function renderReviewLineDetails(lineNumber: number) {
    if (!activeUnit) return null;
    const endingExplanations = explanationAnnotations.filter(
      (annotation) =>
        lineNumber >= annotation.line &&
        lineNumber <= (annotation.endLine ?? annotation.line) &&
        (annotation.endLine ?? annotation.line) === lineNumber,
    );
    const lineFindings =
      discussion.data?.findings.filter(
        (finding) => finding.line === lineNumber,
      ) ?? [];
    // A different source entirely from `lineFindings` above: that one is a
    // completed explain job's `result.findings`, a payload a deep-review run
    // never writes, so the two blocks cannot collide on one line.
    const lineDeepFindings = deepReviewFindingsByLine.get(lineNumber) ?? [];
    const allLineQuestions = [
      ...(aiQuestions.data
        ?.filter(
          (question) =>
            question.focusLine === lineNumber &&
            !liveAiQuestions.some(({ jobId }) => jobId === question.id),
        )
        .map((question) => ({
          error: question.error,
          id: question.id,
          jobId: question.id,
          question: question.question,
          result: question.result
            ? {
                summary: question.result.summary,
                commentProposals: question.result.commentProposals?.map(
                  (proposal, index) => ({
                    ...proposal,
                    published:
                      discussion.data?.comments.some(
                        (comment) =>
                          comment.aiJobId === question.id &&
                          comment.aiFindingIndex === index &&
                          comment.status === "published",
                      ) ?? false,
                  }),
                ),
              }
            : null,
          status: question.status,
          threadId: question.conversationId,
        })) ?? []),
      ...liveAiQuestions
        .filter((question) => question.focusLine === lineNumber)
        .map((question) => ({
          error: question.error,
          id: question.id,
          jobId: question.jobId,
          progress: question.progress,
          question: question.question,
          result: question.result,
          status: question.status,
          threadId: question.threadId,
        })),
    ];
    const lineQuestionGroups = new Map<string, typeof allLineQuestions>();
    for (const question of allLineQuestions) {
      const threadId = question.threadId;
      const group = lineQuestionGroups.get(threadId) ?? [];
      group.push(question);
      lineQuestionGroups.set(threadId, group);
    }
    const activeThreadId =
      aiQuestionThreadId && lineQuestionGroups.has(aiQuestionThreadId)
        ? aiQuestionThreadId
        : ([...lineQuestionGroups.keys()].at(-1) ?? aiQuestionThreadId);
    const lineQuestions = activeThreadId
      ? (lineQuestionGroups.get(activeThreadId) ?? [])
      : [];
    const lineThreads = activeProviderThreads.filter(
      (thread) => thread.line === lineNumber,
    );
    const providerThreadIds = new Set(
      lineThreads.map((thread) => thread.externalId),
    );
    const lineComments =
      discussion.data?.comments.filter(
        (comment) =>
          comment.line === lineNumber &&
          comment.status === "published" &&
          comment.source === "user" &&
          (!comment.providerExternalId ||
            !providerThreadIds.has(comment.providerExternalId)),
      ) ?? [];

    return (
      <>
        {endingExplanations.map((annotation) => {
          const annotationIndex = explanationAnnotations.indexOf(annotation);
          const endLine = annotation.endLine ?? annotation.line;
          return (
            <article
              id={`ai-explanation-${annotationIndex}`}
              key={`${annotation.line}-${endLine}-${annotation.title}`}
              className="border-violet/20 bg-violet/[.045] relative mx-4 my-2 ml-[82px] overflow-hidden rounded-xl border p-3 font-sans shadow-[0_10px_30px_var(--app-shadow)]"
            >
              <span className="bg-violet absolute inset-y-0 left-0 w-0.5" />
              <div className="flex items-start gap-3">
                <span className="bg-violet/10 text-violet mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg">
                  <Sparkles className="size-3.5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <p className="text-violet text-[9px] font-semibold tracking-[.12em] uppercase">
                      AI walkthrough
                    </p>
                    <span className="text-fog font-mono text-[9px]">
                      {annotation.line === endLine
                        ? `Line ${annotation.line}`
                        : `Lines ${annotation.line}–${endLine}`}
                    </span>
                  </div>
                  <h3 className="text-cloud mt-1 text-xs font-medium">
                    {annotation.title}
                  </h3>
                  <p className="text-mist mt-1.5 text-xs leading-5">
                    {annotation.body}
                  </p>
                </div>
              </div>
            </article>
          );
        })}
        {aiQuestionLine === lineNumber && (
          <InlineAiQuestion
            autoFocus={focusAiQuestionComposer}
            canAsk={canAskAi}
            draft={aiQuestionDraft}
            entries={lineQuestions}
            line={lineNumber}
            minimumLine={Math.min(activeUnit.startLine, previousUnitStartLine)}
            maximumLine={Math.max(activeUnit.endLine, previousUnitEndLine)}
            onAsk={askAiQuestion}
            onChange={setAiQuestionDraft}
            onClose={() => {
              if (activeUnitId) {
                dismissedAiQuestionUnits.current.add(activeUnitId);
                rememberAiConversationVisibility(
                  window.localStorage,
                  initialData.pullRequest.id,
                  activeUnitId,
                  null,
                );
              }
              setAiQuestionLine(undefined);
              setAiQuestionThreadId(undefined);
              setFocusAiQuestionComposer(false);
              setAiQuestionPreviewLine(undefined);
              setAiQuestionDraft("");
            }}
            onDeleteThread={async (jobIds) => {
              if (jobIds.length === 0) return;
              await deleteAiQuestionThread.mutateAsync({
                pullRequestId: initialData.pullRequest.id,
                unitId: activeUnit.id,
                jobIds,
              });
              await aiQuestions.refetch();
              dismissedAiQuestionUnits.current.add(activeUnit.id);
              rememberAiConversationVisibility(
                window.localStorage,
                initialData.pullRequest.id,
                activeUnit.id,
                null,
              );
              setAiQuestionLine(undefined);
              setAiQuestionThreadId(undefined);
              setFocusAiQuestionComposer(false);
              setAiQuestionPreviewLine(undefined);
              setAiQuestionDraft("");
              toast.success("AI conversation deleted", {
                description:
                  "Previously published pull-request comments were preserved.",
              });
            }}
            onMove={moveAiQuestion}
            onPreview={setAiQuestionPreviewLine}
            onPublishProposal={async (proposal) => {
              await publishComment.mutateAsync({
                unitId: activeUnit.id,
                ...proposal,
              });
              dismissedAiQuestionUnits.current.add(activeUnit.id);
              rememberAiConversationVisibility(
                window.localStorage,
                initialData.pullRequest.id,
                activeUnit.id,
                null,
              );
              setAiQuestionLine(undefined);
              setAiQuestionThreadId(undefined);
              setFocusAiQuestionComposer(false);
            }}
            onStep={stepAiQuestion}
            providerName={providerLabel(initialData.pullRequest.provider)}
          />
        )}
        {[...lineQuestionGroups.entries()].map(
          ([threadId, questions], groupIndex) =>
            !(aiQuestionLine === lineNumber && activeThreadId === threadId) && (
              <button
                key={threadId}
                type="button"
                aria-label={
                  lineQuestionGroups.size === 1
                    ? `Reopen AI conversation on line ${lineNumber}`
                    : `Reopen AI conversation ${groupIndex + 1} on line ${lineNumber}`
                }
                onClick={() => {
                  dismissedAiQuestionUnits.current.delete(activeUnit.id);
                  rememberAiConversationVisibility(
                    window.localStorage,
                    initialData.pullRequest.id,
                    activeUnit.id,
                    lineNumber,
                    threadId,
                  );
                  setFocusAiQuestionComposer(false);
                  setAiQuestionThreadId(threadId);
                  setAiQuestionLine(lineNumber);
                }}
                className="border-violet/15 bg-violet/[.035] text-violet hover:border-violet/30 hover:bg-violet/[.07] mx-4 my-1 ml-[82px] flex items-center gap-2 rounded-lg border px-2.5 py-1.5 font-sans text-[9px] transition"
              >
                <Sparkles className="size-3" />
                AI conversation
                <span className="border-violet/15 bg-panel rounded px-1.5 py-0.5 font-mono text-[8px]">
                  {questions.length}
                </span>
              </button>
            ),
        )}
        {lineFindings.map((finding) => {
          const published =
            discussion.data?.comments.some(
              (comment) =>
                comment.aiJobId === finding.aiJobId &&
                comment.aiFindingIndex === finding.index &&
                comment.status === "published",
            ) ?? false;
          const publishingThisFinding =
            publishComment.isPending &&
            publishComment.variables?.aiJobId === finding.aiJobId &&
            publishComment.variables?.aiFindingIndex === finding.index;
          return (
            <article
              key={`${finding.aiJobId}-${finding.index}`}
              className="mx-4 my-2 ml-[82px] rounded-xl border border-amber-300/20 bg-surface p-3 font-sans"
            >
              <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
                <div className="min-w-0">
                  <p className="text-[9px] font-semibold tracking-wider text-amber-800 uppercase dark:text-amber-200">
                    AI review finding
                  </p>
                  <p className="text-cloud mt-1 text-xs font-medium">
                    {finding.title}
                  </p>
                </div>
                {published ? (
                  <Badge className="border-lime/20 bg-lime/8 text-lime">
                    Published
                  </Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    disabled={publishComment.isPending}
                    onClick={() =>
                      publishComment.mutate({
                        unitId: activeUnit.id,
                        line: lineNumber,
                        aiJobId: finding.aiJobId,
                        aiFindingIndex: finding.index,
                      })
                    }
                  >
                    {publishingThisFinding ? (
                      <LoaderCircle className="size-3 animate-spin" />
                    ) : (
                      <Send className="size-3" />
                    )}
                    {publishingThisFinding
                      ? "Posting…"
                      : `Post to ${providerLabel(initialData.pullRequest.provider)}`}
                  </Button>
                )}
              </div>
              <p className="text-mist mt-2 text-xs leading-5">{finding.body}</p>
            </article>
          );
        })}
        {/* The model's claim reads above the human conversation about it. */}
        {lineDeepFindings
          .filter(({ id }) => id !== activeFindingId)
          .map((finding) => (
            <DeepReviewFindingChip
              key={finding.id}
              finding={finding}
              published={findingPublished(finding)}
              onOpen={() => openFinding(finding)}
            />
          ))}
        {activeFinding &&
          activeFindingTarget?.kind === "line" &&
          activeFindingTarget.line === lineNumber &&
          units[activeFindingTarget.unitIndex]?.id === activeUnit.id &&
          !findingRevealExhausted &&
          renderInlineFindingCard(activeFinding, lineNumber)}
        {lineThreads.map((thread) => (
          <ProviderConversation
            key={thread.externalId}
            provider={initialData.pullRequest.provider}
            thread={thread}
            newSince={
              activeUnit.status === "waiting" ? activeUnit.waitingSince : null
            }
            managing={managingThread(thread.externalId)}
            replying={
              replyToThread.isPending &&
              replyToThread.variables?.threadExternalId === thread.externalId
            }
            {...providerThreadActions(activeUnit.id, thread.externalId)}
            publishedByReviewDuck={
              discussion.data?.comments.some(
                (comment) => comment.providerExternalId === thread.externalId,
              ) ?? false
            }
          />
        ))}
        {lineComments.map((comment) => (
          <div
            key={comment.id}
            className="border-cyan/15 bg-cyan/[.035] mx-4 my-2 ml-[82px] rounded-xl border p-3 font-sans"
          >
            <p className="text-cyan text-[9px] font-semibold tracking-wider uppercase">
              Posted to {providerLabel(initialData.pullRequest.provider)}
            </p>
            <p className="text-mist mt-1 text-xs leading-5">{comment.body}</p>
          </div>
        ))}
        {selectedLine === lineNumber && (
          <div className="border-cyan/20 bg-panel mx-4 my-2 ml-[82px] rounded-xl border p-3 font-sans shadow-xl">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <p className="text-cloud flex shrink-0 items-center gap-2 text-xs font-medium">
                <MessageSquareText className="text-cyan size-3.5" />
                Comment on {providerLabel(initialData.pullRequest.provider)} ·
                line {lineNumber}
              </p>
              <span className="text-fog min-w-0 truncate text-right font-mono text-[9px]">
                {activeUnit.path}
              </span>
            </div>
            <textarea
              ref={commentInputRef}
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSelectedLine(undefined);
                  setFeedback("");
                } else if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey) &&
                  feedback.trim() &&
                  !publishComment.isPending
                ) {
                  event.preventDefault();
                  publishComment.mutate({
                    unitId: activeUnit.id,
                    line: lineNumber,
                    body: feedback,
                  });
                }
              }}
              placeholder={`Write an inline ${providerLabel(initialData.pullRequest.provider)} comment…`}
              rows={3}
              className="bg-surface text-cloud focus:border-cyan/45 mt-3 w-full resize-y rounded-lg border border-line px-3 py-2 text-xs leading-5 outline-none"
            />
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-fog flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] leading-4">
                <span>
                  Posts immediately to{" "}
                  {providerLabel(initialData.pullRequest.provider)}.
                </span>
                <span className="flex items-center gap-1">
                  <ShortcutHint shortcut={reviewShortcuts.postComment} />
                  post
                </span>
                <span>· Esc cancels</span>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSelectedLine(undefined);
                    setFeedback("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!feedback.trim() || publishComment.isPending}
                  onClick={() =>
                    publishComment.mutate({
                      unitId: activeUnit.id,
                      line: lineNumber,
                      body: feedback,
                    })
                  }
                >
                  {publishComment.isPending &&
                  publishComment.variables?.body != null ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : (
                    <Send className="size-3" />
                  )}
                  {publishComment.isPending &&
                  publishComment.variables?.body != null
                    ? "Posting…"
                    : `Post to ${providerLabel(initialData.pullRequest.provider)}`}
                </Button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }
  const startPullRequestReview = api.ai.start.useMutation({
    onSuccess: () => {
      toast.success("Pull request review started", {
        description:
          "Findings will appear inline as the review agent completes its analysis.",
      });
      void pullRequestReview.refetch();
    },
    onError: showAiStartError,
  });
  const reviewRunning =
    startPullRequestReview.isPending ||
    aiJobActive(pullRequestReview.data?.status);
  const aiUsage = api.ai.usage.useQuery(
    { pullRequestId: initialData.pullRequest.id },
    {
      refetchInterval:
        explanationRunning || aiQuestionRunning || reviewRunning
          ? 2_000
          : false,
    },
  );
  // Coverage and findings are their own query rather than fields on
  // `ai.reviewStatus`: that one polls every two seconds, and carrying the whole
  // finding tree on it would refetch every finding twice a second.
  const deepReview = api.review.deepReviewFindings.useQuery(
    { pullRequestId: initialData.pullRequest.id },
    { refetchInterval: reviewRunning ? 4_000 : false },
  );
  const deepReviewFindings = deepReview.data?.findings;
  const filteredFindings = useMemo(
    () =>
      (deepReviewFindings ?? []).filter(
        (finding) =>
          (findingSeverityFilter.size === 0 ||
            findingSeverityFilter.has(finding.severity)) &&
          (findingCategoryFilter === "all" ||
            finding.category === findingCategoryFilter),
      ),
    [deepReviewFindings, findingCategoryFilter, findingSeverityFilter],
  );
  const findingGroups = useMemo(
    () => groupDeepReviewFindings(filteredFindings, units),
    [filteredFindings, units],
  );
  // The flattened groups, so `]` and `[` step in exactly the order the index
  // is read in rather than in the run's own rank order.
  const visibleFindings = useMemo(
    () => findingGroups.flatMap(({ findings }) => findings),
    [findingGroups],
  );
  const activeFinding = deepReviewFindings?.find(
    ({ id }) => id === activeFindingId,
  );
  const activeFindingTarget = activeFinding
    ? deepReviewFindingTarget(activeFinding, units, activeFindingLocationIndex)
    : undefined;
  const findingRevealExhausted =
    pendingFindingReveal?.exhausted === true &&
    pendingFindingReveal.findingId === activeFindingId;
  // Resolved once per unit rather than once per rendered line: the index can
  // hold forty findings and a unit can hold hundreds of lines.
  const deepReviewFindingsByLine = useMemo(() => {
    const byLine = new Map<number, DeepReviewFinding[]>();
    if (!activeUnitId) return byLine;
    for (const finding of deepReviewFindings ?? []) {
      const target = deepReviewFindingTarget(finding, units);
      if (target.kind !== "line") continue;
      if (units[target.unitIndex]?.id !== activeUnitId) continue;
      const group = byLine.get(target.line) ?? [];
      group.push(finding);
      byLine.set(target.line, group);
    }
    return byLine;
  }, [activeUnitId, deepReviewFindings, units]);
  const publishedFindingIds = useMemo(
    () => new Set(deepReview.data?.publishedFindingIds ?? []),
    [deepReview.data?.publishedFindingIds],
  );
  const pullReviewRequested = useRef(false);
  useEffect(() => {
    // The automatic review trigger is entirely client-side; there is no server
    // counterpart. Ungated, an unentitled account with the preference on gets a
    // refused mutation on every pull-request page load.
    if (
      aiConfiguration.data?.deepReviewAvailable &&
      aiConfiguration.data.reviewPullRequests &&
      aiConfiguration.data.mode !== "off" &&
      !pullRequestReview.isLoading &&
      !pullRequestReview.data &&
      !startPullRequestReview.isPending &&
      !pullReviewRequested.current
    ) {
      pullReviewRequested.current = true;
      startPullRequestReview.mutate({
        pullRequestId: initialData.pullRequest.id,
        kind: "review",
      });
    }
  }, [
    aiConfiguration.data?.deepReviewAvailable,
    aiConfiguration.data?.mode,
    aiConfiguration.data?.reviewPullRequests,
    initialData.pullRequest.id,
    pullRequestReview.data,
    pullRequestReview.isLoading,
    startPullRequestReview,
  ]);
  useEffect(() => {
    if (!activeUnitId) return;
    setSelectedLine(undefined);
    setFeedback("");
    setAiQuestionLine(undefined);
    setAiQuestionThreadId(undefined);
    setFocusAiQuestionComposer(false);
    setAiQuestionPreviewLine(undefined);
    setAiQuestionDraft("");
  }, [activeUnitId]);
  // Declared after the reset above so it runs after it in the same commit: a
  // line picked in another member's card survives the switch that opens it.
  useEffect(() => {
    if (!pendingCommentLine || pendingCommentLine.unitId !== activeUnitId) {
      return;
    }
    setPendingCommentLine(undefined);
    openInlineComment(pendingCommentLine.line);
  }, [activeUnitId, openInlineComment, pendingCommentLine]);
  useEffect(() => {
    if (selectedLine !== undefined) commentInputRef.current?.focus();
  }, [selectedLine]);
  useEffect(() => {
    if (!importPreview) return;
    importPreviewFocusRef.current?.scrollIntoView({ block: "center" });
    /** Closes the active review overlay when Escape is pressed. */
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setImportPreview(undefined);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [importPreview]);
  useTerminalReviewRefetch(pullRequestReview.data?.status, {
    aiUsage,
    deepReview,
    discussion,
  });
  const { refetch: refetchAiUsage } = aiUsage;
  useEffect(() => {
    if (aiStatus.data?.status === "completed") {
      void refetchAiUsage();
    }
  }, [aiStatus.data?.status, refetchAiUsage]);
  const autoRequested = useRef(new Set<string>());
  useEffect(() => {
    if (
      activeUnit &&
      settledActiveUnitId === activeUnit.id &&
      aiConfiguration.data?.mode === "automatic" &&
      !aiStatus.isLoading &&
      !aiStatus.data &&
      !startExplanation.isPending &&
      !autoRequested.current.has(activeUnit.id)
    ) {
      autoRequested.current.add(activeUnit.id);
      startExplanation.mutate({
        pullRequestId: initialData.pullRequest.id,
        unitId: activeUnit.id,
        kind: "explain",
      });
    }
  }, [
    activeUnit,
    aiConfiguration.data?.mode,
    aiStatus.data,
    aiStatus.isLoading,
    initialData.pullRequest.id,
    settledActiveUnitId,
    startExplanation,
  ]);

  const openCommands = useCallback(() => setCommandCenterMode("commands"), []);
  const openShortcuts = useCallback(
    () => setCommandCenterMode("shortcuts"),
    [],
  );
  const nextQueueEntry = pathSections.upcoming[0];
  const activeConceptSignOffPending = Boolean(
    activeConcept && pendingConceptSignOffIds.has(activeConcept.id),
  );
  const activeSignOffPending = activeUnit
    ? signOffQueue.ids.has(activeUnit.id) || activeConceptSignOffPending
    : false;
  const activeConceptSourcesAvailable = activeConceptMembers.every((unit) =>
    initialData.sourceDelivery === "direct"
      ? unit.kind === "binary" || hydratedUnitIds.has(unit.id)
      : true,
  );
  const deletedUnitsToSignOff = useMemo(
    () => deletedFileSignOffUnits(units, fileContexts),
    [fileContexts, units],
  );
  const canSignOffDeletedFiles =
    activeFileIsDeleted &&
    deletedUnitsToSignOff.length > 0 &&
    deletedUnitsToSignOff.every((unit) =>
      initialData.sourceDelivery === "direct"
        ? hydratedUnitIds.has(unit.id)
        : true,
    ) &&
    !resetReview.isPending;
  const pendingSignOffCount =
    signOffQueue.ids.size + pendingConceptSignOffIds.size;
  const signOffQueueProgress = `${signOffQueue.completed}/${signOffQueue.total}`;
  const backgroundSaveProgress =
    pendingConceptSignOffIds.size > 0
      ? `${pendingSignOffCount} pending`
      : signOffQueueProgress;
  const footerSaveState = reviewFooterSaveState({
    activeSavePending: activeSignOffPending,
    pendingSaveCount: pendingSignOffCount,
    reviewComplete,
  });
  const completionVisible =
    reviewComplete && completionOpen && footerSaveState === "idle";
  const waitingCompletionVisible =
    reviewCaughtUp && waitingCompletionOpen && footerSaveState === "idle";
  const openPullRequests = useCallback(
    () => navigate("/pullrequests"),
    [navigate],
  );
  const openNextReview = useCallback(() => {
    if (nextReview) navigate(`/review/${nextReview.id}`);
  }, [nextReview, navigate]);
  useEffect(() => {
    if (!completionVisible && !waitingCompletionVisible) return;

    /** Dismisses either end state while preserving the review beneath it. */
    function dismissEndState(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (completionVisible) setCompletionOpen(false);
      if (waitingCompletionVisible) setWaitingCompletionOpen(false);
    }

    document.addEventListener("keydown", dismissEndState);
    return () => document.removeEventListener("keydown", dismissEndState);
  }, [completionVisible, waitingCompletionVisible]);
  const canUseAi =
    aiConfiguration.data?.mode !== "off" &&
    !explanationRunning &&
    !!activeUnit &&
    settledActiveUnitId === activeUnit.id &&
    activeUnit.kind !== "binary";
  const canAskAi =
    aiConfiguration.data?.mode !== "off" &&
    !aiQuestionRunning &&
    !!activeUnit &&
    settledActiveUnitId === activeUnit.id &&
    activeUnit.kind !== "binary";
  const awaitPending = awaitResponse.isPending;
  // A wait names one unit. Sibling members stay reviewable, so the open
  // card's own status is what every "is this waiting?" check reads.
  const activeWaitStatus = activeUnit?.status;
  const activeUnitAnswered =
    activeWaitStatus === "waiting" &&
    Boolean(activeUnit && answeredWaitUnitIds.has(activeUnit.id));
  // A concept action needs a layout to name, and a concept of one member is
  // its unit — there the two levels collapse into a single action.
  const conceptActionAvailable = Boolean(
    activeConcept &&
      initialData.conceptLayout &&
      activeConceptMembers.length > 1,
  );
  const outstandingConceptMembers = activeConceptMembers.filter(
    ({ status }) => status !== "signed_off",
  );
  // The last unit owed is where a concept ends, so it is the one place the
  // wider sign-off is the one to advertise: recording it finishes the concept.
  const onLastConceptMember =
    conceptActionAvailable &&
    outstandingConceptMembers.length === 1 &&
    outstandingConceptMembers[0]?.id === activeUnit?.id;
  const reviewActionBlocked =
    !activeUnit ||
    reviewComplete ||
    activeWaitStatus === "waiting" ||
    activeSignOffPending ||
    undoSignOff.isPending ||
    undoConcept.isPending ||
    awaitPending ||
    resetReview.isPending;
  // One unit needs only its own source; the concept needs every member's,
  // because it records all of them at once.
  const canSignOffUnit =
    !reviewActionBlocked &&
    activeSourceAvailable &&
    activeUnit.status !== "signed_off";
  const canSignOffConcept =
    !reviewActionBlocked &&
    conceptActionAvailable &&
    activeConceptSourcesAvailable &&
    activeConceptProgress?.status !== "signed_off";
  const canUsePrimaryAction =
    activeWaitStatus === "signed_off" || activeWaitStatus === "waiting"
      ? !!activeUnit &&
        !reviewComplete &&
        !activeSignOffPending &&
        !undoSignOff.isPending &&
        !undoConcept.isPending &&
        !awaitPending &&
        !resetReview.isPending &&
        // Continue only exists when it has somewhere actionable to go. A
        // review that is only waiting belongs to the caught-up state instead
        // of a no-op button.
        hasNextActionableUnit
      : onLastConceptMember
        ? canSignOffConcept
        : canSignOffUnit;
  const primaryIsContinue =
    activeWaitStatus === "signed_off" || activeWaitStatus === "waiting";
  // The scope the plain key commits to, named the same way wherever it is
  // read: the footer, and the command centre entry that carries it.
  const primaryScopeLabel = primaryIsContinue
    ? filteredReviewActive
      ? "Next match"
      : "Continue"
    : onLastConceptMember
      ? `Sign off concept (${activeConceptMembers.length})`
      : conceptActionAvailable
        ? "Sign off unit"
        : "Sign off";
  const primaryActionLabel = activeConceptSignOffPending
    ? "Saving concept…"
    : activeSignOffPending
      ? `Saving ${signOffQueueProgress}…`
      : primaryScopeLabel;
  const canAwaitResponse =
    !!activeUnit &&
    hasLiveConversation &&
    activeWaitStatus !== "waiting" &&
    !awaitPending &&
    !activeSignOffPending;
  const canAwaitUnit = canAwaitResponse && activeUnitHasConversation;
  const heldWaitUnitIds =
    activeUnit?.status === "waiting" ? [activeUnit.id] : [];
  const canStopWaiting =
    activeWaitStatus === "waiting" &&
    heldWaitUnitIds.length > 0 &&
    !awaitPending &&
    !releaseReviewWaits.isPending;
  const undoableSignOff = nextUndoableSignOff(signOffUndoHistory, units);
  const canUndoSignOff =
    !!undoableSignOff &&
    // Both ways a sign-off is saved mark their units optimistically, so undo
    // waits for the save it would otherwise race: the queue drains unit
    // sign-offs, and a concept sign-off is one request of its own.
    signOffQueue.ids.size === 0 &&
    pendingConceptSignOffIds.size === 0 &&
    !undoSignOff.isPending &&
    !undoConcept.isPending &&
    !resetReview.isPending;

  /** Shows the review-path panel as a drawer or persistent desktop column. */
  function showPathPanel() {
    setPathPanelCollapsed(false);
    if (!window.matchMedia("(min-width: 1536px)").matches) {
      setInsightsPanelOpen(false);
      setPathPanelOpen(true);
    }
  }

  /** Hides the review-path drawer or collapses its persistent desktop column. */
  function hidePathPanel() {
    setPathPanelOpen(false);
    if (window.matchMedia("(min-width: 1536px)").matches) {
      setPathPanelCollapsed(true);
    }
  }

  /** Toggles the review-path panel for the active responsive layout. */
  function togglePathPanel() {
    if (window.matchMedia("(min-width: 1536px)").matches) {
      setPathPanelOpen(false);
      setPathPanelCollapsed((current) => !current);
      return;
    }
    if (pathPanelOpen) {
      setPathPanelOpen(false);
    } else {
      setInsightsPanelOpen(false);
      setPathPanelOpen(true);
    }
  }

  /** Shows AI assistance as a drawer or persistent desktop column. */
  function showInsightsPanel() {
    setInsightsPanelCollapsed(false);
    if (!window.matchMedia("(min-width: 1280px)").matches) {
      setPathPanelOpen(false);
      setInsightsPanelOpen(true);
    }
  }

  /** Hides the AI drawer or collapses its persistent desktop column. */
  function hideInsightsPanel() {
    setInsightsPanelOpen(false);
    if (window.matchMedia("(min-width: 1280px)").matches) {
      setInsightsPanelCollapsed(true);
    }
  }

  /** Toggles AI assistance for the active responsive layout. */
  function toggleInsightsPanel() {
    if (window.matchMedia("(min-width: 1280px)").matches) {
      setInsightsPanelOpen(false);
      setInsightsPanelCollapsed((current) => !current);
      return;
    }
    if (insightsPanelOpen) {
      setInsightsPanelOpen(false);
    } else {
      setPathPanelOpen(false);
      setInsightsPanelOpen(true);
    }
  }

  /** Starts an AI explanation for the active review unit. */
  function explainActiveUnit() {
    if (!activeUnit || !canUseAi) return;
    startExplanation.mutate({
      pullRequestId: initialData.pullRequest.id,
      unitId: activeUnit.id,
      kind: "explain",
    });
  }

  /** Opens an inline question at the visible in-scope line nearest the reader. */
  function openAiQuestion() {
    if (!activeUnit || activeUnit.kind === "binary") return;
    openAiQuestionAt(centredReviewLine());
  }

  /**
   * Names the review line sitting closest to the middle of the code pane.
   *
   * Both keyboard entry points anchor themselves here, so asking about a line
   * and commenting on one land where the reviewer is already reading instead
   * of wherever the last interaction left a cursor.
   */
  function centredReviewLine() {
    const pane = codeScrollRef.current;
    const center = pane
      ? pane.getBoundingClientRect().top + pane.clientHeight / 2
      : window.innerHeight / 2;
    // Each line is measured once: a comparator that measured would force a
    // layout read on every comparison the sort makes.
    const nearest = Array.from(
      document.querySelectorAll<HTMLElement>('[id^="review-line-"]'),
    )
      .flatMap((element) => {
        const line = Number(element.id.replace("review-line-", ""));
        if (!Number.isInteger(line) || !isPrimaryReviewLine(line)) return [];
        const bounds = element.getBoundingClientRect();
        return [
          {
            distance: Math.abs(center - (bounds.top + bounds.height / 2)),
            line,
          },
        ];
      })
      .sort((left, right) => left.distance - right.distance)[0]?.line;
    const firstChangedLine = [...changedCurrentLines]
      .filter(isPrimaryReviewLine)
      .sort((left, right) => left - right)[0];
    return nearest ?? firstChangedLine ?? primaryReviewStart;
  }

  /** Opens the provider comment composer on the line the reviewer is reading. */
  function openCentredInlineComment() {
    if (!activeUnit || activeUnit.kind === "binary") return;
    openInlineComment(
      closestReviewLine(
        centredReviewLine(),
        primaryReviewRanges,
        primaryReviewStart,
        primaryReviewEnd,
      ),
    );
  }

  /** Opens the inline AI conversation anchored to one chosen review line. */
  function openAiQuestionAt(line: number) {
    if (!activeUnit || activeUnit.kind === "binary") return;
    dismissedAiQuestionUnits.current.delete(activeUnit.id);
    setSelectedLine(undefined);
    setKeyboardLine(undefined);
    setFocusAiQuestionComposer(true);
    const nextLine = closestReviewLine(
      line,
      primaryReviewRanges,
      primaryReviewStart,
      primaryReviewEnd,
    );
    const latestLiveThread = liveAiQuestions
      .filter(({ focusLine }) => focusLine === nextLine)
      .at(-1)?.threadId;
    const latestPersistedThread = aiQuestions.data
      ?.filter(({ focusLine }) => focusLine === nextLine)
      .at(-1)?.conversationId;
    const threadId =
      latestLiveThread ?? latestPersistedThread ?? crypto.randomUUID();
    setAiQuestionLine(nextLine);
    setAiQuestionThreadId(threadId);
    rememberAiConversationVisibility(
      window.localStorage,
      initialData.pullRequest.id,
      activeUnit.id,
      nextLine,
      threadId,
    );
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document
          .getElementById("inline-ai-question")
          ?.scrollIntoView({ block: "center", behavior: "smooth" }),
      ),
    );
  }

  /** Moves the inline AI question while keeping it inside review scope. */
  function moveAiQuestion(line: number) {
    if (!activeUnit) return;
    const nextLine = closestReviewLine(
      line,
      primaryReviewRanges,
      primaryReviewStart,
      primaryReviewEnd,
    );
    if (nextLine === aiQuestionLine) return;
    const pane = codeScrollRef.current;
    const card = document.getElementById("inline-ai-question");
    if (pane && card) {
      aiQuestionMoveAnchor.current = {
        cardTop: card.getBoundingClientRect().top,
        scrollTop: pane.scrollTop,
      };
    }
    setAiQuestionLine(nextLine);
    rememberAiConversationVisibility(
      window.localStorage,
      initialData.pullRequest.id,
      activeUnit.id,
      nextLine,
      aiQuestionThreadId,
    );
  }

  /** Moves the AI question to the next rendered in-scope review line. */
  function stepAiQuestion(direction: -1 | 1) {
    if (!activeUnit || aiQuestionLine === undefined) return;
    const renderedLines = Array.from(
      document.querySelectorAll<HTMLElement>('[id^="review-line-"]'),
    )
      .map((element) => Number(element.id.replace("review-line-", "")))
      .filter(
        (line, index, lines) =>
          Number.isInteger(line) &&
          isPrimaryReviewLine(line) &&
          lines.indexOf(line) === index,
      )
      .sort((left, right) => left - right);
    const nextLine =
      direction === 1
        ? renderedLines.find((line) => line > aiQuestionLine)
        : [...renderedLines].reverse().find((line) => line < aiQuestionLine);
    if (nextLine !== undefined) moveAiQuestion(nextLine);
  }

  /** Applies one durable agent-stream update to an optimistic chat entry. */
  function updateLiveAiQuestion(id: string, update: AiQuestionStreamUpdate) {
    setLiveAiQuestions((questions) =>
      questions.map((question) =>
        question.id === id
          ? {
              ...question,
              error: update.error ?? null,
              progress: update.progress,
              result: update.text
                ? {
                    summary: update.text,
                    commentProposals: update.commentProposals,
                  }
                : question.result,
              status: update.status === "working" ? "running" : update.status,
            }
          : question,
      ),
    );
  }

  /** Follows the persisted durable conversation stream for a focused AI question. */
  async function streamAiQuestion(jobId: string, optimisticId: string) {
    aiQuestionStreams.current.get(optimisticId)?.abort();
    const controller = new AbortController();
    aiQuestionStreams.current.set(optimisticId, controller);
    let cursor = -1;
    let reconnects = 0;
    try {
      while (!controller.signal.aborted) {
        try {
          const query = cursor >= 0 ? `?cursor=${cursor}` : "";
          const response = await fetch(`/api/ai/jobs/${jobId}/stream${query}`, {
            headers: { Accept: "text/event-stream" },
            signal: controller.signal,
          });
          const lastUpdate = await consumeAiQuestionStream(
            response,
            (update) => {
              if (update.cursor !== undefined) cursor = update.cursor;
              updateLiveAiQuestion(optimisticId, update);
            },
          );
          if (
            lastUpdate?.status === "completed" ||
            lastUpdate?.status === "failed"
          ) {
            return;
          }
          throw new Error("AI answer stream ended before completion");
        } catch {
          if (controller.signal.aborted) return;
          reconnects += 1;
          if (reconnects > 5) break;
          setLiveAiQuestions((questions) =>
            questions.map((question) =>
              question.id === optimisticId &&
              !["completed", "failed"].includes(question.status)
                ? {
                    ...question,
                    progress: "Live updates disconnected; reconnecting…",
                    status: "running",
                  }
                : question,
            ),
          );
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(4_000, 250 * 2 ** reconnects)),
          );
        }
      }
      if (!controller.signal.aborted) {
        setLiveAiQuestions((questions) =>
          questions.map((question) =>
            question.id === optimisticId &&
            !["completed", "failed"].includes(question.status)
              ? {
                  ...question,
                  progress: "Live updates unavailable; still working…",
                  status: "running",
                }
              : question,
          ),
        );
      }
    } finally {
      if (aiQuestionStreams.current.get(optimisticId) === controller) {
        aiQuestionStreams.current.delete(optimisticId);
      }
      void aiQuestions.refetch();
      void aiUsage.refetch();
    }
  }

  /** Sends the current line-focused question to the isolated AI reviewer. */
  function askAiQuestion(quickQuestion?: string) {
    if (
      !activeUnit ||
      aiQuestionLine === undefined ||
      !(quickQuestion ?? aiQuestionDraft).trim() ||
      !canAskAi
    ) {
      return;
    }
    const question = (quickQuestion ?? aiQuestionDraft).trim();
    const focusLine = aiQuestionLine;
    const threadId = aiQuestionThreadId ?? crypto.randomUUID();
    if (!aiQuestionThreadId) setAiQuestionThreadId(threadId);
    const optimisticId = `pending-${crypto.randomUUID()}`;
    setLiveAiQuestions((questions) => [
      ...questions,
      {
        error: null,
        focusLine,
        id: optimisticId,
        progress: "Sending question…",
        question,
        result: null,
        status: "queued",
        threadId,
      },
    ]);
    setAiQuestionDraft("");
    startAiQuestion.mutate(
      {
        pullRequestId: initialData.pullRequest.id,
        unitId: activeUnit.id,
        kind: "explain",
        question,
        focusLine,
        threadId,
      },
      {
        onSuccess: (job) => {
          setLiveAiQuestions((questions) =>
            questions.map((entry) =>
              entry.id === optimisticId
                ? {
                    ...entry,
                    jobId: job.id,
                    progress: "Waiting for the AI reviewer…",
                    status: job.status === "running" ? "running" : "queued",
                  }
                : entry,
            ),
          );
          void streamAiQuestion(job.id, optimisticId);
          void aiQuestions.refetch();
        },
        onError: (error) => {
          setLiveAiQuestions((questions) =>
            questions.map((entry) =>
              entry.id === optimisticId
                ? {
                    ...entry,
                    error: error.message,
                    progress: "Question was not sent",
                    status: "failed",
                  }
                : entry,
            ),
          );
          showAiStartError(error);
        },
      },
    );
  }

  /** Starts a complete evidence-based review of the pull request. */
  function reviewPullRequestWithAi() {
    if (reviewRunning) return;
    setAiReviewDialogOpen(false);
    startPullRequestReview.mutate({
      pullRequestId: initialData.pullRequest.id,
      kind: "review",
    });
  }

  /** Asks the model to regroup this layout once the reviewer has agreed. */
  function improveGroupingWithAi() {
    if (groupingImproving || !initialData.conceptLayout) return;
    setConceptGroupingDialogOpen(false);
    setConceptLayoutAction("improve");
    improveConceptGrouping.mutate({
      pullRequestId: initialData.pullRequest.id,
      layoutId: initialData.conceptLayout.id,
      layoutVersion: initialData.conceptLayout.version,
    });
  }

  /** Splits the active concept into atomic personal-layout concepts. */
  function splitActiveConcept() {
    if (
      !activeConcept ||
      activeConcept.memberIds.length < 2 ||
      !initialData.snapshot ||
      !initialData.conceptLayout ||
      conceptLayoutLocked
    ) {
      return;
    }
    setSplitConceptDialogOpen(false);
    setConceptLayoutAction("split");
    replaceConceptLayout.mutate({
      pullRequestId: initialData.pullRequest.id,
      snapshotId: initialData.snapshot.id,
      expectedVersion: initialData.conceptLayout.version,
      source: "manual",
      concepts: initialData.concepts.flatMap((concept) =>
        concept.id === activeConcept.id
          ? concept.memberIds.map((memberId) => {
              const member = units.find(({ id }) => id === memberId);
              return {
                title: member?.name ?? "Review change",
                rationale: `Manually split from ${activeConcept.title}.`,
                memberUnitIds: [memberId],
              };
            })
          : [
              {
                title: concept.title,
                rationale: concept.rationale ?? undefined,
                memberUnitIds: concept.memberIds,
              },
            ],
      ),
    });
  }

  /** Moves the active atomic member into the concept the reviewer picked. */
  function moveActiveMemberToConcept(targetConceptId: string) {
    if (
      !activeUnit ||
      !activeConcept ||
      initialData.concepts.length < 2 ||
      !initialData.snapshot ||
      !initialData.conceptLayout ||
      conceptLayoutLocked
    ) {
      return;
    }
    const target = initialData.concepts.find(
      ({ id }) => id === targetConceptId,
    );
    if (!target || target.id === activeConcept.id) return;
    setMoveMemberDialogOpen(false);
    setConceptLayoutAction("move");
    replaceConceptLayout.mutate({
      pullRequestId: initialData.pullRequest.id,
      snapshotId: initialData.snapshot.id,
      expectedVersion: initialData.conceptLayout.version,
      source: "manual",
      concepts: initialData.concepts.flatMap((concept) => {
        if (concept.id === activeConcept.id) {
          const remaining = concept.memberIds.filter(
            (id) => id !== activeUnit.id,
          );
          return remaining.length > 0
            ? [
                {
                  title: concept.title,
                  rationale: concept.rationale ?? undefined,
                  memberUnitIds: remaining,
                },
              ]
            : [];
        }
        return [
          {
            title: concept.title,
            rationale:
              concept.id === target.id
                ? `Manually includes ${activeUnit.name}.`
                : (concept.rationale ?? undefined),
            memberUnitIds:
              concept.id === target.id
                ? [...concept.memberIds, activeUnit.id]
                : concept.memberIds,
          },
        ];
      }),
    });
  }

  /** Runs the status-appropriate action for the active review unit. */
  function runPrimaryAction() {
    if (!activeUnit || !canUsePrimaryAction) return;
    if (activeWaitStatus === "signed_off" || activeWaitStatus === "waiting") {
      continueReview();
      return;
    }
    if (onLastConceptMember) {
      signOffActiveConcept();
      return;
    }
    signOffActiveUnit();
  }

  /**
   * Records the open unit and moves on to the next one in its concept.
   *
   * The concept is read one member at a time, so the unit the reviewer just
   * finished is the natural thing to record: the next member is preferred over
   * the canonical order, which keeps a concept together instead of scattering
   * a reviewer across the pull request between its members.
   */
  function signOffActiveUnit() {
    if (!activeUnit || !canSignOffUnit) return;
    const memberIds = new Set(activeConcept?.memberIds ?? []);
    optimisticallyQueueSignOffs(
      [
        {
          unitId: activeUnit.id,
          sessionId,
          durationSeconds: Math.round((Date.now() - startedAt) / 1000),
        },
      ],
      (unit) => memberIds.has(unit.id),
    );
  }

  /** Records every member of the open concept in one go. */
  function signOffActiveConcept() {
    if (!canSignOffConcept || !activeConcept || !initialData.conceptLayout) {
      return;
    }
    const concept = activeConcept;
    const layout = initialData.conceptLayout;
    const previousMembers = units.filter((unit) =>
      concept.memberIds.includes(unit.id),
    );
    const view = reviewViewSnapshot({ unitIndex: activeIndex });
    const updated = optimisticallySignOffReviewUnits(units, concept.memberIds);
    const nextIndex = nextReviewIndexAfterAction(updated);
    setSignOffUndoHistory((history) =>
      rememberSignOff(history, {
        kind: "concept",
        conceptId: concept.id,
        label: concept.title,
        layoutId: layout.id,
        layoutVersion: layout.version,
        unitIds: concept.memberIds,
        view,
      }),
    );
    setPendingConceptSignOffIds((current) => new Set(current).add(concept.id));
    setUnits(updated);
    if (nextIndex >= 0) setActiveIndex(nextIndex);
    setQueueLimit(INITIAL_PATH_ITEMS);
    setShowDiff(true);
    setContextBefore(0);
    setContextAfter(0);
    codeScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    setStartedAt(Date.now());

    void signOffConcept
      .mutateAsync({
        conceptId: concept.id,
        layoutId: layout.id,
        layoutVersion: layout.version,
        sessionId,
        durationSeconds: Math.round((Date.now() - startedAt) / 1000),
      })
      .then(({ signedUnitIds }) => {
        void Promise.all([
          utils.workspace.guidance.invalidate(),
          utils.review.dashboard.invalidate(),
          utils.review.gamification.invalidate(),
        ]);
        toast.success("Review concept signed off", {
          description: `${signedUnitIds.length} atomic ${signedUnitIds.length === 1 ? "unit" : "units"} recorded together.`,
        });
      })
      .catch((error: Error) => {
        setUnits((current) =>
          previousMembers.reduce(
            (restored, original) =>
              restoreReviewUnitAfterFailedSignOff(restored, original),
            current,
          ),
        );
        setSignOffUndoHistory((history) => {
          const index = history.findIndex(
            (entry) =>
              entry.kind === "concept" && entry.conceptId === concept.id,
          );
          return index < 0
            ? history
            : history.filter((_entry, entryIndex) => entryIndex !== index);
        });
        restoreReviewView(view, concept.memberIds);
        toast.error("Concept sign-off was not saved", {
          description: `Returned to ${concept.title}. ${error.message}`,
        });
      })
      .finally(() => {
        setPendingConceptSignOffIds((current) => {
          const pending = new Set(current);
          pending.delete(concept.id);
          return pending;
        });
      });
  }

  /** Captures where the reviewer is, so undoing a sign-off can return there. */
  function reviewViewSnapshot(
    at: { unitIndex: number } & Partial<ReviewViewSnapshot>,
  ): ReviewViewSnapshot {
    return {
      contextAfter: at.contextAfter ?? contextAfter,
      contextBefore: at.contextBefore ?? contextBefore,
      pathSearch: at.pathSearch ?? pathSearch,
      scrollTop: at.scrollTop ?? codeScrollRef.current?.scrollTop ?? 0,
      searchLimit: at.searchLimit ?? searchLimit,
      showDiff: at.showDiff ?? showDiff,
      unitIndex: at.unitIndex,
    };
  }

  /**
   * Puts the reviewer back in front of the unit a sign-off was made from.
   *
   * The recorded position is an index into the list as it stood, and a resync
   * or a regrouping can shorten that list. The units the step named are what
   * still identify the place, so the index is only honoured while it points at
   * one of them.
   */
  function restoreReviewView(view: ReviewViewSnapshot, unitIds: string[]) {
    const surviving = unitIds.flatMap((unitId) => {
      const index = units.findIndex(({ id }) => id === unitId);
      return index >= 0 ? [index] : [];
    });
    setActiveIndex(
      surviving.includes(view.unitIndex)
        ? view.unitIndex
        : (surviving[0] ??
            Math.min(
              Math.max(0, view.unitIndex),
              Math.max(0, units.length - 1),
            )),
    );
    if (view.pathSearch.trim()) {
      setPathSearch((current) => (current.trim() ? current : view.pathSearch));
      setSearchLimit(view.searchLimit);
    }
    setShowDiff(view.showDiff);
    setContextBefore(view.contextBefore);
    setContextAfter(view.contextAfter);
    setStartedAt(Date.now());
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        codeScrollRef.current?.scrollTo({
          top: view.scrollTop,
          behavior: "auto",
        });
      }),
    );
  }

  /**
   * Takes back the most recent sign-off that still stands.
   *
   * Sign-offs are saved through a queue, so undo waits for that queue to
   * drain rather than racing a save it would have to undo twice. Steps whose
   * units a resync removed, or which some other action already returned to
   * the queue, are dropped instead of replayed.
   */
  async function undoLastSignOff() {
    // A mutation's pending flag only reaches this closure on the next render,
    // so a held shortcut would otherwise take the same step back twice.
    if (!undoableSignOff || !canUndoSignOff || undoInFlight.current) return;
    undoInFlight.current = true;
    setUndoPending(true);
    const { entry, remaining } = undoableSignOff;
    setSignOffUndoHistory(remaining);
    restoreReviewView(entry.view, entry.unitIds);
    const target = signOffUndoTarget(
      entry,
      initialData.conceptLayout ?? undefined,
    );
    try {
      if (target.kind === "concept") {
        await undoConcept.mutateAsync({ ...target, sessionId });
        return;
      }
      // A concept whose layout was replaced is given back one unit at a time,
      // and the reviewer asked for one undo, so only the last of them speaks.
      for (const [index, unitId] of target.unitIds.entries()) {
        if (index < target.unitIds.length - 1) {
          quietUndoUnitIds.current.add(unitId);
        }
        await undoSignOff.mutateAsync({ unitId, sessionId });
      }
    } catch {
      // The mutation owns the user-facing error. The step goes back on the
      // history so the reviewer can take it back again rather than being left
      // with a sign-off standing and nothing left to undo it from.
      setSignOffUndoHistory((history) => rememberSignOff(history, entry));
    } finally {
      // A loop that stopped early would otherwise leave units marked quiet,
      // and the next undo of one of them would succeed without saying so.
      quietUndoUnitIds.current.clear();
      undoInFlight.current = false;
      setUndoPending(false);
    }
  }

  /** Pauses the open unit until its own conversation moves. */
  function awaitActiveUnit() {
    if (!activeUnit || !canAwaitUnit) return;
    awaitResponse.mutate({ unitId: activeUnit.id });
  }

  /** Pauses the open unit until its conversation or code changes. */
  function awaitActiveResponse() {
    awaitActiveUnit();
  }

  /** Signs off every outstanding unit from files removed by this pull request. */
  function signOffDeletedFiles() {
    if (!canSignOffDeletedFiles) return;
    const activeDuration = Math.round((Date.now() - startedAt) / 1000);
    optimisticallyQueueSignOffs(
      deletedUnitsToSignOff.map((unit) => ({
        unitId: unit.id,
        sessionId,
        durationSeconds: unit.id === activeUnit?.id ? activeDuration : 0,
      })),
      (unit) => unit.changeType !== "deleted",
    );
  }

  /**
   * Gives back the wait the open unit is holding.
   *
   * Only the reviewer releases a wait: when the provider answers, the
   * workspace marks the unit as answered and this same action resumes it
   * with the response still on screen. It equally frees a unit paused by
   * mistake or answered somewhere the poll cannot see.
   */
  function stopWaitingOnActive() {
    if (!canStopWaiting) return;
    releaseReviewWaits.mutate({ unitIds: heldWaitUnitIds });
  }

  /** Opens a unit selected from the waiting room. */
  function openWaitingUnit(unitId: string) {
    const index = unitIndexById.get(unitId) ?? -1;
    if (index < 0) return;
    setWaitingCompletionOpen(false);
    setWaitingExpanded(true);
    selectUnit(index);
  }

  /** Returns one waiting unit to the actionable review path. */
  function stopWaitingOnUnit(unitId: string) {
    if (releaseReviewWaits.isPending) return;
    setReleasingWaitingUnitId(unitId);
    releaseReviewWaits.mutate({ unitIds: [unitId] });
  }

  /** Returns the active signed-off unit to the pending review queue. */
  function unreviewActiveUnit() {
    if (
      activeConcept &&
      initialData.conceptLayout &&
      activeConceptProgress?.status === "signed_off"
    ) {
      undoConcept.mutate({
        conceptId: activeConcept.id,
        layoutId: initialData.conceptLayout.id,
        layoutVersion: initialData.conceptLayout.version,
        sessionId,
      });
      return;
    }
    if (activeUnit?.status !== "signed_off") return;
    undoSignOff.mutate({
      unitId: activeUnit.id,
      sessionId,
    });
  }

  /** Brings a finding with no line of its own into the code viewport. */
  const revealDetachedFinding = useCallback((findingId: string) => {
    // Two frames, because the layout effect that pins a freshly selected unit
    // to the top of the pane runs first and would scroll this card away.
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        const card = document.getElementById(`finding-${findingId}`);
        if (!card) {
          codeScrollRef.current?.scrollTo({ top: 0 });
          return;
        }
        card.scrollIntoView({ block: "center" });
        card.focus({ preventScroll: true });
      }),
    );
  }, []);

  /**
   * Opens one deep-review finding beside the code it accuses.
   *
   * Every target kind ends somewhere the body can be read: a line lights
   * amber, a file opens with no line lit, and a finding that resolves nowhere
   * still expands above the diff.
   */
  function openFinding(finding: DeepReviewFinding, locationIndex = 0) {
    setActiveFindingId(finding.id);
    setActiveFindingLocationIndex(locationIndex);
    const target = deepReviewFindingTarget(finding, units, locationIndex);
    if (target.kind === "nowhere") {
      setFindingLine(undefined);
      setPendingFindingReveal(undefined);
      revealDetachedFinding(finding.id);
      return;
    }
    // Guarded on the index: `selectUnit` wipes the revealed context, the
    // import preview and the path panel, and restarts the unit timer, none of
    // which a finding in the file already open has any business doing.
    if (target.unitIndex !== activeIndex) selectUnit(target.unitIndex);
    const unitId = units[target.unitIndex]?.id;
    if (target.kind === "unit" || !unitId) {
      setFindingLine(undefined);
      setPendingFindingReveal(undefined);
      revealDetachedFinding(finding.id);
      return;
    }
    setFindingLine(target.line);
    setPendingFindingReveal({
      exhausted: false,
      fallbackUsed: false,
      findingId: finding.id,
      line: target.line,
      unitId,
    });
  }

  /** Opens the neighbouring finding in the order the index is read in. */
  function stepFinding(delta: 1 | -1) {
    if (visibleFindings.length === 0) return;
    const current = visibleFindings.findIndex(
      ({ id }) => id === activeFindingId,
    );
    // No wrapping: the ends of a triage list are information, and a silent
    // jump back to the top reads as "nothing happened".
    const next =
      current < 0
        ? delta === 1
          ? 0
          : visibleFindings.length - 1
        : Math.min(Math.max(current + delta, 0), visibleFindings.length - 1);
    const finding = visibleFindings[next];
    if (!finding) return;
    openFinding(finding);
    window.requestAnimationFrame(() =>
      findingsListRef.current
        ?.querySelector<HTMLElement>(`[data-finding-row="${finding.id}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
  }

  /** Collapses the open finding back to its index row and returns focus. */
  function collapseFinding(findingId: string) {
    setActiveFindingId(undefined);
    setFindingLine(undefined);
    setPendingFindingReveal(undefined);
    findingsListRef.current
      ?.querySelector<HTMLElement>(`[data-finding-row="${findingId}"]`)
      ?.focus();
  }

  /** Turns one severity chip on or off without disturbing the others. */
  function toggleFindingSeverity(severity: string) {
    setFindingSeverityFilter((current) => {
      const next = new Set(current);
      if (!next.delete(severity)) next.add(severity);
      return next;
    });
  }

  /** Reports whether a finding already reached the pull request. */
  function findingPublished(finding: DeepReviewFinding) {
    // Two readings of one fact keyed the same way: the run-wide set tells the
    // truth about every file at once, and the per-unit discussion refetches
    // the instant a publish succeeds.
    return (
      publishedFindingIds.has(finding.id) ||
      (discussion.data?.comments.some(
        (comment) =>
          comment.aiJobId === deepReview.data?.jobId &&
          comment.aiFindingIndex === finding.orderIndex &&
          comment.status === "published",
      ) ??
        false)
    );
  }

  /** Opens inline commenting at the first eligible source line. */
  function beginKeyboardComment() {
    if (!activeUnit) return;
    const firstChangedLine = [...changedCurrentLines]
      .filter(isPrimaryReviewLine)
      .sort((left, right) => left - right)[0];
    setKeyboardLine(selectedLine ?? firstChangedLine ?? primaryReviewStart);
    setSelectedLine(undefined);
    setFeedback("");
  }

  /** Moves keyboard focus to the review-path search field. */
  function focusReviewSearch() {
    const search = pathSearchRef.current;
    if (search && search.offsetParent !== null) {
      search.focus();
      return;
    }
    openCommands();
  }

  /**
   * Reveals the next page of source preceding the reviewed unit.
   *
   * The side-by-side view pages its own rows, so it is offered the reveal
   * first and the surrounding-source counter only moves when it declines.
   * One shortcut then means the same thing in either view.
   */
  function revealContextAbove() {
    if (diffContextRef.current?.revealContext(-1)) return;
    setContextBefore((current) =>
      Math.min(current + CONTEXT_PAGE_LINES, availableBefore),
    );
  }

  /** Reveals the next page of source following the reviewed unit. */
  function revealContextBelow() {
    if (diffContextRef.current?.revealContext(1)) return;
    setContextAfter((current) =>
      Math.min(current + CONTEXT_PAGE_LINES, availableAfter),
    );
  }

  /**
   * Scrolls the code viewport.
   *
   * Revealing surrounding context is deliberately left to its own controls: a
   * concept shows many atomic units at once, and expanding one of them because
   * the reader happened to reach an edge made a unit appear to contain code
   * that belongs to the next one.
   */
  function scrollCode(direction: -1 | 1) {
    codeScrollRef.current?.scrollBy({ top: direction * 72, behavior: "auto" });
  }

  /** Renders direct AI controls without hiding their distinct scopes in a menu. */
  function renderAiActionButtons() {
    const aiDisabled = aiConfiguration.data?.mode === "off";
    return (
      <div
        className={cn(
          "grid w-full gap-2",
          deepReviewAvailable ? "grid-cols-2" : "grid-cols-1",
        )}
      >
        <Button
          type="button"
          variant="secondary"
          className="min-w-0 px-2.5"
          disabled={aiDisabled || !activeUnit || activeUnit.kind === "binary"}
          onClick={openAiQuestion}
        >
          <MessageSquareText className="size-3.5 shrink-0" />
          <span className="truncate">Ask</span>
          <ShortcutHint
            shortcut={reviewShortcuts.askAi}
            className="ml-auto hidden sm:inline-flex"
          />
        </Button>
        {deepReviewAvailable && (
          <Button
            type="button"
            variant="secondary"
            className="min-w-0 px-2.5"
            disabled={aiDisabled || reviewRunning}
            onClick={() => setAiReviewDialogOpen(true)}
          >
            {reviewRunning ? (
              <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
            ) : (
              <Sparkles className="size-3.5 shrink-0" />
            )}
            <span className="truncate">
              {reviewRunning ? "Reviewing…" : "Review"}
            </span>
            <ShortcutHint
              shortcut={reviewShortcuts.reviewPullRequest}
              className="ml-auto hidden sm:inline-flex"
            />
          </Button>
        )}
      </div>
    );
  }

  /**
   * Opens the author's own account of the change beside the AI controls.
   *
   * The wide panel names the control, because an unlabelled icon under an
   * "AI assistance" heading reads as an explanation of that heading rather
   * than of the pull request.
   */
  function renderPullRequestDetailsButton({
    className,
    label,
  }: {
    className: string;
    label?: string;
  }) {
    return (
      <button
        type="button"
        aria-label="About this pull request"
        title="About this pull request"
        onClick={() => setPullRequestDetailsOpen(true)}
        className={cn(
          "text-mist hover:text-cloud flex shrink-0 items-center justify-center gap-1.5 rounded-lg transition hover:bg-surface-hover",
          className,
        )}
      >
        <Info className="size-4 shrink-0" />
        {label}
      </button>
    );
  }

  /** Renders the deep review's terminal state, coverage, and findings. */
  function renderDeepReviewPanel() {
    const run = deepReview.data;
    if (!run) {
      return reviewRunning ? (
        <section
          aria-label="Deep review"
          className="mt-5 border-t border-line pt-4"
        >
          <p className="text-violet text-[10px] leading-4">
            Deep review is starting. Coverage appears once the file plan is
            sealed.
          </p>
        </section>
      ) : null;
    }
    const findings = run.findings;
    // The open finding stays open when a filter change would hide it: the
    // reviewer is mid-judgement on that claim, and a filter is not a verdict.
    const activeFindingHidden = Boolean(
      activeFindingId &&
        !visibleFindings.some(({ id }) => id === activeFindingId),
    );
    // Falls back to the first row when the open finding is filtered out, or
    // Tab would find no stop at all and the list would stop being reachable.
    const rovingFindingId = activeFindingHidden
      ? visibleFindings[0]?.id
      : (activeFindingId ?? visibleFindings[0]?.id);
    const running = aiJobActive(run.status);
    const terminal = run.terminalState
      ? deepReviewTerminalCopy[run.terminalState]
      : undefined;
    // The run failed when coverage says so, or when the parent job itself died
    // before it could record a terminal state at all.
    const runFailed = run.terminalState === "failed" || run.status === "failed";
    const reviewed = run.coverage.completed + run.coverage.reused;
    return (
      <section
        aria-label="Deep review"
        className="mt-5 border-t border-line pt-4"
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
            Deep review
          </p>
          {running ? (
            <span className="text-violet inline-flex items-center gap-1.5 text-[10px]">
              <LoaderCircle className="size-3 animate-spin" />
              {run.status.replace(/_/g, " ")}
            </span>
          ) : (
            terminal && (
              <Badge
                className={cn(
                  "px-2 py-0.5 text-[9px] tracking-wider uppercase",
                  runFailed &&
                    "border-red-500/35 bg-red-500/10 text-red-700 dark:text-red-200",
                  run.terminalState === "partial" &&
                    "border-amber-500/35 bg-amber-400/10 text-amber-800 dark:text-amber-200",
                  run.terminalState === "complete" &&
                    "border-lime/25 bg-lime/[.08] text-lime",
                )}
              >
                {terminal.label}
              </Badge>
            )
          )}
        </div>
        {!running && runFailed && (
          <div
            role="status"
            className="mt-3 rounded-lg border border-red-500/20 bg-red-400/10 p-3 text-red-700 dark:border-red-300/15 dark:text-red-200"
          >
            <p className="text-xs font-medium">Deep review failed</p>
            <p className="mt-1 text-[11px] leading-5 opacity-80">
              {/* The classified cause is the specific one; `run.error` is the
                  fallback for a parent that died before finalize could set a
                  class, routed through the same remediation copy the explain
                  panel uses. */}
              {(run.runFailureClass
                ? reviewFailureClassCopy[run.runFailureClass]
                : undefined) ??
                (run.error
                  ? aiErrorPresentation(run.error).detail
                  : "No selected file was reviewed.")}
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={reviewRunning}
              onClick={() => setAiReviewDialogOpen(true)}
              className="mt-2 h-7 border border-red-500/15 px-2.5 text-[10px] text-current hover:bg-red-500/10"
            >
              <RefreshCw className="size-3" />
              Run it again
            </Button>
          </div>
        )}
        {!running &&
          !runFailed &&
          terminal &&
          run.terminalState !== "complete" && (
            <p className="text-mist mt-2 text-[11px] leading-5">
              {terminal.detail}
            </p>
          )}
        <button
          type="button"
          aria-expanded={coverageOpen}
          onClick={() => setCoverageOpen((open) => !open)}
          className="text-mist hover:bg-surface-subtle hover:text-cloud mt-3 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[10px] transition"
        >
          {coverageOpen ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          <span>
            {/* Files, not units. A unit is a symbol, and this workspace shows
                423 of them across 56 files, so "units" here read as a much
                smaller review than the one actually running. */}
            Coverage {reviewed}/{run.coverage.total}{" "}
            {run.coverage.total === 1 ? "file" : "files"}
            {run.coverage.failed > 0 ? ` · ${run.coverage.failed} failed` : ""}
            {run.coverage.waived > 0 ? ` · ${run.coverage.waived} waived` : ""}
          </span>
        </button>
        {/* `grid-cols-1` pins the track to the panel width. An implicit track
            is sized by its widest item, so one deep source path made every row
            wider than the column and the list overflowed its own panel. */}
        {coverageOpen && (
          <ul className="mt-1 grid grid-cols-1 gap-0.5">
            {run.items.map((item) => (
              <li
                key={item.id}
                className="flex min-w-0 items-start justify-between gap-2 rounded-lg px-2 py-1"
              >
                <span className="min-w-0 flex-1">
                  <span className="text-mist block truncate font-mono text-[9px]">
                    {item.kind === "survey" ? "Whole pull request" : item.path}
                  </span>
                  {item.reason && (
                    <span className="text-fog mt-0.5 block text-[9px] leading-4">
                      {item.reason}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "text-fog shrink-0 text-[9px]",
                    item.state === "failed" && "text-red-700 dark:text-red-200",
                  )}
                >
                  {deepReviewItemStateCopy[item.state] ?? item.state}
                </span>
              </li>
            ))}
          </ul>
        )}
        {findings.length === 0 ? (
          !running && (
            <p className="text-mist mt-3 text-[11px] leading-5">
              No findings were surfaced.
            </p>
          )
        ) : (
          <>
            {/* Doubles as the legend for the rails in the list below, which is
                why all four render whether or not the run produced any. */}
            <div className="mt-3 flex h-7 flex-wrap items-center gap-1">
              {deepReviewFacetCounts(
                findings,
                "severity",
                findingSeverities,
              ).map(({ value, count }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={findingSeverityFilter.has(value)}
                  onClick={() => toggleFindingSeverity(value)}
                  className={cn(
                    "rounded-md border px-1.5 py-0.5 text-[9px] tracking-wider uppercase transition",
                    findingSeverityFilter.has(value)
                      ? (findingSeverityStyle[value] ?? "")
                      : "text-fog border-line",
                  )}
                >
                  {findingSeverityChipLabel[value]} {count}
                </button>
              ))}
            </div>
            <div className="mt-1.5 h-7">
              <select
                aria-label="Filter findings by category"
                value={findingCategoryFilter}
                onChange={(event) =>
                  setFindingCategoryFilter(event.target.value)
                }
                className="bg-surface text-cloud h-7 w-full rounded-lg border border-line px-2 text-[10px] outline-none"
              >
                <option value="all">All ({findings.length})</option>
                {deepReviewFacetCounts(findings, "category", findingCategories)
                  .filter(({ count }) => count > 0)
                  .map(({ value, count }) => (
                    <option key={value} value={value}>
                      {value} ({count})
                    </option>
                  ))}
              </select>
            </div>
            {/* Opaque, not `bg-surface/55`: the aside is translucent above
                `xl`, and a see-through sticky header ghosts the rows that
                scroll behind it. */}
            <div
              ref={findingsListRef}
              className="mt-3 max-h-[min(52vh,560px)] overflow-y-auto rounded-xl border border-line bg-surface"
            >
              {activeFindingHidden && (
                <div className="text-fog sticky top-0 z-20 flex h-6 items-center gap-1.5 bg-surface px-1.5 text-[9px]">
                  <span className="truncate">
                    1 open finding hidden by this filter
                  </span>
                  <span aria-hidden="true">·</span>
                  <button
                    type="button"
                    onClick={() => {
                      setFindingSeverityFilter(new Set());
                      setFindingCategoryFilter("all");
                    }}
                    className="text-violet hover:bg-surface-subtle shrink-0 rounded px-1"
                  >
                    Clear
                  </button>
                </div>
              )}
              {findingGroups.map((group) => (
                <div key={`${group.kind}-${group.label}`}>
                  <div
                    className={cn(
                      "sticky z-10 flex h-5 min-w-0 items-baseline gap-1.5 bg-surface px-1.5",
                      // Clears the pinned notice above it, which is 24px tall.
                      activeFindingHidden ? "top-6" : "top-0",
                    )}
                  >
                    {group.kind === "file" ? (
                      <>
                        <span className="text-fog truncate font-mono text-[9px]">
                          {group.label.slice(
                            0,
                            group.label.lastIndexOf("/") + 1,
                          )}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 font-mono text-[9px]",
                            group.path === activeUnit?.path
                              ? "text-cloud"
                              : "text-mist",
                          )}
                        >
                          {group.label.slice(group.label.lastIndexOf("/") + 1)}
                        </span>
                      </>
                    ) : (
                      <span className="text-mist truncate font-mono text-[9px]">
                        {group.label}
                      </span>
                    )}
                    <span className="text-fog ml-auto shrink-0 text-[9px]">
                      {group.findings.length}
                    </span>
                  </div>
                  <ul aria-label={group.label}>
                    {group.findings.map((finding) => (
                      <li key={finding.id}>
                        <DeepReviewFindingRow
                          finding={finding}
                          active={finding.id === activeFindingId}
                          // Read off the group, so a row never disagrees with
                          // the header that is already lit above it.
                          inActiveUnit={group.path === activeUnit?.path}
                          published={findingPublished(finding)}
                          // Roving: Tab reaches the list once instead of
                          // paying forty stops to cross it.
                          tabIndex={finding.id === rovingFindingId ? 0 : -1}
                          onOpen={() => openFinding(finding)}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {visibleFindings.length === 0 && (
                <p className="text-mist px-1.5 py-2 text-[11px] leading-5">
                  No finding matches this filter.
                </p>
              )}
            </div>
          </>
        )}
      </section>
    );
  }

  const unitCommands = useMemo(
    () =>
      units.map(
        (unit, index): CommandCenterItem => ({
          id: `unit-${unit.id}`,
          label: `Open ${unit.name}`,
          description: `${unit.path} · ${unit.kind.replace("_", " ")} · ${unit.status.replace("_", " ")}`,
          group: "Review units",
          keywords: [unit.path, unit.kind, unit.status, String(index + 1)],
          icon: unitCommandIcon,
          disabled: index === activeIndex,
          searchOnly: true,
          onSelect: () => selectUnit(index),
        }),
      ),
    [activeIndex, selectUnit, units],
  );
  const reviewPullRequestCommand: CommandCenterItem = {
    id: "review-pull-request-with-ai",
    label: "Review the full pull request",
    description:
      aiConfiguration.data?.mode === "off"
        ? "Enable AI assistance in settings first"
        : "Inspect every changed file and surface actionable findings",
    group: "Review actions",
    icon: <Sparkles className="size-4" />,
    shortcut: reviewShortcuts.reviewPullRequest,
    disabled: reviewRunning || aiConfiguration.data?.mode === "off",
    onSelect: () => setAiReviewDialogOpen(true),
  };
  const reviewCommands: CommandCenterItem[] = [
    {
      id: "toggle-review-path",
      label: "Toggle review path",
      description: "Show or hide the left review navigation panel",
      group: "Review navigation",
      icon: <PanelLeftOpen className="size-4" />,
      shortcut: reviewShortcuts.togglePathPanel,
      onSelect: togglePathPanel,
    },
    {
      id: "toggle-ai-assistance",
      label: "Toggle AI assistance",
      description: "Show or hide the right explanation and usage panel",
      group: "Review navigation",
      icon: <PanelRightOpen className="size-4" />,
      shortcut: reviewShortcuts.toggleInsightsPanel,
      onSelect: toggleInsightsPanel,
    },
    {
      id: "scroll-code-down",
      label:
        aiQuestionLine === undefined
          ? "Scroll code down"
          : "Move AI question down",
      description:
        aiQuestionLine === undefined
          ? "Move down through the code view"
          : "Focus the next visible in-scope line",
      group: "Review navigation",
      icon: <ChevronDown className="size-4" />,
      shortcut: reviewShortcuts.scrollDown,
      onSelect: () =>
        aiQuestionLine === undefined ? scrollCode(1) : stepAiQuestion(1),
    },
    {
      id: "scroll-code-up",
      label:
        aiQuestionLine === undefined ? "Scroll code up" : "Move AI question up",
      description:
        aiQuestionLine === undefined
          ? "Move up through the code view"
          : "Focus the previous visible in-scope line",
      group: "Review navigation",
      icon: <ChevronDown className="size-4 rotate-180" />,
      shortcut: reviewShortcuts.scrollUp,
      onSelect: () =>
        aiQuestionLine === undefined ? scrollCode(-1) : stepAiQuestion(-1),
    },
    {
      id: "reveal-context-below",
      label: "Show more lines below",
      description: "Reveal the source that follows the reviewed unit",
      group: "Review navigation",
      icon: <ChevronDown className="size-4" />,
      shortcut: reviewShortcuts.revealContextBelow,
      disabled:
        !sideBySideVisible &&
        (!contextAvailable || contextAfter >= availableAfter),
      onSelect: revealContextBelow,
    },
    {
      id: "reveal-context-above",
      label: "Show more lines above",
      description: "Reveal the source that precedes the reviewed unit",
      group: "Review navigation",
      icon: <ChevronDown className="size-4 rotate-180" />,
      shortcut: reviewShortcuts.revealContextAbove,
      disabled:
        !sideBySideVisible &&
        (!contextAvailable || contextBefore >= availableBefore),
      onSelect: revealContextAbove,
    },
    {
      id: "next-unit",
      label: "Select next unit",
      description: "Select the next atomic unit in this concept",
      group: "Review navigation",
      icon: <ChevronDown className="size-4" />,
      shortcut: reviewShortcuts.nextUnit,
      disabled: activeConceptMemberIndex >= activeConceptMembers.length - 1,
      onSelect: () => navigateConceptMember(1),
    },
    {
      id: "previous-unit",
      label: "Select previous unit",
      description: "Select the previous atomic unit in this concept",
      group: "Review navigation",
      icon: <ChevronRight className="size-4 -rotate-90" />,
      shortcut: reviewShortcuts.previousUnit,
      disabled: activeConceptMemberIndex <= 0,
      onSelect: () => navigateConceptMember(-1),
    },
    {
      id: "next-concept",
      label: "Open next concept",
      description: "Move to the next concept in the review path",
      group: "Review navigation",
      icon: <ChevronRight className="size-4" />,
      shortcut: reviewShortcuts.nextConcept,
      disabled: activeConceptPathIndex >= initialData.concepts.length - 1,
      onSelect: () => navigateConcept(1),
    },
    {
      id: "previous-concept",
      label: "Open previous concept",
      description: "Move to the previous concept in the review path",
      group: "Review navigation",
      icon: <ChevronRight className="size-4 rotate-180" />,
      shortcut: reviewShortcuts.previousConcept,
      disabled: activeConceptPathIndex <= 0,
      onSelect: () => navigateConcept(-1),
    },
    {
      id: "next-pending-unit",
      label: "Resume the review queue",
      description: nextQueueEntry
        ? `Open ${nextQueueEntry.unit.name}, the first pending unit`
        : "No other pending units",
      group: "Review navigation",
      icon: <FileCode2 className="size-4" />,
      shortcut: reviewShortcuts.nextPending,
      disabled: !nextQueueEntry,
      onSelect: () => {
        if (nextQueueEntry) selectConceptPath(nextQueueEntry.index);
      },
    },
    {
      id: "search-review-path",
      label: "Search the review path",
      description: "Find a symbol or file in this pull request",
      group: "Review navigation",
      icon: <Search className="size-4" />,
      shortcut: reviewShortcuts.search,
      onSelect: focusReviewSearch,
    },
    {
      id: "ask-ai-inline",
      label: "Ask AI about this code",
      description:
        aiConfiguration.data?.mode === "off"
          ? "Enable AI assistance in settings first"
          : "Open a line-anchored question beside the nearest in-scope code",
      group: "Review actions",
      icon: <MessageSquareText className="size-4" />,
      shortcut: reviewShortcuts.askAi,
      disabled:
        aiConfiguration.data?.mode === "off" ||
        !activeUnit ||
        activeUnit.kind === "binary",
      onSelect: openAiQuestion,
    },
    // Omitted rather than disabled when the plan cannot run a deep review:
    // `useCommandCenterBindings` reads this same array, so leaving the entry in
    // would keep its keyboard shortcut live for an account `ai.start` refuses.
    ...(deepReviewAvailable ? [reviewPullRequestCommand] : []),
    // Registered here rather than on a listener of their own so they inherit
    // the command center's editable-target and suspended guards, which already
    // cover the line picker, the import preview and the three dialogs.
    {
      id: "next-finding",
      label: "Next finding",
      description: "Open the next deep-review finding beside its code",
      group: "Review actions",
      icon: <Sparkles className="size-4" />,
      shortcut: reviewShortcuts.nextFinding,
      disabled: visibleFindings.length === 0,
      onSelect: () => stepFinding(1),
    },
    {
      id: "previous-finding",
      label: "Previous finding",
      description: "Open the previous deep-review finding beside its code",
      group: "Review actions",
      icon: <Sparkles className="size-4" />,
      shortcut: reviewShortcuts.previousFinding,
      disabled: visibleFindings.length === 0,
      onSelect: () => stepFinding(-1),
    },
    {
      id: "comment-on-line",
      label: "Comment on a line",
      description: "Choose a line with the keyboard, then write feedback",
      group: "Review actions",
      icon: <MessageSquareText className="size-4" />,
      shortcut: reviewShortcuts.comment,
      disabled: !activeUnit || activeUnit.kind === "binary",
      onSelect: beginKeyboardComment,
    },
    {
      id: "comment-here",
      label: "Comment here",
      description: `Write a ${providerLabel(initialData.pullRequest.provider)} comment on the line in the middle of the view`,
      group: "Review actions",
      icon: <MessageSquareText className="size-4" />,
      shortcut: reviewShortcuts.commentHere,
      disabled: !activeUnit || activeUnit.kind === "binary",
      onSelect: openCentredInlineComment,
    },
    {
      id: "undo-sign-off",
      label: "Undo sign-off",
      description: undoableSignOff
        ? `Return ${undoableSignOff.entry.label} to the review path`
        : "Return the most recent sign-off to the review path",
      group: "Review actions",
      icon: <Undo2 className="size-4" />,
      shortcut: reviewShortcuts.undoSignOff,
      disabled: !canUndoSignOff,
      onSelect: undoLastSignOff,
    },
    {
      id: "toggle-context",
      label: contextVisible ? "Hide surrounding context" : "Show context",
      description: contextVisible
        ? "Return to the focused review unit"
        : "Reveal nearby lines without expanding the review scope",
      group: "Review actions",
      icon: <FileCode2 className="size-4" />,
      shortcut: reviewShortcuts.context,
      disabled: !contextAvailable || sideBySideVisible,
      onSelect: toggleContext,
    },
    {
      id: "primary-review-action",
      // The same scope the footer advertises, because this entry carries the
      // same key: on the last member owed that key commits the concept.
      label: reviewCaughtUp
        ? `View ${waitingCount} waiting ${waitingCount === 1 ? "unit" : "units"}`
        : primaryIsContinue
          ? filteredReviewActive
            ? "Continue to next match"
            : "Continue review"
          : primaryScopeLabel,
      description: reviewCaughtUp
        ? "See what must receive a reply or code change before this review can finish"
        : primaryIsContinue
          ? filteredReviewActive
            ? "Continue through the matching review units in planned order"
            : "Open the next unit that still needs review"
          : onLastConceptMember
            ? "Record the last unit this concept is owed, finishing it"
            : "Remember this unit at the current revision and open the next one",
      group: "Review actions",
      icon: reviewCaughtUp ? (
        <Clock3 className="size-4" />
      ) : (
        <Check className="size-4" />
      ),
      shortcut: reviewCaughtUp ? undefined : reviewShortcuts.signOff,
      disabled: reviewCaughtUp ? false : !canUsePrimaryAction,
      onSelect: reviewCaughtUp
        ? () => setWaitingCompletionOpen(true)
        : runPrimaryAction,
    },
    {
      id: "sign-off-concept",
      label: `Sign off concept (${activeConceptMembers.length})`,
      description: "Remember every member of this concept at once",
      group: "Review actions",
      icon: <CheckCheck className="size-4" />,
      shortcut: reviewShortcuts.signOffConcept,
      disabled: !canSignOffConcept,
      onSelect: signOffActiveConcept,
    },
    {
      id: "sign-off-deleted-files",
      label: "Sign off deletes",
      description:
        deletedUnitsToSignOff.length === 1
          ? "Sign off the remaining unit from files deleted in this pull request"
          : `Sign off ${deletedUnitsToSignOff.length} remaining units from files deleted in this pull request`,
      group: "Review actions",
      icon: <CheckCheck className="size-4" />,
      shortcut: reviewShortcuts.signOffDeletions,
      disabled: !canSignOffDeletedFiles,
      onSelect: signOffDeletedFiles,
    },
    {
      // One entry rather than two, because the binding runs the first command
      // its shortcut matches and would stop at a disabled twin. Waiting and
      // signed off never hold at once, so the state picks the wording.
      id: "unreview-unit",
      label: activeWaitStatus === "waiting" ? "Stop waiting" : "Undo review",
      description:
        activeWaitStatus === "waiting"
          ? "Take back the wait and return this work to your review path"
          : "Return this unit to the review queue",
      group: "Review actions",
      icon: <Undo2 className="size-4" />,
      shortcut: reviewShortcuts.undoReview,
      disabled:
        activeWaitStatus === "waiting"
          ? !canStopWaiting
          : activeUnit?.status !== "signed_off" ||
            activeSignOffPending ||
            undoSignOff.isPending,
      onSelect:
        activeWaitStatus === "waiting"
          ? stopWaitingOnActive
          : unreviewActiveUnit,
    },
    {
      id: "await-response",
      label: "Await unit",
      description: "Pause this unit until its code or conversation changes",
      group: "Review actions",
      icon: <Clock3 className="size-4" />,
      shortcut: reviewShortcuts.awaitResponse,
      disabled: !canAwaitUnit,
      onSelect: awaitActiveUnit,
    },

    {
      id: "sync-provider-data",
      label: updateAvailable ? "Load code changes" : "Sync",
      description: updateAvailable
        ? "Load the synced revision and preserve unaffected sign-offs"
        : "Poll for the latest code and conversations",
      group: "Review actions",
      icon: <RefreshCw className="size-4" />,
      shortcut: updateAvailable
        ? reviewShortcuts.loadChanges
        : reviewShortcuts.refresh,
      disabled:
        resetReview.isPending || (!updateAvailable && externalSyncPending),
      onSelect: updateAvailable
        ? loadAvailableChanges
        : () => void syncExternalData(),
    },
    {
      id: "reset-review",
      label: "Reset review",
      description: "Sync the latest code and clear all of your sign-offs",
      group: "Review actions",
      icon: <Undo2 className="size-4" />,
      shortcut: reviewShortcuts.reset,
      disabled:
        signOffQueue.ids.size > 0 ||
        pendingConceptSignOffIds.size > 0 ||
        externalSyncPending ||
        resetReview.isPending,
      onSelect: () => setResetDialogOpen(true),
    },
    {
      id: "next-pull-request",
      label: "Review the next pull request",
      description: nextReview
        ? `Continue with ${nextReview.repositoryOwner}/${nextReview.repositoryName} #${nextReview.number}`
        : "No other prepared pull request is waiting for review",
      group: "Navigate",
      icon: <ChevronRight className="size-4" />,
      shortcut: reviewShortcuts.nextReview,
      // The caught-up end state offers the same jump: everything reviewable is
      // done even though waiting units keep the review itself unfinished.
      disabled: (!reviewComplete && !reviewCaughtUp) || !nextReview,
      onSelect: openNextReview,
    },
    {
      id: "return-pull-requests",
      label: "Return to pull requests",
      group: "Navigate",
      icon: <ArrowLeft className="size-4" />,
      shortcut: reviewShortcuts.dashboard,
      onSelect: openPullRequests,
    },
    {
      id: "configure-ai",
      label: "Configure AI provider",
      description: "Manage assistance, providers, and model options",
      group: "Navigate",
      icon: <Sparkles className="size-4" />,
      shortcut: reviewShortcuts.aiSettings,
      onSelect: () => navigate("/settings/ai"),
    },
    ...unitCommands,
  ];
  const pendingShortcut = useCommandCenterBindings({
    commands: reviewCommands,
    onOpen: openCommands,
    onOpenShortcuts: openShortcuts,
    suspended:
      keyboardLine !== undefined ||
      importPreview !== undefined ||
      hierarchyOpen ||
      resetDialogOpen ||
      aiReviewDialogOpen ||
      conceptGroupingDialogOpen ||
      splitConceptDialogOpen ||
      pullRequestDetailsOpen ||
      moveMemberDialogOpen,
  });

  useEffect(() => {
    if (keyboardLine === undefined || !activeUnit) return;
    const pickedLine = keyboardLine;
    const target = document.getElementById(`review-line-${keyboardLine}`);
    target?.scrollIntoView({ block: "nearest" });

    /** Handles keyboard selection and cancellation for inline comments. */
    function onLinePickerKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setKeyboardLine(undefined);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setKeyboardLine((current) =>
          nextAnchorableLine(
            current ?? primaryReviewStart,
            direction,
            primaryReviewRanges,
            primaryReviewStart,
            primaryReviewEnd,
          ),
        );
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (
          lineWithinReviewRanges(
            pickedLine,
            primaryReviewRanges,
            primaryReviewStart,
            primaryReviewEnd,
          )
        ) {
          setSelectedLine(pickedLine);
        }
        setKeyboardLine(undefined);
      }
    }

    document.addEventListener("keydown", onLinePickerKeyDown);
    return () => document.removeEventListener("keydown", onLinePickerKeyDown);
  }, [
    activeUnit,
    keyboardLine,
    primaryReviewEnd,
    primaryReviewRanges,
    primaryReviewStart,
  ]);

  useEffect(() => {
    // A finding the run dropped or merged on its next poll must not keep a
    // card open from a closure that no longer describes anything.
    if (!activeFindingId || !deepReviewFindings) return;
    if (deepReviewFindings.some(({ id }) => id === activeFindingId)) return;
    setActiveFindingId(undefined);
    setFindingLine(undefined);
    setPendingFindingReveal(undefined);
  }, [activeFindingId, deepReviewFindings]);

  useEffect(() => {
    const pending = pendingFindingReveal;
    if (!pending || pending.exhausted) return;
    if (activeUnit?.id !== pending.unitId) return;
    if (activeSourceHydrationPending) return;
    let frames = 0;
    let handle = 0;

    /** Scrolls to the accused line once the unit has rendered it. */
    function attempt() {
      if (!pending) return;
      const element = document.getElementById(`review-line-${pending.line}`);
      if (element) {
        element.scrollIntoView({ block: "center", behavior: "smooth" });
        document
          .getElementById(`finding-${pending.findingId}`)
          ?.focus({ preventScroll: true });
        setPendingFindingReveal(undefined);
        return;
      }
      if (frames++ >= 20) {
        if (!pending.fallbackUsed && sideBySideVisible) {
          // The unified view renders every line of the unit; the side-by-side
          // view only emits `review-line` ids for rows inside the focus range
          // that are currently paged in.
          setShowDiff(false);
          setPendingFindingReveal({ ...pending, fallbackUsed: true });
          toast.info(
            `Showing the current source so line ${pending.line} is visible`,
          );
          return;
        }
        // Kept rather than cleared, so the card can mount detached above the
        // diff and the click still ends in something readable.
        setPendingFindingReveal({ ...pending, exhausted: true });
        revealDetachedFinding(pending.findingId);
        toast.info(`Line ${pending.line} is not rendered for this unit`, {
          description: "The finding is shown above the diff instead.",
        });
        return;
      }
      handle = window.requestAnimationFrame(attempt);
    }

    handle = window.requestAnimationFrame(attempt);
    return () => window.cancelAnimationFrame(handle);
  }, [
    activeUnit?.id,
    activeSourceHydrationPending,
    pendingFindingReveal,
    revealDetachedFinding,
    sideBySideVisible,
  ]);

  if (!initialData.snapshot || !activeUnit) {
    return (
      <main className="bg-ink grid min-h-screen place-items-center p-6 text-center">
        <div>
          <FileCode2 className="text-lime mx-auto size-8" />
          <h1 className="mt-5 text-xl font-medium">
            No reviewable symbols yet
          </h1>
          <p className="text-mist mt-2 text-sm">
            Synchronize this pull request after its first file change.
          </p>
          <Button asChild className="mt-6">
            <Link href="/pullrequests">
              <LinkPendingSpinner />
              Back to pull requests
            </Link>
          </Button>
        </div>
      </main>
    );
  }

  return (
    <div className="bg-ink fixed inset-0 flex min-h-0 flex-col overflow-hidden">
      <header className="flex h-16 items-center gap-4 border-b border-line px-4 sm:px-6">
        <Link
          href="/pullrequests"
          aria-label="Back to pull requests"
          className="text-mist hover:text-cloud grid size-9 place-items-center rounded-full transition hover:bg-surface-subtle"
        >
          <LinkNavigationStatus
            idle={<ArrowLeft className="size-4" />}
            pending={
              <LoaderCircle className="navigation-pending-reveal size-4 animate-spin" />
            }
          />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {initialData.pullRequest.title}
          </p>
          <a
            href={initialData.pullRequest.repositoryWebUrl}
            target="_blank"
            rel="noreferrer"
            title={initialData.pullRequest.repositoryWebUrl}
            className="text-fog hover:text-mist block truncate text-[10px] hover:underline"
          >
            {initialData.pullRequest.repositoryWebUrl}
          </a>
        </div>
        <div className="hidden items-center gap-3 sm:flex">
          <span className="text-mist text-xs">
            {signedConceptCount}/{initialData.concepts.length} concepts ·{" "}
            {progress}%
          </span>
          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-hover">
            <div
              role="progressbar"
              aria-label="Review progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              className="bg-lime h-full rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={
            updateAvailable
              ? loadAvailableChanges
              : () => void syncExternalData()
          }
          disabled={
            resetReview.isPending ||
            loadingChanges ||
            (!updateAvailable && externalSyncPending)
          }
          aria-label={
            updateAvailable
              ? "Load new code changes"
              : `Sync ${providerLabel(initialData.pullRequest.provider)} pull request`
          }
          title={
            updateAvailable
              ? "Load the synced code changes (R)"
              : `Fetch the latest ${providerLabel(initialData.pullRequest.provider)} code and review conversations (R)`
          }
          className="text-mist hover:text-cloud flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line px-2.5 text-[10px] transition hover:bg-surface-subtle disabled:cursor-wait"
        >
          <RefreshCw
            className={cn(
              "size-4",
              (loadingChanges || (externalSyncPending && !updateAvailable)) &&
                "animate-spin",
            )}
          />
          <span className="hidden sm:inline">
            {loadingChanges ? (
              "Loading…"
            ) : updateAvailable ? (
              <>
                Load
                <span className="hidden xl:inline"> changes</span>
              </>
            ) : externalSyncPending ? (
              "Syncing…"
            ) : (
              "Sync"
            )}
          </span>
          <ShortcutHint
            shortcut={
              updateAvailable
                ? reviewShortcuts.loadChanges
                : reviewShortcuts.refresh
            }
            className="hidden 2xl:inline-flex"
          />
        </button>
        <button
          type="button"
          onClick={undoLastSignOff}
          disabled={!canUndoSignOff}
          aria-busy={undoPending || undefined}
          aria-label="Undo the last sign-off"
          title={
            undoableSignOff
              ? `Return ${undoableSignOff.entry.label} to the review path`
              : "No sign-off from this session left to undo"
          }
          className="text-mist hover:text-cloud flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line px-2.5 text-[10px] transition hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-45"
        >
          {undoPending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Undo2 className="size-4" />
          )}
          <span className="hidden sm:inline">
            {undoPending ? "Undoing…" : "Undo"}
          </span>
          <ShortcutHint
            shortcut={reviewShortcuts.undoSignOff}
            className="hidden 2xl:inline-flex"
          />
        </button>
        <button
          type="button"
          onClick={() => setResetDialogOpen(true)}
          disabled={
            pendingSignOffCount > 0 ||
            externalSyncPending ||
            resetReview.isPending
          }
          aria-label="Reset review"
          title={
            pendingSignOffCount > 0
              ? "Wait for pending sign-offs to finish before resetting"
              : "Sync the latest code and clear all of your sign-offs (Shift+R)"
          }
          className="text-mist hover:text-cloud flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line px-2.5 text-[10px] transition hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Undo2 className="size-4" />
          <span className="hidden sm:inline">Reset</span>
          <ShortcutHint
            shortcut={reviewShortcuts.reset}
            className="hidden 2xl:inline-flex"
          />
        </button>
        <button
          type="button"
          onClick={openCommands}
          aria-label="Open review commands"
          title="Open review commands"
          className="text-mist hover:text-cloud flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line px-2.5 text-[10px] transition hover:bg-surface-subtle"
        >
          <Keyboard className="size-4" />
          <ShortcutHint
            shortcut={commandMenuShortcut}
            className="hidden sm:inline-flex"
          />
        </button>
        <a
          href={initialData.pullRequest.webUrl}
          target="_blank"
          rel="noreferrer"
          aria-label="Open pull request in provider"
          className="text-mist hover:text-cloud grid size-9 place-items-center rounded-full hover:bg-surface-subtle"
        >
          <ExternalLink className="size-4" />
        </a>
        <ThemeToggle className="size-9 rounded-full" />
      </header>

      {updateAvailable && (
        <div
          role="status"
          className="border-cyan/20 bg-cyan/[.055] flex shrink-0 items-center gap-3 border-b px-4 py-2.5 sm:px-6"
        >
          <RefreshCw className="text-cyan size-4 shrink-0" />
          <p className="text-mist min-w-0 flex-1 text-xs">
            New code changes are ready. Loading them will preserve unaffected
            sign-offs and reopen affected units.
          </p>
          <Button
            size="sm"
            loading={loadingChanges}
            onClick={loadAvailableChanges}
            title="Load the synced code changes (R)"
          >
            <span>{loadingChanges ? "Loading changes…" : "Load changes"}</span>
            {!loadingChanges && (
              <ShortcutHint shortcut={reviewShortcuts.loadChanges} />
            )}
          </Button>
        </div>
      )}

      {revisionNotice && (
        <ReviewRevisionLoadedNotice onAcknowledge={acknowledgeLoadedRevision}>
          {revisionNotice.previous &&
          revisionNotice.previous.headSha !== initialData.snapshot.headSha
            ? `${providerLabel(initialData.pullRequest.provider)} moved from ${shortRevision(revisionNotice.previous.headSha)} to ${shortRevision(initialData.snapshot.headSha)}. `
            : `Review analysis was recomputed for ${shortRevision(initialData.snapshot.headSha)}. `}
          {revisionReReviewCount > 0
            ? `${revisionReReviewCount} previously reviewed ${revisionReReviewCount === 1 ? "unit changed" : "units changed"} and ${revisionReReviewCount === 1 ? "needs" : "need"} another look. `
            : "No reviewed units were reopened. "}
          {revisionPreservedCount > 0 &&
            `${revisionPreservedCount} unaffected ${revisionPreservedCount === 1 ? "sign-off was" : "sign-offs were"} preserved. `}
          Only a new source or analysis revision can change review state;
          interface updates cannot.
        </ReviewRevisionLoadedNotice>
      )}

      <div
        className={cn(
          "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-hidden",
          insightsPanelCollapsed
            ? "xl:grid-cols-[minmax(0,1fr)]"
            : "xl:grid-cols-[minmax(0,1fr)_320px]",
          pathPanelCollapsed && insightsPanelCollapsed
            ? "2xl:grid-cols-[minmax(0,1fr)]"
            : pathPanelCollapsed
              ? "2xl:grid-cols-[minmax(0,1fr)_320px]"
              : insightsPanelCollapsed
                ? "2xl:grid-cols-[250px_minmax(0,1fr)]"
                : "2xl:grid-cols-[250px_minmax(0,1fr)_320px]",
        )}
      >
        {pathPanelOpen && (
          <button
            type="button"
            aria-label="Close review path"
            onClick={() => setPathPanelOpen(false)}
            className="fixed top-16 right-0 bottom-0 left-0 z-30 bg-black/55 backdrop-blur-[2px] 2xl:hidden"
          />
        )}
        {insightsPanelOpen && (
          <button
            type="button"
            aria-label="Close AI assistance"
            onClick={() => setInsightsPanelOpen(false)}
            className="fixed top-16 right-0 bottom-0 left-0 z-30 bg-black/55 backdrop-blur-[2px] xl:hidden"
          />
        )}
        <aside
          id="review-path-panel"
          aria-label="Review path"
          className={cn(
            "min-h-0 flex-col overflow-hidden border-r border-line bg-panel",
            pathPanelOpen
              ? "fixed top-16 bottom-0 left-0 z-40 flex w-[min(320px,calc(100vw-3rem))] shadow-2xl"
              : "hidden",
            pathPanelCollapsed
              ? "2xl:hidden"
              : "2xl:static 2xl:flex 2xl:w-auto 2xl:shadow-none",
          )}
        >
          <div className="shrink-0 border-b border-line px-4 py-4">
            <div className="flex items-center justify-between">
              <span className="text-fog text-[10px] font-semibold tracking-[.16em] uppercase">
                Review concepts
              </span>
              <Badge>{initialData.concepts.length} concepts</Badge>
            </div>
            <div className="mt-3 flex items-center gap-2 text-[9px]">
              <span className="text-cloud">
                {initialData.concepts.length - signedConceptCount} concepts
                remaining
              </span>
              <span aria-hidden="true" className="text-line-strong">
                ·
              </span>
              <span className="text-fog">
                {signedCount}/{units.length} units · {reviewedChangedLines}/
                {conceptChangedLineTotal} lines
              </span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-hover">
              <div
                aria-hidden="true"
                className="bg-lime h-full rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="relative mt-3">
              <input
                ref={pathSearchRef}
                type="search"
                value={pathSearch}
                onChange={(event) => {
                  setPathSearch(event.target.value);
                  setSearchLimit(INITIAL_PATH_ITEMS);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setPathSearch("");
                    event.currentTarget.blur();
                  }
                }}
                aria-label="Filter review path"
                placeholder="Find a symbol or file"
                className="bg-surface text-cloud focus:border-cyan/45 h-9 w-full rounded-lg border border-line px-3 pr-9 text-xs outline-none"
              />
              <ShortcutHint
                shortcut={reviewShortcuts.search}
                className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2"
              />
            </div>
          </div>
          {!pathSearch.trim() && (
            <section className="shrink-0 border-b border-line px-3 py-3">
              <button
                type="button"
                aria-expanded={reviewedExpanded}
                aria-controls="reviewed-units"
                disabled={pathSections.reviewed.length === 0}
                onClick={() => {
                  setReviewedExpanded((current) => !current);
                  setReviewedLimit(INITIAL_PATH_ITEMS);
                }}
                className="hover:bg-surface-subtle flex w-full items-center justify-between rounded-lg px-2 py-1 text-left transition disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
                  Reviewed
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-fog text-[9px]">
                    {pathSections.reviewed.length}
                  </span>
                  <ChevronDown
                    className={cn(
                      "text-fog size-3.5 transition-transform",
                      reviewedExpanded && "rotate-180",
                    )}
                  />
                </span>
              </button>
              {reviewedExpanded && (
                <div
                  id="reviewed-units"
                  className="mt-2 max-h-[32vh] space-y-1 overflow-y-auto"
                >
                  {pathSections.reviewed
                    .slice(0, reviewedLimit)
                    .map((entry) => (
                      <ReviewPathUnit
                        key={entry.unit.id}
                        entry={entry}
                        active={false}
                        onSelect={selectConceptPath}
                      />
                    ))}
                  {pathSections.reviewed.length > reviewedLimit && (
                    <button
                      type="button"
                      onClick={() =>
                        setReviewedLimit((current) =>
                          Math.min(
                            current + PATH_PAGE_SIZE,
                            pathSections.reviewed.length,
                          ),
                        )
                      }
                      className="text-cyan hover:bg-cyan/[.06] w-full rounded-lg px-3 py-2 text-[10px] transition"
                    >
                      Show{" "}
                      {Math.min(
                        PATH_PAGE_SIZE,
                        pathSections.reviewed.length - reviewedLimit,
                      )}{" "}
                      more reviewed
                    </button>
                  )}
                </div>
              )}
            </section>
          )}
          {!pathSearch.trim() && pathSections.waiting.length > 0 && (
            <section className="shrink-0 border-b border-line px-3 py-3">
              <button
                type="button"
                aria-expanded={waitingExpanded}
                aria-controls="waiting-units"
                onClick={() => {
                  setWaitingExpanded((current) => !current);
                  setWaitingLimit(INITIAL_PATH_ITEMS);
                }}
                className="hover:bg-surface-subtle flex w-full items-center justify-between rounded-lg px-2 py-1 text-left transition"
              >
                <span className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
                  Waiting for response
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-cyan text-[9px]">
                    {pathSections.waiting.length}
                  </span>
                  <ChevronDown
                    className={cn(
                      "text-fog size-3.5 transition-transform",
                      waitingExpanded && "rotate-180",
                    )}
                  />
                </span>
              </button>
              {waitingExpanded && (
                <div
                  id="waiting-units"
                  className="mt-2 max-h-[28vh] space-y-1 overflow-y-auto"
                >
                  {pathSections.waiting.slice(0, waitingLimit).map((entry) => (
                    <ReviewPathUnit
                      key={entry.unit.id}
                      entry={entry}
                      active={false}
                      onSelect={selectConceptPath}
                    />
                  ))}
                  {pathSections.waiting.length > waitingLimit && (
                    <button
                      type="button"
                      onClick={() =>
                        setWaitingLimit((current) =>
                          Math.min(
                            current + PATH_PAGE_SIZE,
                            pathSections.waiting.length,
                          ),
                        )
                      }
                      className="text-cyan hover:bg-cyan/[.06] w-full whitespace-nowrap rounded-lg px-3 py-2 text-[10px] transition"
                    >
                      Show{" "}
                      {Math.min(
                        PATH_PAGE_SIZE,
                        pathSections.waiting.length - waitingLimit,
                      )}{" "}
                      more
                    </button>
                  )}
                </div>
              )}
            </section>
          )}
          <div className="shrink-0 border-b border-line px-3 py-3">
            <div className="mb-1 flex items-center justify-between px-2">
              <span className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
                Current
              </span>
              <span
                className="text-fog text-[9px]"
                title={`Canonical concept position ${activeConceptPathIndex + 1} of ${conceptPathUnits.length}`}
              >
                {activeConceptPathIndex + 1}
              </span>
            </div>
            {pathSections.current && (
              <ReviewPathUnit
                entry={pathSections.current}
                active
                onSelect={selectConceptPath}
              />
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {pathSearch.trim() ? (
              <section aria-labelledby="search-results-heading">
                <div className="mb-2 flex items-center justify-between px-2">
                  <h2
                    id="search-results-heading"
                    className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase"
                  >
                    Matches
                  </h2>
                  <span className="text-fog text-[9px]">
                    {searchResults.length}
                  </span>
                </div>
                {searchResults.length ? (
                  <div className="space-y-1">
                    {searchResults.slice(0, searchLimit).map((entry) => (
                      <ReviewPathUnit
                        key={entry.unit.id}
                        entry={entry}
                        active={false}
                        onSelect={selectUnit}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-mist rounded-xl border border-dashed border-line px-3 py-4 text-center text-[10px] leading-4">
                    No other units match your search.
                  </p>
                )}
                {searchResults.length > searchLimit && (
                  <button
                    type="button"
                    onClick={() =>
                      setSearchLimit((current) =>
                        Math.min(
                          current + PATH_PAGE_SIZE,
                          searchResults.length,
                        ),
                      )
                    }
                    className="text-cyan hover:bg-cyan/[.06] mt-2 w-full rounded-lg px-3 py-2 text-[10px] transition"
                  >
                    Show{" "}
                    {Math.min(
                      PATH_PAGE_SIZE,
                      searchResults.length - searchLimit,
                    )}{" "}
                    more matches
                  </button>
                )}
              </section>
            ) : (
              <section aria-labelledby="up-next-heading">
                <div className="mb-2 flex items-center justify-between px-2">
                  <h2
                    id="up-next-heading"
                    className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase"
                  >
                    Up next
                  </h2>
                  <span className="text-fog text-[9px]">
                    {pathSections.upcoming.length}
                  </span>
                </div>
                {pathSections.upcoming.length ? (
                  <div className="space-y-1">
                    {pathSections.upcoming.slice(0, queueLimit).map((entry) => (
                      <ReviewPathUnit
                        key={entry.unit.id}
                        entry={entry}
                        active={false}
                        onSelect={selectConceptPath}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-mist rounded-xl border border-dashed border-line px-3 py-4 text-center text-[10px]">
                    No concepts left in the queue.
                  </p>
                )}
                <div className="mt-2 flex items-center gap-1">
                  {pathSections.upcoming.length > queueLimit && (
                    <button
                      type="button"
                      onClick={() =>
                        setQueueLimit((current) =>
                          Math.min(
                            current + PATH_PAGE_SIZE,
                            pathSections.upcoming.length,
                          ),
                        )
                      }
                      className="text-cyan hover:bg-cyan/[.06] flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-[10px] transition"
                    >
                      Show{" "}
                      {Math.min(
                        PATH_PAGE_SIZE,
                        pathSections.upcoming.length - queueLimit,
                      )}{" "}
                      more
                    </button>
                  )}
                  {queueLimit > INITIAL_PATH_ITEMS && (
                    <button
                      type="button"
                      onClick={() => setQueueLimit(INITIAL_PATH_ITEMS)}
                      className="text-mist hover:bg-surface-subtle shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-[10px] transition"
                    >
                      Show less
                    </button>
                  )}
                </div>
              </section>
            )}
          </div>
          <div className="shrink-0 border-t border-line p-3">
            <button
              type="button"
              aria-label="Hide review path"
              title="Hide review path"
              onClick={hidePathPanel}
              className="text-mist hover:bg-surface-subtle hover:text-cloud flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-[10px] transition"
            >
              <PanelLeftClose className="size-3.5" />
              <span>Hide review path</span>
              <ShortcutHint
                shortcut={reviewShortcuts.togglePathPanel}
                className="ml-auto"
              />
            </button>
          </div>
        </aside>

        <main className="relative flex min-h-0 min-w-0 flex-col overflow-hidden">
          {waitingCompletionVisible && (
            <ReviewWaitingCompletion
              dashboardShortcut={reviewShortcuts.dashboard}
              dismissShortcut={[{ key: "Escape" }]}
              nextReview={nextReview}
              nextReviewShortcut={reviewShortcuts.nextReview}
              providerName={providerLabel(initialData.pullRequest.provider)}
              queueLoading={reviewQueue.isLoading}
              releasingUnitId={releasingWaitingUnitId}
              reviewedConcepts={signedConceptCount}
              totalConcepts={conceptProgress.length}
              units={waitingReviewUnits}
              onDashboard={openPullRequests}
              onDismiss={() => setWaitingCompletionOpen(false)}
              onNextReview={openNextReview}
              onOpenUnit={openWaitingUnit}
              onStopWaiting={stopWaitingOnUnit}
            />
          )}
          {completionVisible && (
            <ReviewCompletion
              completedFiles={completedFileCount}
              completedUnits={signedCount}
              dashboardShortcut={reviewShortcuts.dashboard}
              dismissShortcut={[{ key: "Escape" }]}
              nextReview={nextReview}
              nextReviewShortcut={reviewShortcuts.nextReview}
              providerReview={
                <ProviderReviewDecision
                  state={providerReviewState.data}
                  error={providerReviewState.error?.message}
                  loading={providerReviewState.isFetching}
                  mutationPending={setProviderReviewDecision.isPending}
                  repositoryUrl={initialData.pullRequest.repositoryWebUrl}
                  pullRequestUrl={initialData.pullRequest.webUrl}
                  onRefresh={() => void providerReviewState.refetch()}
                  onDecision={(action, body) =>
                    setProviderReviewDecision.mutate({
                      pullRequestId: initialData.pullRequest.id,
                      action,
                      body,
                    })
                  }
                />
              }
              queueLoading={reviewQueue.isLoading}
              onDashboard={openPullRequests}
              onDismiss={() => setCompletionOpen(false)}
              onNextReview={openNextReview}
            />
          )}
          <div
            className={cn(
              "bg-panel sticky top-0 z-20 shrink-0 border-b border-line",
              codePaneScrolled &&
                "shadow-[0_10px_24px_color-mix(in_srgb,var(--app-shadow)_55%,transparent)]",
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 px-3 py-3 sm:flex-nowrap sm:gap-4 sm:px-5 sm:py-4 lg:px-7">
              <button
                type="button"
                aria-label="Show review path"
                aria-controls="review-path-panel"
                aria-expanded={pathPanelOpen}
                title="Show review path"
                onClick={showPathPanel}
                className={cn(
                  "text-mist hover:text-cyan h-8 shrink-0 items-center gap-2 rounded-lg border border-line px-2 transition hover:border-cyan/25 hover:bg-cyan/[.05]",
                  pathPanelCollapsed ? "flex" : "flex 2xl:hidden",
                )}
              >
                <PanelLeftOpen className="size-3.5" />
                <span className="hidden text-[10px] sm:inline">
                  Review path
                </span>
                <ShortcutHint
                  shortcut={reviewShortcuts.togglePathPanel}
                  className="hidden lg:inline-flex"
                />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <h1
                    className="truncate text-sm font-medium"
                    title={`${activeUnit.path}, lines ${activeUnit.startLine}–${activeUnit.endLine}`}
                  >
                    {activeConcept?.title ?? activeUnit.name}
                  </h1>
                  {activeWaitStatus === "waiting" &&
                    (activeUnitAnswered ? (
                      <Badge className="border-lime/25 bg-lime/10 text-lime">
                        <MessageSquareText className="size-3" />
                        Response received
                      </Badge>
                    ) : (
                      <Badge className="border-cyan/25 bg-cyan/10 text-cyan">
                        <Clock3 className="size-3" />
                        Waiting for response
                      </Badge>
                    ))}
                  {activeUnit.changedSinceSignOff && (
                    <Badge className="border-amber-600/25 bg-amber-400/10 text-amber-800 dark:border-amber-300/20 dark:text-amber-200">
                      Changed
                    </Badge>
                  )}
                  {activeUnit.changeType !== "modified" && (
                    <Badge
                      className={cn(
                        "capitalize",
                        activeUnit.changeType === "deleted" &&
                          "border-red-500/25 bg-red-400/10 text-red-700 dark:border-red-300/20 dark:text-red-200",
                      )}
                    >
                      {activeUnit.changeType}
                    </Badge>
                  )}
                </div>
                <p className="text-fog mt-1 flex min-w-0 items-center gap-1.5 truncate text-[10px]">
                  <span className="text-mist font-mono">{activeUnit.path}</span>
                  <span aria-hidden="true">·</span>
                  <span className="shrink-0">
                    {activeConceptMembers.length > 1
                      ? `Member ${activeConceptMemberIndex + 1}/${activeConceptMembers.length}`
                      : `Lines ${activeUnit.startLine}–${activeUnit.endLine}`}
                  </span>
                  {activeConcept && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="shrink-0">
                        {activeConcept.changedLineCount} changed lines in{" "}
                        {activeConcept.fileCount}{" "}
                        {activeConcept.fileCount === 1 ? "file" : "files"}
                      </span>
                    </>
                  )}
                </p>
              </div>
              <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
                {sourceHydrationPending && (
                  <span
                    role="status"
                    aria-label="Loading private review source"
                    className="text-mist flex h-8 shrink-0 items-center gap-1.5 px-1.5 text-[10px]"
                    title="Loading and verifying review source in the background"
                  >
                    <LoaderCircle className="size-3.5 animate-spin" />
                    <span className="hidden lg:inline">Loading source…</span>
                  </span>
                )}
                {initialData.conceptLayout && !conceptLayoutLocked && (
                  <button
                    type="button"
                    onClick={() => setConceptGroupingDialogOpen(true)}
                    disabled={
                      improveConceptGrouping.isPending ||
                      replaceConceptLayout.isPending
                    }
                    aria-label={improveGroupingLabel}
                    className="text-violet hover:bg-violet/[.06] grid size-8 shrink-0 place-items-center rounded-lg border border-violet/20 transition disabled:cursor-wait disabled:opacity-60"
                    title={improveGroupingLabel}
                  >
                    {groupingImproving ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="size-3.5" />
                    )}
                  </button>
                )}
                {initialData.conceptLayout &&
                  !conceptLayoutLocked &&
                  activeConceptMembers.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setSplitConceptDialogOpen(true)}
                      disabled={replaceConceptLayout.isPending}
                      className="text-mist hover:text-cyan flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[10px] transition disabled:opacity-50"
                      title="Split this concept"
                    >
                      {replaceConceptLayout.isPending &&
                        conceptLayoutAction === "split" && (
                          <LoaderCircle className="size-3.5 animate-spin" />
                        )}
                      {replaceConceptLayout.isPending &&
                      conceptLayoutAction === "split"
                        ? "Splitting…"
                        : "Split"}
                    </button>
                  )}
                {initialData.conceptLayout &&
                  !conceptLayoutLocked &&
                  initialData.concepts.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setMoveMemberDialogOpen(true)}
                      disabled={replaceConceptLayout.isPending}
                      aria-label={moveMemberLabel}
                      title={moveMemberLabel}
                      className="text-mist hover:text-cyan grid size-8 shrink-0 place-items-center rounded-lg border border-line transition hover:border-cyan/25 hover:bg-cyan/[.05] disabled:opacity-50"
                    >
                      {movingMember ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : (
                        <FolderInput className="size-3.5" />
                      )}
                    </button>
                  )}
                <button
                  type="button"
                  aria-label="Open review hierarchy"
                  title="Review hierarchy"
                  onClick={() => setHierarchyOpen(true)}
                  className="text-mist hover:text-cyan grid size-8 shrink-0 place-items-center rounded-lg border border-line transition hover:border-cyan/25 hover:bg-cyan/[.05]"
                >
                  <GitBranch className="size-3.5" />
                </button>
                {diffAvailable && (
                  <ReviewCodeViewSwitch
                    diffVisible={sideBySideVisible}
                    onChange={(diffVisible) => {
                      if (diffVisible === sideBySideVisible) return;
                      setShowDiff(diffVisible);
                      setContextBefore(0);
                      setContextAfter(0);
                    }}
                  />
                )}
                <button
                  type="button"
                  aria-label="Show AI assistance"
                  aria-controls="code-explanation-panel"
                  aria-expanded={insightsPanelOpen}
                  title="Show AI assistance"
                  onClick={showInsightsPanel}
                  className={cn(
                    "text-mist hover:text-violet h-8 shrink-0 items-center gap-2 rounded-lg border border-line px-2 transition hover:border-violet/25 hover:bg-violet/[.05]",
                    insightsPanelCollapsed ? "flex" : "flex xl:hidden",
                  )}
                >
                  <PanelRightOpen className="size-3.5" />
                  <span className="hidden text-[10px] sm:inline">Details</span>
                  <ShortcutHint
                    shortcut={reviewShortcuts.toggleInsightsPanel}
                    className="hidden lg:inline-flex"
                  />
                </button>
                <Badge className="hidden h-8 py-0 capitalize sm:inline-flex">
                  {activeUnit.kind}
                </Badge>
              </div>
            </div>
            {showScrollOverview && (
              <ReviewScrollOverview
                label={
                  activeUnit
                    ? `L${activeUnit.startLine}–${activeUnit.endLine} · ${overviewLineCount} lines`
                    : undefined
                }
                marks={overviewMarks}
                unitRange={overviewUnitRange}
                viewport={overviewViewport}
                onSeek={seekCodeOverview}
              />
            )}
          </div>
          {activeUnit.changedSinceSignOff && !activeUnit.previousSource && (
            <div className="border-cyan/15 bg-cyan/[.035] text-cyan border-b px-5 py-2 text-[10px] sm:px-7">
              This source is unchanged, but a dependency it relies on changed.
            </div>
          )}
          {providerConversations.isError && (
            <div className="flex items-center justify-between gap-3 border-b border-amber-500/20 bg-amber-400/[.06] px-5 py-2 sm:px-7">
              <p className="text-[10px] text-amber-800 dark:text-amber-200">
                {providerConversations.error.message}
              </p>
              <button
                type="button"
                onClick={() => void providerConversations.refetch()}
                className="shrink-0 text-[10px] font-medium text-amber-800 hover:underline dark:text-amber-200"
              >
                Try again
              </button>
            </div>
          )}
          {importReturn && (
            <div className="border-cyan/15 bg-cyan/[.035] flex items-center justify-between gap-3 border-b px-5 py-2 sm:px-7">
              <p className="text-mist min-w-0 truncate text-[10px]">
                Followed{" "}
                <span className="text-cloud font-mono">
                  {importReturn.importedName}
                </span>{" "}
                from{" "}
                <span className="text-cloud font-mono">
                  {importReturn.unitName}
                </span>
              </p>
              <button
                type="button"
                onClick={() => selectUnit(importReturn.index)}
                className="text-cyan hover:bg-cyan/[.07] flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] transition"
              >
                <CornerUpLeft className="size-3" />
                Return
              </button>
            </div>
          )}
          <div
            ref={codeScrollRef}
            data-code-scroll-pane
            onScroll={() => {
              closeSymbolPeek();
              updateCodeOverview();
            }}
            {...peekHandlers}
            className="min-h-0 flex-1 overflow-auto bg-code pb-5 font-mono text-[11px] leading-5 [overflow-anchor:none]"
          >
            <div aria-hidden="true" className="h-5" />
            {keyboardLine !== undefined && (
              <div
                role="status"
                className="border-cyan/20 bg-panel/95 text-mist sticky top-0 z-20 mx-4 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2 font-sans text-[10px] shadow-xl backdrop-blur"
              >
                <span className="text-cloud flex items-center gap-2 font-medium">
                  <MessageSquareText className="text-cyan size-3.5" />
                  Choose a line to comment on
                </span>
                <span className="flex items-center gap-1.5">
                  <ShortcutHint
                    shortcut={[{ key: "ArrowUp" }, { key: "ArrowDown" }]}
                  />
                  move
                </span>
                <span className="flex items-center gap-1.5">
                  <ShortcutHint shortcut={[{ key: "Enter" }]} />
                  select
                </span>
                <span className="flex items-center gap-1.5">
                  <ShortcutHint shortcut={[{ key: "Escape" }]} />
                  cancel
                </span>
              </div>
            )}
            {activeConceptMembers
              .slice(0, activeConceptMemberIndex)
              .map((member, memberIndex) => (
                <div key={member.id} className="mb-4">
                  {conceptMemberPreviews[memberIndex]}
                </div>
              ))}
            {/* Inside the scroller, so it scrolls away with the source it
                could not be anchored to instead of pinning above it. */}
            {renderDetachedFindingCard()}
            <div
              ref={reviewUnitStartRef}
              data-review-member-id={activeUnit.id}
              data-selected="true"
              className="mx-4"
            >
              <div className="sticky top-0 z-20">
                <div
                  aria-hidden="true"
                  className={cn(
                    "bg-code pointer-events-none absolute inset-x-[-1rem] bottom-full h-5",
                    !codePaneScrolled && "hidden",
                  )}
                />
                <div
                  className={cn(
                    "overflow-hidden border-x border-b border-cyan/35 bg-panel shadow-[0_0_0_1px_color-mix(in_srgb,var(--app-cyan)_8%,transparent)]",
                    codePaneScrolled
                      ? "rounded-none border-t-0"
                      : "rounded-t-xl border-t",
                  )}
                >
                  <ReviewConceptMemberHeader
                    unit={activeUnit}
                    index={activeConceptMemberIndex}
                    count={activeConceptMembers.length}
                    selected
                    actions={
                      activeUnit.kind !== "binary" ? (
                        <ReviewUnitViewOptions
                          importsVisible={importsVisible}
                          fullFileVisible={fullFileVisible}
                          importsDisabled={!activeModule}
                          fullFileDisabled={!contextAvailable}
                          onToggleImports={() =>
                            setImportContextUnitIds((current) => {
                              const next = new Set(current);
                              if (next.has(activeUnit.id))
                                next.delete(activeUnit.id);
                              else next.add(activeUnit.id);
                              return next;
                            })
                          }
                          onToggleFullFile={() =>
                            setFullFileUnitIds((current) => {
                              const next = new Set(current);
                              if (next.has(activeUnit.id))
                                next.delete(activeUnit.id);
                              else next.add(activeUnit.id);
                              return next;
                            })
                          }
                        />
                      ) : undefined
                    }
                  />
                </div>
              </div>
              <div
                ref={codeOverviewRef}
                className={cn(
                  "-mt-px",
                  !sideBySideVisible &&
                    "overflow-hidden rounded-b-xl border-x border-b border-line bg-code",
                )}
              >
                {sideBySideVisible && (
                  <SideBySideUnitDiff
                    key={activeUnit.id}
                    ref={diffContextRef}
                    previousSource={diffPreviousSource}
                    currentSource={diffCurrentSource}
                    language={activeUnit.language}
                    previousStartLine={1}
                    currentStartLine={1}
                    previousFocusRanges={
                      activeUnit.relatedRanges
                        ? previousRelatedRanges
                        : undefined
                    }
                    currentFocusRanges={
                      activeUnit.relatedRanges
                        ? currentRelatedRanges
                        : undefined
                    }
                    previousFocusStartLine={
                      activeUnit.changeType === "added"
                        ? null
                        : previousUnitStartLine
                    }
                    previousFocusEndLine={
                      activeUnit.changeType === "added"
                        ? null
                        : previousUnitEndLine
                    }
                    currentFocusStartLine={
                      activeUnit.changeType === "deleted"
                        ? null
                        : activeUnit.startLine
                    }
                    currentFocusEndLine={
                      activeUnit.changeType === "deleted"
                        ? null
                        : activeUnit.endLine
                    }
                    selectedLine={selectedLine}
                    keyboardLine={keyboardLine ?? aiQuestionPreviewLine}
                    findingLine={findingLine}
                    expanded={fullFileVisible}
                    onSelectReviewLine={openInlineComment}
                    onAskReviewLine={openAiQuestionAt}
                    renderLineDetails={renderReviewLineDetails}
                  />
                )}
                {activeSourceHydrationPending && !activeSourceAvailable && (
                  <div
                    className="min-h-72 animate-pulse bg-surface/10 px-5 py-6 font-sans"
                    aria-live="polite"
                  >
                    <span className="sr-only">
                      Loading and verifying private source…
                    </span>
                    <div aria-hidden="true" className="space-y-3">
                      <div className="bg-line-strong h-2 w-2/5 rounded-full" />
                      <div className="bg-line h-2 w-4/5 rounded-full" />
                      <div className="bg-line h-2 w-3/5 rounded-full" />
                      <div className="bg-line h-2 w-11/12 rounded-full" />
                      <div className="bg-line h-2 w-2/3 rounded-full" />
                    </div>
                  </div>
                )}
                {!activeSourceHydrationPending && !activeSourceAvailable && (
                  <div className="mx-auto grid min-h-72 max-w-lg place-items-center px-6 py-12 font-sans">
                    <div className="w-full rounded-2xl border border-line bg-surface/45 p-8 text-center shadow-[0_18px_60px_var(--app-shadow)]">
                      <FileCode2
                        className="text-fog mx-auto size-6"
                        aria-hidden="true"
                      />
                      <p className="text-cloud mt-4 text-sm font-medium">
                        Source unavailable
                      </p>
                      <p className="text-mist mt-2 text-xs leading-5">
                        This private source could not be verified and loaded.
                        Reload the review before signing off this unit.
                      </p>
                    </div>
                  </div>
                )}
                {importsVisible &&
                  !sideBySideVisible &&
                  activeSourceAvailable &&
                  activeModule && (
                    <UnitImportContext
                      key={activeUnit.id}
                      fileSource={activeModule.source}
                      previousFileSource={
                        activeModule.previousSource ?? undefined
                      }
                      unitSource={activeUnit.source}
                      language={activeUnit.language}
                      unitId={activeUnit.id}
                      visibleStartLine={visibleStartLine}
                      visibleEndLine={visibleEndLine}
                      previousVisibleStartLine={previousUnitStartLine}
                      previousVisibleEndLine={previousUnitEndLine}
                      resolvingImport={resolvingImport}
                      onFollow={(reference) => void followImport(reference)}
                    />
                  )}
                {!sideBySideVisible &&
                  activeSourceAvailable &&
                  contextAvailable &&
                  !fullFileVisible &&
                  contextBefore < availableBefore && (
                    <div className="mb-3 flex items-center gap-3 px-4 font-sans">
                      <span className="h-px flex-1 bg-line" />
                      <button
                        type="button"
                        onClick={revealContextAbove}
                        className="text-fog hover:border-cyan/25 hover:bg-cyan/[.05] hover:text-cyan flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[9px] transition"
                      >
                        <ChevronDown className="size-3 rotate-180" />
                        Show{" "}
                        {Math.min(
                          CONTEXT_PAGE_LINES,
                          availableBefore - contextBefore,
                        )}{" "}
                        {contextBefore > 0 ? "more " : ""}lines above
                        <ShortcutHint
                          shortcut={reviewShortcuts.revealContextAbove}
                          className="ml-1"
                        />
                      </button>
                      <span className="h-px flex-1 bg-line" />
                    </div>
                  )}
                {activeSourceAvailable && activeUnit.kind === "binary" && (
                  <div className="mx-auto grid min-h-72 max-w-lg place-items-center px-6 py-12 font-sans">
                    <div className="w-full rounded-2xl border border-line bg-surface/45 p-8 text-center shadow-[0_18px_60px_var(--app-shadow)]">
                      <span className="bg-cyan/10 text-cyan mx-auto grid size-11 place-items-center rounded-xl">
                        <FileCode2 className="size-5" aria-hidden="true" />
                      </span>
                      <p className="text-cloud mt-4 text-sm font-medium">
                        Binary file
                      </p>
                      <p className="text-mist mt-2 text-xs leading-5">
                        ReviewDuck detected binary content. Its bytes are not
                        displayed, sent to AI, or available for line comments.
                      </p>
                      <p className="text-fog mt-3 truncate font-mono text-[10px]">
                        {activeUnit.path}
                      </p>
                    </div>
                  </div>
                )}
                {!sideBySideVisible &&
                  activeSourceAvailable &&
                  activeUnit.kind !== "binary" &&
                  lines.map((line, index) => {
                    const lineNumber = visibleStartLine + index;
                    const isUnitLine = isPrimaryReviewLine(lineNumber);
                    const isChangedLine =
                      isUnitLine && changedCurrentLines.has(lineNumber);
                    const isContextLine = !isUnitLine;
                    const coveringExplanations = isUnitLine
                      ? explanationAnnotations.filter(
                          (annotation) =>
                            lineNumber >= annotation.line &&
                            lineNumber <=
                              (annotation.endLine ?? annotation.line),
                        )
                      : [];
                    return (
                      <Fragment key={`${activeUnit.id}-${index}`}>
                        {contextBefore > 0 &&
                          lineNumber === activeUnit.startLine && (
                            <ReviewScopeMarker
                              edge="start"
                              line={activeUnit.startLine}
                            />
                          )}
                        {lineNumber === activeUnit.startLine &&
                          previousRewriteLines.map((line, previousIndex) => {
                            const previousLineNumber =
                              previousUnitStartLine + previousIndex;
                            return (
                              <div
                                key={`${activeUnit.id}-previous-${previousIndex}`}
                                className="group grid grid-cols-[66px_1fr] border-l-2 border-l-red-400/45 bg-red-400/[.07] px-4 hover:bg-red-400/[.1]"
                              >
                                <span className="flex items-center justify-end pr-3 text-right text-red-700 opacity-80 select-none dark:text-red-200">
                                  {previousLineNumber}
                                </span>
                                <pre className="syntax-code overflow-visible text-cloud/80 line-through opacity-80">
                                  {line.tokens.length
                                    ? line.tokens.map((token, tokenIndex) => (
                                        <span
                                          key={`${tokenIndex}-${token.text.length}`}
                                          className={
                                            token.className || undefined
                                          }
                                        >
                                          {token.text}
                                        </span>
                                      ))
                                    : " "}
                                </pre>
                              </div>
                            );
                          })}
                        <div
                          id={`review-line-${lineNumber}`}
                          className={cn(
                            "group grid grid-cols-[66px_1fr] border-l-2 border-transparent px-4 hover:bg-surface-subtle",
                            contextVisible &&
                              isUnitLine &&
                              "border-l-cyan/35 bg-cyan/[.012]",
                            isChangedLine &&
                              "border-l-addition/45 bg-addition/[.075] hover:bg-addition/[.105]",
                            isContextLine &&
                              "bg-surface-subtle/15 opacity-55 hover:opacity-80",
                            coveringExplanations.length > 0 &&
                              "bg-violet/[.025] shadow-[inset_2px_0_0_var(--app-ai)]",
                            // Amber already means "AI review finding" in this
                            // file, and is the one tint not already spoken for by
                            // the line picker, the composer, additions or
                            // deletions. Both of those still win over it below.
                            findingLine === lineNumber &&
                              "bg-amber-400/[.09] shadow-[inset_2px_0_0_rgb(245_158_11/.85)]",
                            selectedLine === lineNumber && "bg-violet/[.055]",
                            keyboardLine === lineNumber &&
                              "bg-cyan/[.075] shadow-[inset_2px_0_0_var(--app-cyan)]",
                            aiQuestionPreviewLine === lineNumber &&
                              "bg-violet/[.075] shadow-[inset_2px_0_0_var(--app-ai)]",
                          )}
                        >
                          {isUnitLine && activeUnit.kind !== "binary" ? (
                            <span
                              className={cn(
                                "flex items-center justify-end gap-1 pr-1.5 text-right text-fog select-none",
                                isChangedLine &&
                                  "bg-addition/[.11] text-addition",
                              )}
                            >
                              <AskAiLineButton
                                line={lineNumber}
                                onAsk={openAiQuestionAt}
                                visible={aiQuestionLine === lineNumber}
                              />
                              <button
                                type="button"
                                aria-label={`Comment on line ${lineNumber}`}
                                aria-pressed={selectedLine === lineNumber}
                                onClick={() => {
                                  setKeyboardLine(undefined);
                                  setSelectedLine((current) =>
                                    current === lineNumber
                                      ? undefined
                                      : lineNumber,
                                  );
                                  setFeedback("");
                                }}
                                className="hover:text-violet flex items-center gap-1 transition"
                              >
                                <MessageSquareText
                                  className={cn(
                                    "size-3 transition-opacity",
                                    selectedLine === lineNumber ||
                                      keyboardLine === lineNumber
                                      ? "text-cyan opacity-100"
                                      : "opacity-0 group-hover:opacity-100",
                                  )}
                                />
                                <span>{lineNumber}</span>
                              </button>
                            </span>
                          ) : (
                            <span className="flex items-center justify-end pr-3 text-right text-fog select-none">
                              {lineNumber}
                            </span>
                          )}
                          <pre className="syntax-code overflow-visible text-cloud/80">
                            {line.tokens.length
                              ? line.tokens.map((token, tokenIndex) => {
                                  const importReference = importReferences.find(
                                    (reference) =>
                                      reference.from >= token.from &&
                                      reference.to <= token.to,
                                  );
                                  const resolutionKey = importReference
                                    ? `${activeUnit.id}:${importReference.from}:${importReference.to}`
                                    : undefined;
                                  return importReference ? (
                                    <button
                                      type="button"
                                      key={`${tokenIndex}-${token.text.length}`}
                                      aria-label={`Open ${importReference.local} from ${importReference.specifier}`}
                                      title={`Open ${importReference.specifier}`}
                                      disabled={
                                        resolvingImport === resolutionKey
                                      }
                                      onClick={() =>
                                        void followImport(importReference)
                                      }
                                      className={cn(
                                        "text-cyan decoration-cyan/55 hover:bg-cyan/[.09] cursor-pointer rounded-sm underline decoration-dotted underline-offset-4 transition",
                                        token.className,
                                        resolvingImport === resolutionKey &&
                                          "animate-pulse cursor-wait",
                                      )}
                                    >
                                      {token.text}
                                    </button>
                                  ) : isPeekableToken(token) ? (
                                    <span
                                      key={`${tokenIndex}-${token.text.length}`}
                                      {...{
                                        [SYMBOL_PEEK_ATTRIBUTE]: token.text,
                                        [SYMBOL_PEEK_LINE_ATTRIBUTE]:
                                          lineNumber,
                                      }}
                                      className={cn(
                                        "hover:decoration-cyan/45 rounded-sm hover:underline hover:decoration-dotted hover:underline-offset-4",
                                        token.className,
                                      )}
                                    >
                                      {token.text}
                                    </span>
                                  ) : (
                                    <span
                                      key={`${tokenIndex}-${token.text.length}`}
                                      className={token.className || undefined}
                                    >
                                      {token.text}
                                    </span>
                                  );
                                })
                              : " "}
                          </pre>
                        </div>
                        {isUnitLine && renderReviewLineDetails(lineNumber)}
                        {contextAfter > 0 &&
                          lineNumber === activeUnit.endLine && (
                            <ReviewScopeMarker
                              edge="end"
                              line={activeUnit.endLine}
                            />
                          )}
                      </Fragment>
                    );
                  })}
                {!sideBySideVisible &&
                  contextAvailable &&
                  !fullFileVisible &&
                  contextAfter < availableAfter && (
                    <div className="mt-3 flex items-center gap-3 px-4 font-sans">
                      <span className="h-px flex-1 bg-line" />
                      <button
                        type="button"
                        onClick={revealContextBelow}
                        className="text-fog hover:border-cyan/25 hover:bg-cyan/[.05] hover:text-cyan flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[9px] transition"
                      >
                        <ChevronDown className="size-3" />
                        Show{" "}
                        {Math.min(
                          CONTEXT_PAGE_LINES,
                          availableAfter - contextAfter,
                        )}{" "}
                        {contextAfter > 0 ? "more " : ""}lines below
                        <ShortcutHint
                          shortcut={reviewShortcuts.revealContextBelow}
                          className="ml-1"
                        />
                      </button>
                      <span className="h-px flex-1 bg-line" />
                    </div>
                  )}
              </div>
            </div>
            {activeConceptMembers
              .slice(activeConceptMemberIndex + 1)
              .map((member, memberOffset) => (
                <div key={member.id} className="mt-4">
                  {
                    conceptMemberPreviews[
                      activeConceptMemberIndex + memberOffset + 1
                    ]
                  }
                </div>
              ))}
          </div>
          {aiStatus.data?.status === "completed" && aiStatus.data.result && (
            <details className="group border-violet/15 bg-violet/[.025] border-t xl:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                <span className="text-violet flex min-w-0 items-center gap-2 text-xs font-medium">
                  <Sparkles className="size-3.5 shrink-0" />
                  <span className="truncate">Overall explanation</span>
                </span>
                <span className="text-fog flex shrink-0 items-center gap-2 text-[9px]">
                  {explanationAnnotations.length > 0 &&
                    `${explanationAnnotations.length} inline ${explanationAnnotations.length === 1 ? "note" : "notes"}`}
                  <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
                </span>
              </summary>
              <ProviderCommentBody
                body={aiStatus.data.result.summary}
                className="mt-0 max-w-none border-t border-violet/10 px-4 py-3 text-xs leading-5"
              />
            </details>
          )}
          <div className="border-violet/15 bg-violet/[.025] flex items-center justify-end gap-2 border-t px-3 py-3 sm:px-4 xl:hidden">
            {renderAiActionButtons()}
            {renderPullRequestDetailsButton({
              className: "size-11 border border-line",
            })}
          </div>
          <div className="bg-panel/45 flex items-center justify-end gap-2 border-t border-line px-3 py-3 sm:gap-3 sm:px-7 sm:py-4">
            <div className="text-fog mr-auto hidden min-w-0 items-center gap-4 text-[9px] sm:flex">
              {reviewComplete ? (
                <span
                  role="status"
                  className="text-lime flex items-center gap-2 whitespace-nowrap"
                >
                  <CheckCheck className="size-3.5" />
                  All {signedCount} units reviewed
                </span>
              ) : reviewCaughtUp ? (
                <span
                  role="status"
                  className={cn(
                    "flex items-center gap-2 whitespace-nowrap",
                    answeredWaitCount > 0 ? "text-lime" : "text-cyan",
                  )}
                >
                  {answeredWaitCount > 0 ? (
                    <MessageSquareText className="size-3.5" />
                  ) : (
                    <Clock3 className="size-3.5" />
                  )}
                  {answeredWaitCount > 0
                    ? `All available work reviewed · ${answeredWaitCount} ${answeredWaitCount === 1 ? "response" : "responses"} ready`
                    : `All available work reviewed · ${waitingCount} waiting`}
                </span>
              ) : (
                <span className="hidden items-center gap-3 xl:flex">
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    <ShortcutAlternatives
                      shortcut={reviewShortcuts.scrollUp}
                      alternateShortcut={reviewShortcuts.scrollDown}
                    />
                    {aiQuestionLine === undefined ? "Scroll" : "Move question"}
                  </span>
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    <ShortcutAlternatives
                      shortcut={reviewShortcuts.previousUnit}
                      alternateShortcut={reviewShortcuts.nextUnit}
                    />
                    Unit
                  </span>
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    <ShortcutAlternatives
                      shortcut={reviewShortcuts.previousConcept}
                      alternateShortcut={reviewShortcuts.nextConcept}
                    />
                    Concept
                  </span>
                </span>
              )}
            </div>
            {footerSaveState === "background" && (
              <span
                role="status"
                aria-label={`Saving reviews, ${backgroundSaveProgress}`}
                className="border-line-strong bg-surface text-mist flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border px-2.5 text-[10px] shadow-[0_8px_24px_var(--app-shadow)] sm:h-10 sm:px-3"
              >
                <LoaderCircle className="size-3 animate-spin" />
                <span className="hidden sm:inline">Saving</span>
                <span className="font-mono text-cloud">
                  {backgroundSaveProgress}
                </span>
              </span>
            )}
            {footerSaveState === "finalizing" ? (
              <Button
                className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-5"
                disabled
                aria-label={`Finishing review, ${backgroundSaveProgress}`}
              >
                <LoaderCircle className="size-4 animate-spin" />
                Finishing {backgroundSaveProgress}…
              </Button>
            ) : reviewComplete ? (
              <div className="flex min-w-0 items-center justify-end gap-2">
                {activeConceptProgress?.status === "signed_off" && (
                  <Button
                    variant="secondary"
                    className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-4"
                    onClick={unreviewActiveUnit}
                    disabled={undoSignOff.isPending || undoConcept.isPending}
                  >
                    {undoSignOff.isPending || undoConcept.isPending ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <Undo2 className="size-4" />
                    )}
                    <span className="hidden sm:inline">
                      {undoSignOff.isPending || undoConcept.isPending
                        ? "Undoing…"
                        : "Undo concept"}
                    </span>
                    <span className="sm:hidden">
                      {undoSignOff.isPending || undoConcept.isPending
                        ? "Undoing…"
                        : "Undo"}
                    </span>
                    {!undoSignOff.isPending && !undoConcept.isPending && (
                      <ShortcutHint
                        shortcut={reviewShortcuts.undoReview}
                        className="hidden sm:inline-flex"
                      />
                    )}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  className="h-10 px-3 sm:h-11 sm:px-4"
                  onClick={() => setCompletionOpen(true)}
                >
                  {providerReviewState.data?.decision === "approved" ? (
                    <CheckCircle2 className="size-4 text-lime" />
                  ) : providerReviewState.isFetching ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="size-4" />
                  )}
                  <span className="hidden sm:inline">
                    {providerReviewState.data?.decision === "approved"
                      ? "Approved"
                      : "Provider approval"}
                  </span>
                </Button>
                {nextReview ? (
                  <Button
                    className="h-10 px-3 sm:h-11 sm:px-5"
                    loading={navigationPending}
                    onClick={openNextReview}
                  >
                    Next review
                    {!navigationPending && <ChevronRight className="size-4" />}
                    <ShortcutHint
                      shortcut={reviewShortcuts.nextReview}
                      className="hidden sm:inline-flex"
                    />
                  </Button>
                ) : (
                  <Button
                    className="h-10 px-3 sm:h-11 sm:px-5"
                    loading={navigationPending}
                    onClick={openPullRequests}
                  >
                    {!navigationPending && <ArrowLeft className="size-4" />}
                    Pull requests
                    <ShortcutHint
                      shortcut={reviewShortcuts.dashboard}
                      className="hidden sm:inline-flex"
                    />
                  </Button>
                )}
              </div>
            ) : reviewCaughtUp ? (
              <div className="flex min-w-0 items-center justify-end gap-2">
                {activeWaitStatus === "waiting" && (
                  <Button
                    variant={activeUnitAnswered ? "primary" : "secondary"}
                    className="h-10 px-3 sm:h-11 sm:px-4"
                    onClick={stopWaitingOnActive}
                    disabled={!canStopWaiting}
                  >
                    {releaseReviewWaits.isPending ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : activeUnitAnswered ? (
                      <MessageSquareText className="size-4" />
                    ) : (
                      <Clock3 className="size-4" />
                    )}
                    <span className="hidden sm:inline">
                      {releaseReviewWaits.isPending
                        ? "Resuming…"
                        : activeUnitAnswered
                          ? "Resume review"
                          : "Stop waiting"}
                    </span>
                  </Button>
                )}
                <Button
                  variant="secondary"
                  className="h-10 px-3 sm:h-11 sm:px-4"
                  onClick={() => setWaitingCompletionOpen(true)}
                >
                  {answeredWaitCount > 0 ? (
                    <MessageSquareText className="text-lime size-4" />
                  ) : (
                    <Clock3 className="text-cyan size-4" />
                  )}
                  <span className="hidden sm:inline">
                    {answeredWaitCount > 0
                      ? `View ${answeredWaitCount} ${answeredWaitCount === 1 ? "response" : "responses"}`
                      : `View ${waitingCount} waiting`}
                  </span>
                  <span className="sm:hidden">
                    {answeredWaitCount > 0 ? "Responses" : "Waiting"}
                  </span>
                </Button>
                {nextReview ? (
                  <Button
                    className="h-10 px-3 sm:h-11 sm:px-5"
                    onClick={openNextReview}
                  >
                    Next review
                    <ChevronRight className="size-4" />
                  </Button>
                ) : (
                  <Button
                    className="h-10 px-3 sm:h-11 sm:px-5"
                    onClick={openPullRequests}
                  >
                    <ArrowLeft className="size-4" />
                    Pull requests
                    <ShortcutHint
                      shortcut={reviewShortcuts.dashboard}
                      className="hidden sm:inline-flex"
                    />
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex min-w-0 items-center justify-end gap-2">
                {canSignOffDeletedFiles && footerSaveState !== "active" && (
                  <Button
                    variant="secondary"
                    className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-4"
                    title={`Sign off ${deletedUnitsToSignOff.length} remaining ${deletedUnitsToSignOff.length === 1 ? "unit" : "units"} from files deleted in this pull request`}
                    onClick={signOffDeletedFiles}
                  >
                    <CheckCheck className="size-4" />
                    <span className="hidden sm:inline">Sign off deletes</span>
                    <span className="sm:hidden">Deletes</span>
                    <ShortcutHint
                      shortcut={reviewShortcuts.signOffDeletions}
                      className="hidden sm:inline-flex"
                    />
                  </Button>
                )}
                {activeUnit.status === "signed_off" &&
                  activeWaitStatus !== "waiting" &&
                  footerSaveState !== "active" && (
                    <Button
                      variant="secondary"
                      className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-4"
                      onClick={unreviewActiveUnit}
                      disabled={undoSignOff.isPending}
                    >
                      {undoSignOff.isPending ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <Undo2 className="size-4" />
                      )}
                      <span className="hidden sm:inline">
                        {undoSignOff.isPending ? "Undoing…" : "Undo review"}
                      </span>
                      <span className="sm:hidden">
                        {undoSignOff.isPending ? "Undoing…" : "Undo"}
                      </span>
                      {!undoSignOff.isPending && (
                        <ShortcutHint
                          shortcut={reviewShortcuts.undoReview}
                          className="hidden sm:inline-flex"
                        />
                      )}
                    </Button>
                  )}
                {activeWaitStatus === "waiting" ? (
                  // The header already says this unit is waiting, so the
                  // footer spends the slot on the way out of it instead of
                  // repeating the state as a button nobody can press.
                  <Button
                    variant={activeUnitAnswered ? "primary" : "secondary"}
                    className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-4"
                    title={
                      activeUnitAnswered
                        ? "The conversation has a response — return this work to your review path"
                        : "Take back the wait and return this work to your review path"
                    }
                    onClick={stopWaitingOnActive}
                    disabled={!canStopWaiting}
                  >
                    {releaseReviewWaits.isPending ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : activeUnitAnswered ? (
                      <MessageSquareText className="size-4" />
                    ) : (
                      <Clock3 className="size-4" />
                    )}
                    <span className="hidden sm:inline">
                      {releaseReviewWaits.isPending
                        ? "Resuming…"
                        : activeUnitAnswered
                          ? "Resume review"
                          : "Stop waiting"}
                    </span>
                    <span className="sm:hidden">
                      {releaseReviewWaits.isPending ? "Resuming…" : "Resume"}
                    </span>
                    {!releaseReviewWaits.isPending && (
                      <ShortcutHint
                        shortcut={reviewShortcuts.undoReview}
                        className="hidden sm:inline-flex"
                      />
                    )}
                  </Button>
                ) : (
                  hasLiveConversation &&
                  footerSaveState !== "active" && (
                    <Button
                      variant="secondary"
                      className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-4"
                      title={`Pause this unit until ${providerLabel(initialData.pullRequest.provider)} receives a reply or the code changes`}
                      onClick={awaitActiveResponse}
                      disabled={!canAwaitUnit}
                    >
                      {awaitPending ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <Clock3 className="size-4" />
                      )}
                      <span className="hidden sm:inline">
                        {awaitPending ? "Saving…" : "Await response"}
                      </span>
                      <span className="sm:hidden">
                        {awaitPending ? "Saving…" : "Await"}
                      </span>
                      {!awaitPending && (
                        <ShortcutHint
                          shortcut={reviewShortcuts.awaitResponse}
                          className="hidden sm:inline-flex"
                        />
                      )}
                    </Button>
                  )
                )}
                {(!primaryIsContinue || hasNextActionableUnit) &&
                  (conceptActionAvailable && !primaryIsContinue ? (
                    <SplitActionButton
                      icon={<Check className="size-4" />}
                      label={primaryActionLabel}
                      mobileLabel={
                        activeSignOffPending ? signOffQueueProgress : "Sign off"
                      }
                      menuLabel="Choose what to sign off"
                      pending={activeSignOffPending}
                      primary={{
                        disabled: !canUsePrimaryAction,
                        label: primaryActionLabel,
                        onSelect: runPrimaryAction,
                        shortcut: onLastConceptMember
                          ? reviewShortcuts.signOffConcept
                          : reviewShortcuts.signOff,
                      }}
                      options={[
                        {
                          description:
                            "Record this unit and open the next one in the concept",
                          disabled: !canSignOffUnit,
                          label: "Sign off unit",
                          onSelect: signOffActiveUnit,
                          shortcut: reviewShortcuts.signOff,
                        },
                        {
                          description: `Record all ${activeConceptMembers.length} units of this concept at once`,
                          disabled: !canSignOffConcept,
                          label: "Sign off concept",
                          onSelect: signOffActiveConcept,
                          shortcut: reviewShortcuts.signOffConcept,
                        },
                      ]}
                    />
                  ) : (
                    <Button
                      className="h-10 whitespace-nowrap px-3 sm:h-11 sm:px-5"
                      onClick={runPrimaryAction}
                      disabled={!canUsePrimaryAction}
                    >
                      <Check className="size-4" />
                      {primaryActionLabel}
                      {!activeSignOffPending && (
                        <ShortcutHint
                          shortcut={reviewShortcuts.signOff}
                          className="hidden sm:inline-flex"
                        />
                      )}
                      <ChevronRight className="size-3.5" />
                    </Button>
                  ))}
              </div>
            )}
          </div>
        </main>
        <aside
          id="code-explanation-panel"
          aria-label="AI assistance"
          className={cn(
            "bg-panel min-h-0 flex-col overflow-hidden border-l border-line",
            insightsPanelOpen
              ? "fixed top-16 right-0 bottom-0 z-40 flex w-[min(360px,calc(100vw-3rem))] shadow-2xl"
              : "hidden",
            insightsPanelCollapsed
              ? "xl:hidden"
              : "xl:static xl:flex xl:w-auto xl:bg-panel/30 xl:shadow-none",
          )}
        >
          <div className="border-violet/15 bg-panel z-10 flex shrink-0 flex-col gap-2.5 border-b px-4 py-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
                AI assistance
              </p>
              {renderPullRequestDetailsButton({
                className: "h-7 px-1.5 text-[10px]",
                label: "About this PR",
              })}
            </div>
            {renderAiActionButtons()}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="rounded-xl border border-line bg-surface/55 p-3">
              <div className="flex items-center gap-2">
                <Badge className="capitalize">{activeUnit.kind}</Badge>
                <span className="text-fog text-[9px]">
                  Lines {activeUnit.startLine}–{activeUnit.endLine}
                </span>
              </div>
              <p className="text-cloud mt-2 truncate font-mono text-xs">
                {activeUnit.name}
              </p>
              <p className="text-fog mt-1 truncate font-mono text-[9px]">
                {activeUnit.path}
              </p>
            </div>

            {activeUnit.kind === "binary" ? (
              <div className="mt-4 rounded-xl border border-dashed border-line p-4">
                <p className="text-mist text-xs leading-5">
                  Binary content is intentionally not sent to an AI model.
                </p>
              </div>
            ) : aiStatus.data?.status === "completed" &&
              aiStatus.data.result ? (
              <div className="border-violet/15 bg-violet/[.035] mt-4 rounded-xl border p-4">
                <p className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
                  Overall explanation
                </p>
                <ProviderCommentBody
                  body={aiStatus.data.result.summary}
                  className="mt-2 max-w-none text-xs leading-5"
                />
                {explanationAnnotations.length > 0 && (
                  <div className="mt-4 border-t border-violet/15 pt-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-violet text-[9px] font-semibold tracking-[.12em] uppercase">
                        Inline walkthrough
                      </p>
                      <span className="text-fog text-[9px]">
                        {explanationAnnotations.length}{" "}
                        {explanationAnnotations.length === 1 ? "note" : "notes"}
                      </span>
                    </div>
                    <div className="mt-2 grid gap-1">
                      {explanationAnnotations.map((annotation, index) => (
                        <button
                          key={`${annotation.line}-${annotation.title}`}
                          type="button"
                          onClick={() =>
                            document
                              .getElementById(`ai-explanation-${index}`)
                              ?.scrollIntoView({
                                behavior: "smooth",
                                block: "center",
                              })
                          }
                          className="text-mist hover:bg-violet/[.06] hover:text-cloud flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[10px] transition"
                        >
                          <span className="border-violet/20 bg-violet/[.06] text-violet inline-flex min-w-7 shrink-0 justify-center rounded-md border px-1.5 py-0.5 font-mono text-[8px]">
                            {annotation.line}
                          </span>
                          <span className="truncate">{annotation.title}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : explanationRunning ? (
              <ExplanationLoader unitKind={activeUnit.kind} />
            ) : (
              <div className="mt-4 rounded-xl border border-dashed border-line p-4">
                <p className="text-mist text-xs leading-5">
                  Press E or choose Ask to start a focused question beside the
                  code you are reviewing.
                </p>
              </div>
            )}
            {aiStatus.data?.status === "failed" &&
              !startExplanation.isPending && (
                <div
                  role="status"
                  className="mt-3 rounded-lg border border-red-500/20 bg-red-400/10 p-3 text-red-700 dark:border-red-300/15 dark:text-red-200"
                >
                  <p className="text-xs font-medium">
                    {explanationError.title}
                  </p>
                  <p className="mt-1 text-[11px] leading-5 opacity-80">
                    {explanationError.detail}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canUseAi}
                    onClick={explainActiveUnit}
                    className="mt-2 h-7 border border-red-500/15 px-2.5 text-[10px] text-current hover:bg-red-500/10"
                  >
                    <RefreshCw className="size-3" />
                    Try again
                  </Button>
                </div>
              )}
            {renderDeepReviewPanel()}
            {aiUsage.data && (
              <section
                aria-label="AI usage for this pull request"
                className="mt-5 border-t border-line pt-4"
              >
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <p className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
                      AI usage · this PR
                    </p>
                    <p className="text-mist mt-1 text-[10px]">
                      {aiUsage.data.runs}{" "}
                      {aiUsage.data.runs === 1 ? "run" : "runs"}
                    </p>
                  </div>
                  <p className="text-cloud font-mono text-lg leading-none font-medium">
                    {formatTokenCount(aiUsage.data.totalTokens)}
                    <span className="text-fog ml-1 font-sans text-[9px] font-normal">
                      total
                    </span>
                  </p>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line">
                  {[
                    ["Input", aiUsage.data.inputTokens],
                    ["Output", aiUsage.data.outputTokens],
                    ["Cache read", aiUsage.data.cacheReadTokens],
                    ["Cache write", aiUsage.data.cacheWriteTokens],
                  ].map(([label, value]) => (
                    <div key={label} className="bg-surface/80 px-3 py-2.5">
                      <dt className="text-fog text-[9px]">{label}</dt>
                      <dd className="text-cloud mt-1 font-mono text-[11px]">
                        {Number(value).toLocaleString("en-US")}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
            <div className="mt-5 border-t border-line pt-4">
              <p className="text-fog text-[9px] font-semibold tracking-[.14em] uppercase">
                Why this unit is next
              </p>
              <p className="text-mist mt-2 text-[11px] leading-5">
                {activeUnitFoundation?.foundation
                  ? `This ${activeUnitFoundation.reason === "schema" ? "schema or model" : "data shape"} establishes vocabulary used by later behavior. Its required dependencies still appear first.`
                  : `Dependency depth ${activeUnit.depth}. This path finishes the current dependency branch before moving to the next independent concept.`}
              </p>
            </div>
          </div>
          <div className="shrink-0 border-t border-line p-3">
            <button
              type="button"
              aria-label="Hide AI assistance"
              title="Hide AI assistance"
              onClick={hideInsightsPanel}
              className="text-mist hover:bg-surface-subtle hover:text-cloud flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-[10px] transition"
            >
              <PanelRightClose className="size-3.5" />
              <span>Hide AI assistance</span>
              <ShortcutHint
                shortcut={reviewShortcuts.toggleInsightsPanel}
                className="ml-auto"
              />
            </button>
          </div>
        </aside>

        {peekedSymbol &&
          peekedDefinition.data?.kind === "unresolved" &&
          (() => {
            const message = symbolPeekNotice(peekedDefinition.data.reason);
            return message ? (
              <SymbolPeekMessage message={message} peeked={peekedSymbol} />
            ) : null;
          })()}
        {peekedSymbol && peekedDefinition.data?.kind === "definition" && (
          <SymbolPeekCard
            peeked={peekedSymbol}
            definition={peekedDefinition.data}
            onClose={closeSymbolPeek}
            onHold={holdSymbolPeek}
            onOpenUnit={(unitId) => {
              const index = units.findIndex((unit) => unit.id === unitId);
              if (index >= 0) selectUnit(index);
            }}
          />
        )}

        <CommandCenter
          commands={reviewCommands}
          mode={commandCenterMode}
          onClose={() => setCommandCenterMode(undefined)}
        />
        <ShortcutSequenceIndicator sequence={pendingShortcut} />

        {hierarchyOpen && (
          <ReviewHierarchyDialog
            roots={reviewHierarchy}
            activeUnitId={activeUnit.id}
            onSelect={selectUnit}
            onClose={() => setHierarchyOpen(false)}
          />
        )}

        {resetDialogOpen && (
          <ConfirmationDialog
            title="Reset this review?"
            description={
              <>
                ReviewDuck will sync the latest pull request changes and clear
                all of your sign-offs for this PR. Comments, conversations, and
                AI results will remain.
              </>
            }
            confirmLabel="Reset review"
            pendingLabel={
              <>
                <LoaderCircle className="size-4 animate-spin" />
                Resetting…
              </>
            }
            pending={resetReview.isPending}
            icon={<Undo2 className="text-coral size-4" />}
            onCancel={() => setResetDialogOpen(false)}
            onConfirm={() =>
              resetReview.mutate({
                pullRequestId: initialData.pullRequest.id,
              })
            }
          />
        )}

        {aiReviewDialogOpen && (
          <ConfirmationDialog
            title="Review this pull request with AI?"
            description={
              <>
                The review agent will inspect all changed files and add
                evidence-backed findings beside the relevant code. This uses
                your configured model and contributes to this PR&apos;s token
                usage.
              </>
            }
            confirmLabel="Start AI review"
            pendingLabel={
              <>
                <LoaderCircle className="size-4 animate-spin" />
                Starting…
              </>
            }
            pending={startPullRequestReview.isPending}
            icon={<Sparkles className="text-violet size-4" />}
            onCancel={() => setAiReviewDialogOpen(false)}
            onConfirm={reviewPullRequestWithAi}
          />
        )}

        {conceptGroupingDialogOpen && (
          <ConfirmationDialog
            title="Regroup this review with AI?"
            description={
              <>
                The model reads the changed code and rebuilds your personal
                concepts around what the change is trying to do, so related
                edits across files are reviewed together. Every atomic unit
                stays in the review — only the grouping changes. This uses your
                configured model and contributes to this PR&apos;s token usage.
              </>
            }
            confirmLabel="Improve grouping"
            icon={<Sparkles className="text-violet size-4" />}
            onCancel={() => setConceptGroupingDialogOpen(false)}
            onConfirm={improveGroupingWithAi}
          />
        )}

        {splitConceptDialogOpen && activeConcept && (
          <ConfirmationDialog
            title="Split this concept?"
            description={
              <>
                Each of the {activeConcept.memberIds.length} units in &ldquo;
                {activeConcept.title}&rdquo; will become its own concept in your
                personal layout. Code, comments, sign-offs, and review coverage
                will not change — only how this review is grouped.
              </>
            }
            confirmLabel={`Split into ${activeConcept.memberIds.length} concepts`}
            icon={<GitBranch className="text-cyan size-4" />}
            iconClassName="bg-cyan/10"
            onCancel={() => setSplitConceptDialogOpen(false)}
            onConfirm={splitActiveConcept}
          />
        )}

        {pullRequestDetailsOpen && (
          <PullRequestDetailsDialog
            pullRequest={initialData.pullRequest}
            onClose={() => setPullRequestDetailsOpen(false)}
          />
        )}

        {moveMemberDialogOpen && activeConcept && (
          <ConceptMoveDialog
            concepts={initialData.concepts}
            currentConceptId={activeConcept.id}
            pending={movingMember}
            unitName={activeUnit.name}
            onSelect={moveActiveMemberToConcept}
            onClose={() => setMoveMemberDialogOpen(false)}
          />
        )}

        {importPreview && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-preview-title"
            className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-3 backdrop-blur-sm sm:p-6"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setImportPreview(undefined);
              }
            }}
          >
            <div className="bg-panel flex max-h-[88dvh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-line shadow-2xl">
              <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-4 sm:px-5">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="bg-cyan/10 grid size-9 shrink-0 place-items-center rounded-xl">
                    <FileCode2 className="text-cyan size-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2
                        id="import-preview-title"
                        className="text-cloud truncate font-mono text-sm font-medium"
                      >
                        {importPreview.name === "*"
                          ? importPreview.path.split("/").at(-1)
                          : importPreview.name}
                      </h2>
                      <Badge className="capitalize">
                        {importPreview.language}
                      </Badge>
                    </div>
                    <p className="text-fog mt-1 truncate font-mono text-[10px]">
                      {importPreview.path} · lines {importPreview.startLine}–
                      {importPreview.endLine}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Close source preview"
                  onClick={() => setImportPreview(undefined)}
                  className="text-mist hover:text-cloud grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-surface-subtle"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="border-cyan/15 bg-cyan/[.03] border-b px-4 py-2.5 sm:px-5">
                <p className="text-mist text-[10px] leading-4">
                  {importPreview.inReviewPath
                    ? "Read-only source context. This import is in the pull request, but is not mapped to a standalone review unit."
                    : "Read-only source context from the pull request revision. This file is outside the changed review path."}
                </p>
              </div>
              <div className="min-h-0 flex-1 overflow-auto bg-code py-4 font-mono text-[11px] leading-5">
                {importPreviewLines.map((line, index) => (
                  <div
                    key={`${importPreview.path}-${index}`}
                    ref={
                      importPreview.focusLine ===
                      importPreview.startLine + index
                        ? importPreviewFocusRef
                        : undefined
                    }
                    className={cn(
                      "grid min-w-max grid-cols-[55px_1fr] border-l-2 border-transparent px-4 hover:bg-surface-subtle",
                      importPreview.focusLine ===
                        importPreview.startLine + index &&
                        "border-cyan bg-cyan/[.055]",
                    )}
                  >
                    <span className="pr-3 text-right text-fog select-none">
                      {importPreview.startLine + index}
                    </span>
                    <pre className="syntax-code pr-6 text-cloud/80">
                      {line.tokens.length
                        ? line.tokens.map((token, tokenIndex) => (
                            <span
                              key={`${tokenIndex}-${token.text.length}`}
                              className={token.className || undefined}
                            >
                              {token.text}
                            </span>
                          ))
                        : " "}
                    </pre>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 sm:px-5">
                <span className="text-fog text-[9px]">
                  Esc closes this preview
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setImportPreview(undefined)}
                  >
                    Close
                  </Button>
                  {previewModuleIndex >= 0 && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        selectUnit(previewModuleIndex);
                        setImportPreview(undefined);
                      }}
                    >
                      Open file unit
                      <ChevronRight className="size-3" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
