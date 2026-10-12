"use client";

import { BookOpen, Columns2, FileCode2, MessageSquare } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { modalSurfaceClassName } from "~/components/ui/modal-surface";
import {
  type MarkdownChanges,
  markdownChangedLines,
} from "~/lib/markdown-diff";
import type { MarkdownReviewView } from "~/lib/review-files";
import { cn } from "~/lib/utils";
import { ProviderCommentBody } from "./provider-comment-body";

export type MarkdownPreviewVersion = "compare" | "current" | "previous";

/** Connects rendered prose to exact reviewable source lines and the existing composer. */
export interface MarkdownPreviewLineActions {
  currentStartLine?: number;
  previousStartLine?: number;
  canCommentLine: (line: number, side: "current" | "previous") => boolean;
  onCommentLine: (line: number, side: "current" | "previous") => void;
  selectedLine?: number;
  renderLineDetails?: (line: number) => ReactNode;
}

/** Lets a reviewer choose the precise source line behind a rendered block. */
function MarkdownCommentLinePicker({
  lines,
  onClose,
  onSelect,
  side,
}: {
  lines: Array<{ line: number; source: string }>;
  onClose: () => void;
  onSelect: (line: number) => void;
  side: "current" | "previous";
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={`Comment on ${side} Markdown source`}
      onCancel={onClose}
      className={cn(
        modalSurfaceClassName,
        "z-50 items-center justify-center p-4 backdrop:bg-black/50",
      )}
    >
      <div className="bg-panel flex max-h-[80dvh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line shadow-xl">
        <div className="flex items-center justify-between border-b border-line p-3">
          <p className="text-cloud text-sm font-medium">
            Choose a source line to comment on
          </p>
          <button type="button" onClick={onClose} className="text-cyan text-xs">
            Close
          </button>
        </div>
        <div className="overflow-y-auto p-2">
          {lines.map(({ line, source }) => (
            <button
              key={line}
              type="button"
              aria-label={`Comment on ${side} Markdown line ${line}`}
              onClick={() => onSelect(line)}
              className="grid w-full grid-cols-[3rem_1fr] gap-3 rounded px-2 py-2 text-left font-mono text-xs hover:bg-surface-hover focus-visible:outline-cyan"
            >
              <span className="text-cyan text-right">{line}</span>
              <span className="whitespace-pre-wrap break-words text-cloud">
                {source || " "}
              </span>
            </button>
          ))}
        </div>
      </div>
    </dialog>
  );
}

/**
 * Chooses the first Markdown presentation that has something to read.
 *
 * A modified file opens as a rendered compare. Added files stay on the
 * current document. Deleted files fall back to the previous document.
 */
export function defaultMarkdownPreviewVersion(input: {
  currentSource: string;
  previousSource: string;
}): MarkdownPreviewVersion {
  const hasCurrent = Boolean(input.currentSource.trim());
  const hasPrevious = Boolean(input.previousSource.trim());
  if (hasCurrent && hasPrevious) return "compare";
  if (hasPrevious && !hasCurrent) return "previous";
  return "current";
}

/** Makes rendered Markdown and raw source explicit for documentation files. */
export function ReviewMarkdownViewSwitch({
  view,
  onChange,
  documentLabel = "Markdown",
}: {
  documentLabel?: string;
  view: MarkdownReviewView;
  onChange: (view: MarkdownReviewView) => void;
}) {
  return (
    <fieldset className="flex h-8 shrink-0 items-center rounded-lg border border-line bg-surface/25 p-0.5">
      <legend className="sr-only">{documentLabel} view</legend>
      <button
        type="button"
        aria-pressed={view === "preview"}
        aria-label="Preview view"
        title={`Preview view: read the rendered ${documentLabel} document`}
        onClick={() => onChange("preview")}
        className={cn(
          "flex h-6 items-center gap-1.5 rounded-md px-2 text-[10px] transition",
          view === "preview"
            ? "bg-cyan/15 text-cyan shadow-sm"
            : "text-mist hover:bg-surface-hover hover:text-cloud",
        )}
      >
        <BookOpen className="size-3.5" aria-hidden="true" />
        <span className="hidden lg:inline">Preview</span>
      </button>
      <button
        type="button"
        aria-pressed={view === "raw"}
        aria-label="Raw view"
        title={`Raw view: read the ${documentLabel} source, comments, and diffs`}
        onClick={() => onChange("raw")}
        className={cn(
          "flex h-6 items-center gap-1.5 rounded-md px-2 text-[10px] transition",
          view === "raw"
            ? "bg-cyan/15 text-cyan shadow-sm"
            : "text-mist hover:bg-surface-hover hover:text-cloud",
        )}
      >
        <FileCode2 className="size-3.5" aria-hidden="true" />
        <span className="hidden lg:inline">Raw</span>
      </button>
    </fieldset>
  );
}

