"use client";

import { BookOpen, Columns2, FileCode2 } from "lucide-react";
import { useState } from "react";
import type { MarkdownReviewView } from "~/lib/review-files";
import { cn } from "~/lib/utils";
import { ProviderCommentBody } from "./provider-comment-body";

export type MarkdownPreviewVersion = "compare" | "current" | "previous";

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
}: {
  view: MarkdownReviewView;
  onChange: (view: MarkdownReviewView) => void;
}) {
  return (
    <fieldset className="flex h-8 shrink-0 items-center rounded-lg border border-line bg-surface/25 p-0.5">
      <legend className="sr-only">Markdown view</legend>
      <button
        type="button"
        aria-pressed={view === "preview"}
        aria-label="Preview view"
        title="Preview view: read the rendered Markdown document"
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
        title="Raw view: read the Markdown source, comments, and diffs"
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
}: {
  body: string;
  emptyLabel: string;
}) {
  if (!body.trim()) {
    return (
      <p className="text-fog px-6 py-10 text-center text-xs leading-5">
        {emptyLabel}
      </p>
    );
  }
  return (
    <ProviderCommentBody
      body={body}
      variant="document"
      className="mt-0 max-w-none px-6 py-5 sm:px-8"
    />
  );
}

/**
 * Shows the current Markdown document, the previous one, or both together.
 *
 * Line comments stay on Raw. Preview is for reading the prose the change
 * actually produces, including a side-by-side rendered compare when both
 * revisions exist.
 */
export function ReviewMarkdownPreview({
  currentSource,
  path,
  previousSource = "",
}: {
  currentSource: string;
  path: string;
  previousSource?: string;
}) {
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

  return (
    <div className="font-sans">
      {showVersionSwitch && (
        <div className="flex justify-end px-4 py-2 sm:px-5">
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
      {resolvedVersion === "compare" ? (
        <div className="grid lg:grid-cols-2">
          <section className="border-b border-line lg:border-r lg:border-b-0">
            <h3 className="border-coral/20 bg-coral/[.06] text-coral px-6 py-2 text-[10px] font-medium tracking-[.04em] uppercase">
              Previous
            </h3>
            <MarkdownPreviewPane
              body={previousSource}
              emptyLabel="No previous version of this Markdown file."
            />
          </section>
          <section>
            <h3 className="border-addition/20 bg-addition/[.06] text-addition px-6 py-2 text-[10px] font-medium tracking-[.04em] uppercase">
              Current
            </h3>
            <MarkdownPreviewPane
              body={currentSource}
              emptyLabel="This Markdown file is empty in the pull request."
            />
          </section>
        </div>
      ) : (
        <MarkdownPreviewPane
          body={resolvedVersion === "previous" ? previousSource : currentSource}
          emptyLabel={
            resolvedVersion === "previous"
              ? "No previous version of this Markdown file."
              : "This Markdown file is empty in the pull request."
          }
        />
      )}
    </div>
  );
}
