"use client";

import {
  ArrowUpFromLine,
  ChevronDown,
  Columns2,
  FileCode2,
  MessageSquareText,
  RefreshCw,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ShortcutHint } from "~/components/command-center";
import { Button } from "~/components/ui/button";
import type { KeyboardShortcut } from "~/lib/keyboard-shortcuts";
import {
  formatReviewSourceBytes,
  isHeavyReviewSource,
  reviewFileCardStartsExpanded,
  reviewSourceByteLength,
  reviewSourceKindLabel,
} from "~/lib/review-source-display";
import { useHighlightedSource } from "~/lib/syntax-highlighting";
import { cn } from "~/lib/utils";
import type { RouterOutputs } from "~/trpc/react";
import { HighlightedTokens } from "./highlighted-tokens";
import {
  ReviewFileCardHeader,
  reviewCardRanges,
  reviewedFileCard,
} from "./review-file-card";
import { ReviewBinaryPreview } from "./review-image-preview";
import {
  SourceLineWindow,
  WORKSPACE_SOURCE_ROW_HEIGHT_PX,
} from "./source-line-window";

type WorkspaceData = RouterOutputs["review"]["workspace"];
type ReviewUnit = WorkspaceData["units"][number];

/**
 * Orders a concept's members by what the reviewer still owes.
 *
 * Members are read in dependency order, which the signed-off ones no longer
 * take part in: they hold that order among themselves but sit below the work
 * that remains, so a part-reviewed concept opens on what is left.
 */
export function conceptMembersInReadingOrder<Member extends { status: string }>(
  members: readonly Member[],
) {
  return [...members].sort(
    (left, right) =>
      Number(left.status === "signed_off") -
      Number(right.status === "signed_off"),
  );
}

/** Groups one concept's atomic members into file-sized reading cards. */
export function conceptFileCardsInReadingOrder<Member extends { path: string }>(
  members: readonly Member[],
) {
  const cards: Array<{ path: string; members: Member[] }> = [];
  const cardByPath = new Map<string, (typeof cards)[number]>();
  for (const member of members) {
    const existing = cardByPath.get(member.path);
    if (existing) {
      existing.members.push(member);
      continue;
    }
    const card = { path: member.path, members: [member] };
    cards.push(card);
    cardByPath.set(member.path, card);
  }
  return cards;
}

/** Finds the atomic unit that owns a line shown inside a file card. */
export function reviewCardMemberForLine(
  members: readonly ReviewUnit[],
  line: number,
  side: "current" | "previous" = "current",
) {
  return members.find((member) => {
    const ranges = reviewCardRanges([member], side);
    return ranges.some(
      ({ startLine, endLine }) => line >= startLine && line <= endLine,
    );
  });
}

/**
 * Replaces mounted source on a folded file card.
 *
 * The highlighter is a hook, so a collapsed card must not render the body
 * that calls it. This placeholder is what the reviewer uses to open it again.
 */
export function ReviewFileCardSourcePlaceholder({
  itemLabel = "file",
  language,
  lineCount,
  onShow,
  path,
  reviewed,
  sourceBytes,
}: {
  itemLabel?: "card" | "file";
  language?: string;
  lineCount: number;
  onShow: () => void;
  path?: string;
  reviewed: boolean;
  sourceBytes?: number;
}) {
  const kind = reviewSourceKindLabel({ language, path });
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 font-sans">
      <div className="min-w-0">
        <p className="text-cloud text-[11px] font-medium">
          {lineCount.toLocaleString("en-US")}{" "}
          {lineCount === 1 ? "line" : "lines"} of {kind} hidden
        </p>
        <p className="text-fog mt-0.5 text-[10px]">
          {reviewed
            ? "Folded after review. Open it again if you need another look."
            : "Hidden so the review stays responsive."}
          {sourceBytes ? ` · ${formatReviewSourceBytes(sourceBytes)}` : null}
        </p>
      </div>
      <button
        type="button"
        onClick={onShow}
        className="text-cyan hover:border-cyan/25 hover:bg-cyan/[.05] flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[9px] transition"
      >
        Show {itemLabel}
      </button>
    </div>
  );
}

