"use client";

import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileCode2,
  FileDiff,
  Folder,
  FolderOpen,
  LoaderCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildReviewFileTree,
  filterReviewFiles,
  type ReviewFileEntry,
  type ReviewFileFilter,
  type ReviewFileTreeNode,
} from "~/lib/review-files";
import { cn } from "~/lib/utils";

/** Renders the semantic checkbox for one changed file. */
function FileReviewCheckbox({
  file,
  pending,
  onToggle,
}: {
  file: ReviewFileEntry;
  pending: boolean;
  onToggle: (file: ReviewFileEntry) => void;
}) {
  const checked = file.state === "reviewed";
  const mixed = file.state === "partial" || file.state === "waiting";
  const disabled =
    pending || file.totalUnits === 0 || (!checked && file.waitingUnits > 0);
  const action = checked ? "Return" : "Sign off";
  const checkboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = mixed;
  }, [mixed]);
  const waitReason = file.waitingUnits
    ? ` ${file.waitingUnits} ${file.waitingUnits === 1 ? "unit is" : "units are"} waiting for a response.`
    : "";
  return (
    <label
      title={
        disabled && file.waitingUnits > 0
          ? `Resolve ${file.waitingUnits} waiting ${file.waitingUnits === 1 ? "unit" : "units"} first`
          : `${action} this file`
      }
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-md border transition",
        checked
          ? "border-lime bg-lime text-accent-foreground"
          : mixed
            ? "border-cyan/45 bg-cyan/10 text-cyan"
            : "border-line-strong bg-panel hover:border-cyan/45",
        disabled && "cursor-not-allowed opacity-55",
      )}
    >
      <input
        ref={checkboxRef}
        type="checkbox"
        checked={checked}
        aria-label={`${action} ${file.totalUnits} review ${file.totalUnits === 1 ? "unit" : "units"} in ${file.path}.${waitReason}`}
        disabled={disabled}
        onChange={() => onToggle(file)}
        className="sr-only"
      />
      {pending ? (
        <LoaderCircle className="size-3 animate-spin" />
      ) : checked ? (
        <Check className="size-3" strokeWidth={3} />
      ) : mixed ? (
        <span className="h-0.5 w-2 rounded-full bg-current" />
      ) : null}
    </label>
  );
}

/** Renders one file and its non-lossy review/revision state. */
function ReviewFileRow({
  file,
  selected,
  pending,
  level,
  onSelect,
  onToggle,
}: {
  file: ReviewFileEntry;
  selected: boolean;
  pending: boolean;
  level: number;
  onSelect: (file: ReviewFileEntry) => void;
  onToggle: (file: ReviewFileEntry) => void;
}) {
  const name = file.path.split("/").at(-1) ?? file.path;
  return (
    <div
      role="treeitem"
      tabIndex={-1}
      aria-current={selected ? "page" : undefined}
      aria-label={`${file.path}, ${file.reviewedUnits} of ${file.totalUnits} review units reviewed`}
      className={cn(
        "group flex min-w-0 items-start gap-2 rounded-xl py-2 pr-2 transition",
        selected ? "bg-cyan/[.075]" : "hover:bg-surface-subtle",
      )}
      style={{ paddingLeft: `${8 + Math.min(level, 7) * 12}px` }}
    >
      <FileReviewCheckbox file={file} pending={pending} onToggle={onToggle} />
      <button
        type="button"
        onClick={() => onSelect(file)}
        className="min-w-0 flex-1 text-left"
        title={file.path}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {file.isBinary ? (
            <FileCode2 className="text-fog size-3 shrink-0" />
          ) : (
            <FileDiff className="text-fog size-3 shrink-0" />
          )}
          <span className="truncate font-mono text-[10px] text-cloud">
            {name}
          </span>
          {file.changeType !== "modified" && (
            <span className="text-fog shrink-0 text-[8px] uppercase">
              {file.changeType}
            </span>
          )}
        </span>
        <span className="text-fog mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[8px]">
          {file.totalUnits > 0 ? (
            <span>
              {file.reviewedUnits}/{file.totalUnits} reviewed
            </span>
          ) : (
            <span>No review units</span>
          )}
          {file.newUnits > 0 && (
            <span className="text-cyan">{file.newUnits} new</span>
          )}
          {file.updatedUnits > 0 && (
            <span className="text-amber-700 dark:text-amber-300">
              {file.updatedUnits} updated
            </span>
          )}
          {file.waitingUnits > 0 && (
            <span className="text-cyan flex items-center gap-1">
              <Clock3 className="size-2.5" />
              {file.waitingUnits} waiting
            </span>
          )}
        </span>
      </button>
    </div>
  );
}