/** Renders one Markdown revision as a sanitized document, or an empty note. */
function MarkdownPreviewPane({
  body,
  emptyLabel,
  changes,
  lineActions,
  startLine = 1,
}: {
  body: string;
  emptyLabel: string;
  changes?: { lines: readonly number[]; side: "previous" | "current" };
  lineActions?: MarkdownPreviewLineActions;
  startLine?: number;
}) {
  const [pickedBlock, setPickedBlock] = useState<{
    start: number;
    end: number;
  }>();
  const sourceLines = useMemo(() => body.split("\n"), [body]);
  const side = changes?.side ?? "current";
  const renderSourceAction = useCallback(
    (start: number, end: number) => {
      if (!lineActions) return null;
      const commentable = sourceLines
        .slice(start - 1, end)
        .some((_, index) =>
          lineActions.canCommentLine(startLine + start - 1 + index, side),
        );
      if (!commentable) return null;
      return (
        <button
          type="button"
          aria-label={`Comment on ${side} Markdown lines ${startLine + start - 1}–${startLine + end - 1}`}
          title="Comment on a source line"
          className="rounded p-1 text-cyan hover:bg-surface-hover"
          onClick={() => setPickedBlock({ start, end })}
        >
          <MessageSquare className="size-3.5" aria-hidden="true" />
        </button>
      );
    },
    [lineActions, side, sourceLines, startLine],
  );
  if (!body.trim()) {
    return (
      <p className="text-fog px-6 py-10 text-center text-xs leading-5">
        {emptyLabel}
      </p>
    );
  }
  return (
    <>
      <ProviderCommentBody
        body={body}
        changes={changes}
        variant="document"
        className="mt-0 max-w-none px-6 py-5 sm:px-8"
        renderSourceAction={lineActions ? renderSourceAction : undefined}
      />
      {pickedBlock && lineActions && (
        <MarkdownCommentLinePicker
          side={side}
          lines={sourceLines
            .slice(pickedBlock.start - 1, pickedBlock.end)
            .flatMap((source, index) => {
              const line = startLine + pickedBlock.start - 1 + index;
              return lineActions.canCommentLine(line, side)
                ? [{ line, source }]
                : [];
            })}
          onClose={() => setPickedBlock(undefined)}
          onSelect={(line) => {
            setPickedBlock(undefined);
            lineActions.onCommentLine(line, side);
          }}
        />
      )}
    </>
  );
}

/**
 * Shows the current Markdown document, the previous one, or both together.
 *
 * Rendered blocks offer exact source-line comments, including in a compare.
 */