/** Preserves atomic line numbers when a full file is not available yet. */
function ReviewConceptFileCardFallbackMember({
  member,
  onCommentLine,
}: {
  member: ReviewUnit;
  onCommentLine?: (unitId: string, line: number) => void;
}) {
  const lines = useHighlightedSource(member.source, member.language);
  return (
    <div className="border-b border-line/60 last:border-b-0">
      <SourceLineWindow
        items={lines}
        rowHeight={WORKSPACE_SOURCE_ROW_HEIGHT_PX}
        startLine={member.startLine}
        renderLine={(line, lineNumber) => {
          const owner = reviewCardMemberForLine([member], lineNumber);
          return (
            <div
              key={`${member.id}-${lineNumber}`}
              className={cn(
                "group grid grid-cols-[55px_1fr] px-3 hover:bg-surface-subtle",
                !owner && "bg-surface-subtle/15 opacity-45 hover:opacity-75",
                owner && "border-l-2 border-l-cyan/30 bg-cyan/[.012]",
              )}
            >
              {owner && onCommentLine ? (
                <button
                  type="button"
                  aria-label={`Comment on line ${lineNumber} of ${member.name}`}
                  onClick={() => onCommentLine(member.id, lineNumber)}
                  className="hover:text-violet text-fog flex items-start justify-end gap-1.5 pr-3 text-right transition select-none"
                >
                  <MessageSquareText className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
                  <span>{lineNumber}</span>
                </button>
              ) : (
                <span className="text-fog flex items-start justify-end pr-3 text-right select-none">
                  {lineNumber}
                </span>
              )}
              <pre className="syntax-code overflow-visible text-cloud">
                <HighlightedTokens tokens={line.tokens} />
              </pre>
            </div>
          );
        }}
      />
    </div>
  );
}

/**
 * Renders highlighted source for one neighboring file card.
 *
 * Kept in its own component so a collapsed preview never calls the
 * highlighter hook — the same reason concept member bodies are split out.
 */
function ReviewConceptFileCardSource({
  fileSource,
  members,
  onCommentLine,
}: {
  fileSource: string;
  members: readonly ReviewUnit[];
  onCommentLine?: (unitId: string, line: number) => void;
}) {
  const ranges = useMemo(() => reviewCardRanges(members), [members]);
  const startLine = ranges.at(0)?.startLine ?? 1;
  const endLine = ranges.at(-1)?.endLine ?? startLine;
  const source = useMemo(
    () =>
      fileSource
        .split("\n")
        .slice(startLine - 1, endLine)
        .join("\n"),
    [endLine, fileSource, startLine],
  );
  const first = members[0];
  const lines = useHighlightedSource(source, first?.language ?? "text");
  // Every rendered line asks which member owns it, so ownership is indexed
  // once per member rather than scanned per line. Where member ranges overlap
  // the earliest member in the card owns the shared lines.
  const ownerByLine = useMemo(() => {
    const owners = new Map<number, ReviewUnit>();
    for (const member of members) {
      for (const { startLine: from, endLine: to } of reviewCardRanges([
        member,
      ])) {
        for (let line = from; line <= to; line += 1) {
          if (!owners.has(line)) owners.set(line, member);
        }
      }
    }
    return owners;
  }, [members]);
  if (first?.kind === "binary") {
    return <ReviewBinaryPreview path={first.path} unitId={first.id} />;
  }
  return (
    <div className="overflow-x-auto py-2">
      {fileSource ? (
        <SourceLineWindow
          items={lines}
          rowHeight={WORKSPACE_SOURCE_ROW_HEIGHT_PX}
          startLine={startLine}
          renderLine={(line, lineNumber) => {
            const owner = ownerByLine.get(lineNumber);
            return (
              <div
                key={`${members[0]?.id}-${lineNumber}`}
                className={cn(
                  "group grid grid-cols-[55px_1fr] px-3 hover:bg-surface-subtle",
                  !owner && "bg-surface-subtle/15 opacity-45 hover:opacity-75",
                  owner && "border-l-2 border-l-cyan/30 bg-cyan/[.012]",
                )}
              >
                {owner && onCommentLine ? (
                  <button
                    type="button"
                    aria-label={`Comment on line ${lineNumber} of ${owner.name}`}
                    onClick={() => onCommentLine(owner.id, lineNumber)}
                    className="hover:text-violet text-fog flex items-start justify-end gap-1.5 pr-3 text-right transition select-none"
                  >
                    <MessageSquareText className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
                    <span>{lineNumber}</span>
                  </button>
                ) : (
                  <span className="text-fog flex items-start justify-end pr-3 text-right select-none">
                    {lineNumber}
                  </span>
                )}
                <pre className="syntax-code overflow-visible text-cloud">
                  <HighlightedTokens tokens={line.tokens} />
                </pre>
              </div>
            );
          }}
        />
      ) : (
        members.map((member) => (
          <ReviewConceptFileCardFallbackMember
            key={member.id}
            member={member}
            onCommentLine={onCommentLine}
          />
        ))
      )}
    </div>
  );
}