/** Renders nested changed-file folders with aggregate progress. */
function ReviewFileTreeRows({
  nodes,
  level,
  selectedPath,
  pendingFileId,
  expanded,
  onExpandedChange,
  onSelect,
  onToggle,
}: {
  nodes: ReviewFileTreeNode[];
  level: number;
  selectedPath?: string;
  pendingFileId?: string;
  expanded: Set<string>;
  onExpandedChange: (path: string) => void;
  onSelect: (file: ReviewFileEntry) => void;
  onToggle: (file: ReviewFileEntry) => void;
}) {
  return nodes.map((node) => {
    if (node.kind === "file") {
      return (
        <ReviewFileRow
          key={node.path}
          file={node.file}
          level={level}
          selected={node.path === selectedPath}
          pending={node.file.id === pendingFileId}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      );
    }
    const open = expanded.has(node.path);
    return (
      <div key={node.path} role="treeitem" aria-expanded={open} tabIndex={-1}>
        <button
          type="button"
          onClick={() => onExpandedChange(node.path)}
          className="text-mist hover:bg-surface-subtle flex w-full min-w-0 items-center gap-2 rounded-lg py-1.5 pr-2 text-left transition"
          style={{ paddingLeft: `${8 + Math.min(level, 7) * 12}px` }}
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0" />
          ) : (
            <ChevronRight className="size-3 shrink-0" />
          )}
          {open ? (
            <FolderOpen className="text-cyan size-3.5 shrink-0" />
          ) : (
            <Folder className="text-fog size-3.5 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate font-mono text-[10px]">
            {node.name}
          </span>
          {node.attentionUnits > 0 && (
            <span className="text-cyan text-[8px]">{node.attentionUnits}</span>
          )}
          {node.totalUnits > 0 && (
            <span className="text-fog text-[8px]">
              {node.reviewedUnits}/{node.totalUnits}
            </span>
          )}
        </button>
        {open && (
          <div>
            <ReviewFileTreeRows
              nodes={node.children}
              level={level + 1}
              selectedPath={selectedPath}
              pendingFileId={pendingFileId}
              expanded={expanded}
              onExpandedChange={onExpandedChange}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          </div>
        )}
      </div>
    );
  });
}

/** Presents changed files as a searchable, revision-aware folder tree. */
export function ReviewFilesPanel({
  files,
  search,
  selectedPath,
  pendingFileId,
  treeLabel = "Changed files",
  emptyLabel = "No changed files match this view.",
  onSelect,
  onToggle,
}: {
  files: ReviewFileEntry[];
  search: string;
  selectedPath?: string;
  pendingFileId?: string;
  treeLabel?: string;
  emptyLabel?: string;
  onSelect: (file: ReviewFileEntry) => void;
  onToggle: (file: ReviewFileEntry) => void;
}) {
  const [filter, setFilter] = useState<ReviewFileFilter>("all");
  const [expanded, setExpanded] = useState(
    () =>
      new Set(
        files.flatMap((file) => {
          const segments = file.path.split("/");
          segments.pop();
          return segments.map((_, index) =>
            segments.slice(0, index + 1).join("/"),
          );
        }),
      ),
  );
  const filtered = useMemo(
    () => filterReviewFiles(files, filter, search),
    [files, filter, search],
  );
  const tree = useMemo(() => buildReviewFileTree(filtered), [filtered]);
  const filters: Array<{ id: ReviewFileFilter; label: string }> = [
    { id: "all", label: "All" },
    { id: "needs_review", label: "Needs review" },
    { id: "attention", label: "New & updated" },
    { id: "reviewed", label: "Reviewed" },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line px-3 py-2.5">
        <fieldset
          className="flex gap-1 overflow-x-auto"
          aria-label="Filter files"
        >
          {filters.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={filter === option.id}
              onClick={() => setFilter(option.id)}
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-[8px] transition",
                filter === option.id
                  ? "bg-cyan/10 text-cyan"
                  : "text-fog hover:bg-surface-subtle hover:text-mist",
              )}
            >
              {option.label}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tree.length > 0 ? (
          <div role="tree" aria-label={treeLabel} className="space-y-0.5">
            <ReviewFileTreeRows
              nodes={tree}
              level={0}
              selectedPath={selectedPath}
              pendingFileId={pendingFileId}
              expanded={expanded}
              onExpandedChange={(path) =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                })
              }
              onSelect={onSelect}
              onToggle={onToggle}
            />
          </div>
        ) : (
          <p className="text-mist rounded-xl border border-dashed border-line px-3 py-5 text-center text-[10px] leading-4">
            {emptyLabel}
          </p>
        )}
      </div>
    </div>
  );
}
