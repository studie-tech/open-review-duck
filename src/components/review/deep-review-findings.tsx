"use client";

import {
  Ban,
  Check,
  FileCode2,
  LoaderCircle,
  MessageSquareText,
  Send,
  ShieldCheck,
} from "lucide-react";
import { ShortcutHint } from "~/components/command-center";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { unpublishableFindingReason } from "~/lib/review-navigation";
import { reviewShortcuts } from "~/lib/review-shortcuts";
import { cn } from "~/lib/utils";
import type { RouterOutputs } from "~/trpc/react";

type DeepReviewRun = NonNullable<RouterOutputs["review"]["deepReviewFindings"]>;
type DeepReviewFinding = DeepReviewRun["findings"][number];

export const findingSeverities = ["critical", "high", "medium", "low"] as const;
export const findingCategories = [
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
export const findingSeverityStyle: Record<string, string> = {
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
export const findingSeverityChipLabel: Record<string, string> = {
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

export const deepReviewTerminalCopy: Record<
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

export const reviewFailureClassCopy: Record<string, string> = {
  provider: "The model provider failed or refused the request.",
  timeout: "A file reviewer ran out of time.",
  budget: "The run reached its token or cost ceiling.",
  cancelled: "The run was cancelled.",
  tool_limit: "A file reviewer exhausted its tool turns.",
  unknown: "The cause was not classified.",
};

export const deepReviewItemStateCopy: Record<string, string> = {
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
export function DeepReviewFindingChip({
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