/** Shows every same-file member as one continuous card with dimmed gaps. */
export function ReviewConceptFileCardPreview({
  members,
  index,
  count,
  fileSource,
  onSelect,
  onCommentLine,
  itemLabel = "Card",
  sourceBytes,
}: {
  members: readonly ReviewUnit[];
  index: number;
  count: number;
  fileSource: string;
  onSelect: () => void;
  onCommentLine?: (unitId: string, line: number) => void;
  itemLabel?: "Card" | "File";
  sourceBytes?: number;
}) {
  const ranges = reviewCardRanges(members);
  const startLine = ranges.at(0)?.startLine ?? 1;
  const endLine = ranges.at(-1)?.endLine ?? startLine;
  const lineCount = endLine - startLine + 1;
  const reviewed = reviewedFileCard(members);
  const heavy = isHeavyReviewSource({
    language: members[0]?.language,
    lineCount,
    path: members[0]?.path,
    source: fileSource,
  });
  const defaultExpanded = reviewFileCardStartsExpanded({ reviewed, heavy });
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [defaultExpandedState, setDefaultExpandedState] =
    useState(defaultExpanded);
  if (defaultExpanded !== defaultExpandedState) {
    setDefaultExpandedState(defaultExpanded);
    setExpanded(defaultExpanded);
  }
  const fileBytes =
    sourceBytes ?? reviewSourceByteLength({ source: fileSource });
  return (
    <article
      className={cn(
        "mx-4 overflow-hidden rounded-xl border",
        reviewed
          ? "border-addition/30 bg-addition/10"
          : "border-line bg-surface/30",
      )}
    >
      <ReviewFileCardHeader
        members={members}
        index={index}
        count={count}
        selected={false}
        onSelect={onSelect}
        itemLabel={itemLabel}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((open) => !open)}
        sourceBytes={fileBytes}
      />
      {expanded ? (
        <ReviewConceptFileCardSource
          fileSource={fileSource}
          members={members}
          onCommentLine={onCommentLine}
        />
      ) : (
        <ReviewFileCardSourcePlaceholder
          itemLabel={itemLabel === "File" ? "file" : "card"}
          language={members[0]?.language}
          lineCount={lineCount}
          onShow={() => setExpanded(true)}
          path={members[0]?.path}
          reviewed={reviewed}
          sourceBytes={fileBytes}
        />
      )}
    </article>
  );
}

/** Keeps optional file context scoped to the review unit it explains. */
export function ReviewUnitViewOptions({
  importsVisible,
  fullFileVisible,
  importsDisabled = false,
  fullFileDisabled = false,
  onToggleImports,
  onToggleFullFile,
}: {
  importsVisible: boolean;
  fullFileVisible: boolean;
  importsDisabled?: boolean;
  fullFileDisabled?: boolean;
  onToggleImports: () => void;
  onToggleFullFile: () => void;
}) {
  return (
    <span className="flex items-center gap-1 font-sans">
      <button
        type="button"
        aria-pressed={importsVisible}
        aria-label="Show imports for this unit"
        title="Show imports declared elsewhere in this file"
        disabled={importsDisabled}
        onClick={onToggleImports}
        className={cn(
          "flex h-6 items-center gap-1 rounded-md border px-1.5 text-[9px] transition disabled:cursor-not-allowed disabled:opacity-35",
          importsVisible
            ? "border-cyan/35 bg-cyan/10 text-cyan"
            : "border-line text-fog hover:border-cyan/25 hover:text-cyan",
        )}
      >
        <ArrowUpFromLine className="size-3" aria-hidden="true" />
        <span className="hidden xl:inline">Imports</span>
      </button>
      <button
        type="button"
        aria-pressed={fullFileVisible}
        aria-label="Show the full file for this unit"
        title="Show the complete file instead of the focused unit"
        disabled={fullFileDisabled}
        onClick={onToggleFullFile}
        className={cn(
          "flex h-6 items-center gap-1 rounded-md border px-1.5 text-[9px] transition disabled:cursor-not-allowed disabled:opacity-35",
          fullFileVisible
            ? "border-cyan/35 bg-cyan/10 text-cyan"
            : "border-line text-fog hover:border-cyan/25 hover:text-cyan",
        )}
      >
        <FileCode2 className="size-3" aria-hidden="true" />
        <span className="hidden xl:inline">Full file</span>
      </button>
    </span>
  );
}

