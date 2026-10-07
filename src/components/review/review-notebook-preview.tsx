"use client";

import { useMemo, useState } from "react";
import {
  type NotebookOutput,
  notebookOutputText,
  parseReviewNotebook,
} from "~/lib/review-notebook";
import { cn } from "~/lib/utils";
import { ProviderCommentBody } from "./provider-comment-body";
import {
  defaultMarkdownPreviewVersion,
  type MarkdownPreviewVersion,
} from "./review-markdown-preview";

/** Displays saved outputs using inert text, sanitized HTML, or raster images. */
function NotebookOutputPreview({ output }: { output: NotebookOutput }) {
  if (output.output_type === "stream")
    return (
      <pre className="overflow-auto whitespace-pre-wrap">{output.text}</pre>
    );
  if (output.output_type === "error") {
    const message =
      output.traceback?.join("\n") ??
      `${output.ename ?? "Error"}: ${output.evalue ?? ""}`;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Jupyter tracebacks contain ANSI color escapes.
    const plainMessage = message.replace(/\x1b\[[0-9;]*m/g, "");
    return (
      <pre className="overflow-auto whitespace-pre-wrap text-coral">
        {plainMessage}
      </pre>
    );
  }
  const data = output.data ?? {};
  for (const mime of ["image/png", "image/jpeg"]) {
    const image = notebookOutputText(data[mime])?.replace(/\s/g, "");
    if (image && /^[A-Za-z0-9+/]*={0,2}$/.test(image)) {
      // Notebook plots are embedded data, with no remote image requests.
      return (
        // biome-ignore lint/performance/noImgElement: Next Image cannot optimize notebook data URIs.
        <img
          src={`data:${mime};base64,${image}`}
          alt="Saved notebook output"
          className="max-h-96 max-w-full object-contain"
        />
      );
    }
  }
  const html = notebookOutputText(data["text/html"]);
  const markdown = notebookOutputText(data["text/markdown"]);
  const plain = notebookOutputText(data["text/plain"]);
  if (html || markdown)
    return (
      <ProviderCommentBody
        body={html || markdown || ""}
        variant="document"
        className="mt-0"
      />
    );
  if (plain !== undefined)
    return <pre className="overflow-auto whitespace-pre-wrap">{plain}</pre>;
  return <p className="text-fog">This output format is available in Raw.</p>;
}

/** Renders notebook cells in their saved order, without executing code. */
function NotebookPane({
  source,
  otherSource,
  compare,
}: {
  source: string;
  otherSource: string;
  compare: boolean;
}) {
  const notebook = useMemo(() => parseReviewNotebook(source), [source]);
  const other = useMemo(() => parseReviewNotebook(otherSource), [otherSource]);
  if (!source.trim())
    return (
      <p className="px-6 py-10 text-xs text-fog">
        No notebook in this revision.
      </p>
    );
  if (!notebook)
    return (
      <p role="status" className="px-6 py-10 text-xs text-fog">
        Cannot preview this notebook. Use Raw to inspect invalid JSON or an
        unsupported notebook version.
      </p>
    );
  if (!notebook.cells.length)
    return (
      <p className="px-6 py-10 text-xs text-fog">This notebook has no cells.</p>
    );
  return (
    <div className="space-y-4 p-5">
      {notebook.cells.map((cell, index) => {
        const indexedCounterpart = other?.cells[index];
        const counterpart = cell.id
          ? (other?.cells.find((candidate) => candidate.id === cell.id) ??
            (indexedCounterpart?.id ? undefined : indexedCounterpart))
          : indexedCounterpart;
        const comparableCell = { ...cell, id: undefined };
        const comparableCounterpart = counterpart
          ? { ...counterpart, id: undefined }
          : undefined;
        const changed =
          compare &&
          JSON.stringify(comparableCell) !==
            JSON.stringify(comparableCounterpart);
        return (
          <section
            key={cell.id ?? index}
            aria-label={`Cell ${index + 1}`}
            className={cn(
              "overflow-hidden rounded-lg border border-line",
              changed && "border-cyan/40",
            )}
          >
            <div className="flex items-center justify-between border-b border-line bg-surface-subtle/40 px-3 py-2 text-[10px] text-fog">
              <span>
                Cell {index + 1} ·{" "}
                {cell.cell_type === "code"
                  ? `In [${cell.execution_count ?? " "}]`
                  : cell.cell_type}
              </span>
              {changed && <span className="text-cyan">Changed cell</span>}
            </div>
            {cell.cell_type === "markdown" ? (
              <ProviderCommentBody
                body={cell.source}
                variant="document"
                className="mt-0 px-4 py-3"
              />
            ) : (
              <pre className="overflow-auto p-4 font-mono text-xs leading-6 text-cloud">
                <code>{cell.source}</code>
              </pre>
            )}
            {cell.cell_type === "code" && Boolean(cell.outputs?.length) && (
              <div className="space-y-3 border-t border-line bg-surface/30 p-4 font-mono text-xs leading-5">
                {cell.outputs?.map((output, outputIndex) => (
                  <NotebookOutputPreview key={outputIndex} output={output} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Previews current, previous, or both saved notebook revisions side by side. */
export function ReviewNotebookPreview({
  currentSource,
  previousSource = "",
  path,
}: {
  currentSource: string;
  previousSource?: string;
  path: string;
}) {
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
  const hasCurrent = Boolean(currentSource.trim());
  const hasPrevious = Boolean(previousSource.trim());
  const resolved =
    (version === "compare" && !(hasCurrent && hasPrevious)) ||
    (version === "current" && !hasCurrent) ||
    (version === "previous" && !hasPrevious)
      ? defaultMarkdownPreviewVersion({ currentSource, previousSource })
      : version;
  return (
    <div className="font-sans">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <p className="text-[10px] text-fog">
          Saved cells and outputs · Code is not executed. Use Raw for line
          comments.
        </p>
        <fieldset className="flex gap-1">
          <legend className="sr-only">Notebook revision</legend>
          {(["previous", "current", "compare"] as const)
            .filter((option) =>
              option === "previous"
                ? hasPrevious
                : option === "current"
                  ? hasCurrent
                  : hasCurrent && hasPrevious,
            )
            .map((option) => (
              <button
                key={option}
                type="button"
                aria-label={`${option[0]?.toUpperCase()}${option.slice(1)} notebook`}
                aria-pressed={resolved === option}
                onClick={() => setVersion(option)}
                className={cn(
                  "rounded-md px-3 py-1 text-[10px] capitalize",
                  resolved === option
                    ? "bg-cyan/15 text-cyan"
                    : "text-mist hover:bg-surface-hover",
                )}
              >
                {option}
              </button>
            ))}
        </fieldset>
      </div>
      {resolved === "compare" ? (
        <div className="grid lg:grid-cols-2">
          {(["previous", "current"] as const).map((side) => (
            <section
              key={side}
              aria-label={`${side} notebook`}
              className="min-w-0 border-line first:border-b lg:first:border-r lg:first:border-b-0"
            >
              <h3
                className={cn(
                  "px-5 py-2 text-[10px] font-medium uppercase",
                  side === "previous"
                    ? "bg-coral/[.06] text-coral"
                    : "bg-addition/[.06] text-addition",
                )}
              >
                {side}
              </h3>
              <NotebookPane
                source={side === "previous" ? previousSource : currentSource}
                otherSource={
                  side === "previous" ? currentSource : previousSource
                }
                compare
              />
            </section>
          ))}
        </div>
      ) : (
        <NotebookPane
          source={resolved === "previous" ? previousSource : currentSource}
          otherSource=""
          compare={false}
        />
      )}
    </div>
  );
}