export function ReviewMarkdownPreview({
  currentSource,
  path,
  previousSource = "",
  lineActions,
}: {
  currentSource: string;
  path: string;
  previousSource?: string;
  lineActions?: MarkdownPreviewLineActions;
}) {
  const changes = useMemo(
    () => markdownChangedLines(previousSource, currentSource),
    [previousSource, currentSource],
  );
  const previousChanges = useMemo(
    () => ({ lines: changes.previous, side: "previous" as const }),
    [changes],
  );
  const currentChanges = useMemo(
    () => ({ lines: changes.current, side: "current" as const }),
    [changes],
  );
  const container = useRef<HTMLDivElement>(null);
  const hasCurrent = Boolean(currentSource.trim());
  const hasPrevious = Boolean(previousSource.trim());
  const [version, setVersion] = useState<MarkdownPreviewVersion>(() =>
    defaultMarkdownPreviewVersion({ currentSource, previousSource }),
  );
  const [versionPath, setVersionPath] = useState(path);
  if (versionPath !== path) {
    setVersionPath(path);
    setVersion(
      defaultMarkdownPreviewVersion({ currentSource, previousSource }),
    );
  }
  const showVersionSwitch = hasCurrent || hasPrevious;
  const resolvedVersion =
    version === "compare" && !(hasCurrent && hasPrevious)
      ? defaultMarkdownPreviewVersion({ currentSource, previousSource })
      : version === "previous" && !hasPrevious
        ? "current"
        : version === "current" && !hasCurrent && hasPrevious
          ? "previous"
          : version;

  const [renderedTarget, setRenderedTarget] = useState<{
    changes: MarkdownChanges;
    version: MarkdownPreviewVersion;
    path: string;
    available: boolean;
  } | null>(null);
  useEffect(() => {
    setRenderedTarget({
      changes,
      version: resolvedVersion,
      path,
      available: Boolean(
        container.current?.querySelector("[data-markdown-change]"),
      ),
    });
  }, [changes, resolvedVersion, path]);
  const hasRenderedTarget =
    renderedTarget?.changes === changes &&
    renderedTarget.version === resolvedVersion &&
    renderedTarget.path === path &&
    renderedTarget.available;

  return (
    <div ref={container} className="font-sans">
      {showVersionSwitch && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 px-4 py-2 sm:px-5",
            hasRenderedTarget ? "justify-between" : "justify-end",
          )}
        >
          {hasRenderedTarget && (
            <div className="flex items-center gap-3 text-[11px] text-mist">
              <span className="text-coral">
                − {changes.previous.length} removed{" "}
                {changes.previous.length === 1 ? "line" : "lines"}
              </span>
              <span className="text-addition">
                + {changes.current.length} added{" "}
                {changes.current.length === 1 ? "line" : "lines"}
              </span>
              <button
                type="button"
                className="rounded-md border border-line px-2 py-1 text-cloud hover:bg-surface-hover disabled:opacity-40"
                onClick={() =>
                  container.current
                    ?.querySelector("[data-markdown-change]")
                    ?.scrollIntoView({ behavior: "smooth", block: "center" })
                }
              >
                Jump to changes
              </button>
            </div>
          )}
          <fieldset className="flex h-7 shrink-0 items-center rounded-lg border border-line bg-surface/25 p-0.5">
            <legend className="sr-only">Markdown revision</legend>
            {hasPrevious && (
              <button
                type="button"
                aria-pressed={resolvedVersion === "previous"}
                aria-label="Previous Markdown"
                onClick={() => setVersion("previous")}
                className={cn(
                  "h-6 rounded-md px-2 text-[10px] transition",
                  resolvedVersion === "previous"
                    ? "bg-coral/15 text-coral shadow-sm"
                    : "text-mist hover:bg-surface-hover hover:text-cloud",
                )}
              >
                Previous
              </button>
            )}
            {hasCurrent && (
              <button
                type="button"
                aria-pressed={resolvedVersion === "current"}
                aria-label="Current Markdown"
                onClick={() => setVersion("current")}
                className={cn(
                  "h-6 rounded-md px-2 text-[10px] transition",
                  resolvedVersion === "current"
                    ? "bg-addition/15 text-addition shadow-sm"
                    : "text-mist hover:bg-surface-hover hover:text-cloud",
                )}
              >
                Current
              </button>
            )}
            {hasCurrent && hasPrevious && (
              <button
                type="button"
                aria-pressed={resolvedVersion === "compare"}
                aria-label="Compare Markdown"
                onClick={() => setVersion("compare")}
                className={cn(
                  "flex h-6 items-center gap-1 rounded-md px-2 text-[10px] transition",
                  resolvedVersion === "compare"
                    ? "bg-cyan/15 text-cyan shadow-sm"
                    : "text-mist hover:bg-surface-hover hover:text-cloud",
                )}
              >
                <Columns2 className="size-3" aria-hidden="true" />
                Compare
              </button>
            )}
          </fieldset>
        </div>
      )}
      {showVersionSwitch && (
        <p className="px-4 pb-2 text-[10px] text-fog sm:px-5">
          Highlights show changed blocks. Use Raw for exact source changes.
        </p>
      )}
      {resolvedVersion === "compare" ? (
        <div className="grid lg:grid-cols-2">
          <section className="border-b border-line lg:border-r lg:border-b-0">
            <h3 className="border-coral/20 bg-coral/[.06] text-coral px-6 py-2 text-[10px] font-medium tracking-[.04em] uppercase">
              Previous
            </h3>
            <MarkdownPreviewPane
              body={previousSource}
              changes={previousChanges}
              emptyLabel="No previous version of this Markdown file."
              lineActions={lineActions}
              startLine={lineActions?.previousStartLine}
            />
          </section>
          <section>
            <h3 className="border-addition/20 bg-addition/[.06] text-addition px-6 py-2 text-[10px] font-medium tracking-[.04em] uppercase">
              Current
            </h3>
            <MarkdownPreviewPane
              body={currentSource}
              changes={currentChanges}
              emptyLabel="This Markdown file is empty in the pull request."
              lineActions={lineActions}
              startLine={lineActions?.currentStartLine}
            />
          </section>
        </div>
      ) : (
        <MarkdownPreviewPane
          body={resolvedVersion === "previous" ? previousSource : currentSource}
          changes={
            resolvedVersion === "previous" ? previousChanges : currentChanges
          }
          emptyLabel={
            resolvedVersion === "previous"
              ? "No previous version of this Markdown file."
              : "This Markdown file is empty in the pull request."
          }
          lineActions={lineActions}
          startLine={
            resolvedVersion === "previous"
              ? lineActions?.previousStartLine
              : lineActions?.currentStartLine
          }
        />
      )}
      {lineActions?.selectedLine !== undefined && (
        <div id={`review-line-${lineActions.selectedLine}`}>
          {lineActions.renderLineDetails?.(lineActions.selectedLine)}
        </div>
      )}
    </div>
  );
}