/** Tests a line against disjoint ranges or a unit's contiguous bounds. */
export function lineWithinReviewRanges(
  line: number,
  ranges: Array<{ startLine: number; endLine: number }> | undefined,
  fallbackStart: number,
  fallbackEnd: number,
) {
  return ranges
    ? ranges.some(
        ({ startLine, endLine }) => line >= startLine && line <= endLine,
      )
    : line >= fallbackStart && line <= fallbackEnd;
}

/**
 * Steps a line picker to the next line a provider comment can anchor to.
 *
 * A disjoint unit prints the lines between its ranges but owns none of them,
 * so moving by one would park the picker on a line that answers a selection
 * with nothing. The current line is held when the scope has nothing further
 * in that direction.
 */
export function nextAnchorableLine(
  current: number,
  direction: -1 | 1,
  ranges: Array<{ startLine: number; endLine: number }> | undefined,
  scopeStart: number,
  scopeEnd: number,
) {
  for (
    let line = current + direction;
    line >= scopeStart && line <= scopeEnd;
    line += direction
  ) {
    if (lineWithinReviewRanges(line, ranges, scopeStart, scopeEnd)) return line;
  }
  return current;
}

export interface SplitAction {
  disabled?: boolean;
  description?: string;
  label: string;
  onSelect: () => void;
  shortcut: KeyboardShortcut;
}

/** Makes the two source representations explicit instead of hiding them in one icon. */
export function ReviewCodeViewSwitch({
  diffVisible,
  onChange,
}: {
  diffVisible: boolean;
  onChange: (diffVisible: boolean) => void;
}) {
  return (
    <fieldset className="flex h-8 shrink-0 items-center rounded-lg border border-line bg-surface/25 p-0.5">
      <legend className="sr-only">Code view</legend>
      <button
        type="button"
        aria-pressed={!diffVisible}
        aria-label="Focus view"
        title="Focus view: read the pull-request source with supporting imports and surrounding lines"
        onClick={() => onChange(false)}
        className={cn(
          "flex h-6 items-center gap-1.5 rounded-md px-2 text-[10px] transition",
          !diffVisible
            ? "bg-cyan/15 text-cyan shadow-sm"
            : "text-mist hover:bg-surface-hover hover:text-cloud",
        )}
      >
        <FileCode2 className="size-3.5" aria-hidden="true" />
        <span className="hidden lg:inline">Focus</span>
      </button>
      <button
        type="button"
        aria-pressed={diffVisible}
        aria-label="Diff view"
        title="Diff view: compare the base and pull-request versions line by line"
        onClick={() => onChange(true)}
        className={cn(
          "flex h-6 items-center gap-1.5 rounded-md px-2 text-[10px] transition",
          diffVisible
            ? "bg-cyan/15 text-cyan shadow-sm"
            : "text-mist hover:bg-surface-hover hover:text-cloud",
        )}
      >
        <Columns2 className="size-3.5" aria-hidden="true" />
        <span className="hidden lg:inline">Diff</span>
      </button>
    </fieldset>
  );
}

export const REVISION_NOTICE_DISMISS_MS = 10_000;

/**
 * Explains a newly loaded pull-request revision and then gets out of the way.
 *
 * The banner has to stay readable, but it is not a decision: after ten seconds
 * the reviewer has either absorbed it or is already in the code. The button
 * shows the remaining seconds so the auto-dismiss is not a surprise.
 */
export function ReviewRevisionLoadedNotice({
  children,
  onAcknowledge,
}: {
  children: ReactNode;
  onAcknowledge: () => void;
}) {
  const [secondsLeft, setSecondsLeft] = useState(
    Math.ceil(REVISION_NOTICE_DISMISS_MS / 1000),
  );
  const acknowledge = useRef(onAcknowledge);
  acknowledge.current = onAcknowledge;

  useEffect(() => {
    const startedAt = Date.now();
    const tick = window.setInterval(() => {
      const remainingMs = REVISION_NOTICE_DISMISS_MS - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        window.clearInterval(tick);
        acknowledge.current();
        return;
      }
      setSecondsLeft(Math.ceil(remainingMs / 1000));
    }, 250);
    return () => window.clearInterval(tick);
  }, []);

  return (
    <div
      role="status"
      className="border-cyan/20 bg-cyan/[.045] flex shrink-0 items-start gap-3 border-b px-4 py-3 sm:items-center sm:px-6"
    >
      <RefreshCw className="text-cyan mt-0.5 size-4 shrink-0 sm:mt-0" />
      <div className="min-w-0 flex-1">
        <p className="text-cloud text-xs font-medium">
          New pull-request revision loaded
        </p>
        <p className="text-mist mt-0.5 text-[10px] leading-4">{children}</p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        className="shrink-0 tabular-nums"
        aria-label={`Got it, dismissing in ${secondsLeft} ${secondsLeft === 1 ? "second" : "seconds"}`}
        onClick={() => acknowledge.current()}
      >
        Got it · {secondsLeft}s
      </Button>
    </div>
  );
}

/**
 * Renders one action beside the wider one it belongs to.
 *
 * A review reads one unit at a time and lands on the concept only at the end,
 * so the wide action is wrong to press for most of a concept and right at the
 * end of it. Putting both under one control lets the button advertise the one
 * that fits where the reviewer is standing, while the other stays one click
 * away rather than behind a key nobody has met yet.
 */
export function SplitActionButton({
  primary,
  options,
  className,
  icon,
  label,
  mobileLabel,
  menuLabel,
  pending = false,
  variant = "primary",
}: {
  primary: SplitAction;
  options: SplitAction[];
  className?: string;
  icon: ReactNode;
  label: string;
  mobileLabel: string;
  menuLabel: string;
  pending?: boolean;
  variant?: "primary" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  /** Lists the items a keyboard can actually land on. */
  const reachableItems = useCallback(
    () => [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? []),
    ],
    [],
  );

  // The menu is drawn above the buttons that open it, so it also precedes them
  // in the DOM. Without moving focus into it, opening the menu would leave the
  // reviewer tabbing backwards to reach what they just asked for.
  useEffect(() => {
    if (!open) return;
    reachableItems()[0]?.focus();
  }, [open, reachableItems]);

  /** Closes the menu and hands focus back to the control that opened it. */
  const close = useCallback(() => {
    setOpen(false);
    toggle.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    /** Closes the menu for a pointer that lands outside it. */
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }

    /** Closes the menu without letting Escape reach the workspace. */
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [close, open]);

  /** Walks the arrow keys around the items, as a menu is expected to. */
  function moveThroughItems(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = reachableItems();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next =
      current < 0 ? 0 : (current + step + items.length) % items.length;
    items[next]?.focus();
  }

  return (
    <div ref={container} className={cn("relative", className)}>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label={menuLabel}
          onKeyDown={moveThroughItems}
          className="border-line bg-panel absolute right-0 bottom-full z-30 mb-2 w-72 overflow-hidden rounded-xl border p-1 shadow-xl"
        >
          {options.map((option) => (
            <button
              key={option.label}
              type="button"
              role="menuitem"
              disabled={option.disabled}
              onClick={() => {
                close();
                option.onSelect();
              }}
              className="hover:bg-surface-hover flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-45"
            >
              <span className="min-w-0">
                <span className="text-cloud block text-xs font-medium">
                  {option.label}
                </span>
                {option.description && (
                  <span className="text-fog mt-0.5 block text-[10px] leading-4">
                    {option.description}
                  </span>
                )}
              </span>
              <ShortcutHint shortcut={option.shortcut} className="shrink-0" />
            </button>
          ))}
        </div>
      )}
      <div className="flex items-stretch">
        <Button
          variant={variant}
          className="h-10 gap-2 rounded-r-none whitespace-nowrap px-3 sm:h-11 sm:px-4"
          onClick={primary.onSelect}
          disabled={primary.disabled || pending}
        >
          {icon}
          <span className="hidden sm:inline">{label}</span>
          <span className="sm:hidden">{mobileLabel}</span>
          {!pending && (
            <ShortcutHint
              shortcut={primary.shortcut}
              className="hidden sm:inline-flex"
            />
          )}
        </Button>
        <Button
          ref={toggle}
          variant={variant}
          aria-label={menuLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          className="h-10 rounded-l-none border-l border-l-black/15 px-2 sm:h-11 dark:border-l-white/20"
          onClick={() => setOpen((current) => !current)}
          disabled={pending}
        >
          <ChevronDown
            className={cn(
              "size-3.5 transition-transform",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
        </Button>
      </div>
    </div>
  );
}
