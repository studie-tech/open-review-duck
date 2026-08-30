"use client";

import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  FileCode2,
  FileDiff,
  Folder,
  FolderOpen,
  List,
} from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildReviewFileTree,
  filterReviewFiles,
  type ReviewFileEntry,
  type ReviewFileFilter,
  type ReviewFileTreeNode,
  visibleReviewFileTreeItems,
} from "~/lib/review-files";
import { cn } from "~/lib/utils";

/** Stable id for the focusable control of one tree row. */
function reviewFileTreeControlId(path: string) {
  return `review-file-tree-${encodeURIComponent(path)}`;
}

const filters = [
  { id: "all" as const, icon: List, label: "All" },
  { id: "needs_review" as const, icon: CircleDot, label: "New" },
];

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
  const disabled = file.totalUnits === 0 || (!checked && file.waitingUnits > 0);
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
        // The control is visually hidden with `sr-only` (`position: absolute`).
        // Without a positioned clip on this label, that input is laid out
        // against the fixed workspace shell. Focusing it then scrolls that
        // `overflow: hidden` shell and shoves the whole review into the top
        // of the window.
        "relative grid size-5 shrink-0 place-items-center overflow-hidden rounded-md border transition",
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
        disabled={disabled || pending}
        onMouseDown={(event) => event.preventDefault()}
        onChange={() => onToggle(file)}
        className="sr-only"
      />
      {checked ? (
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
      data-review-file-path={file.path}
      aria-current={selected ? "page" : undefined}
      aria-label={`${file.path}, ${file.reviewedUnits} of ${file.totalUnits} review units reviewed`}
      className={cn(
        "group flex min-w-0 items-center gap-2 rounded-lg py-1.5 pr-2 transition",
        selected ? "bg-cyan/[.075]" : "hover:bg-surface-subtle",
      )}
      style={{ paddingLeft: `${8 + Math.min(level, 7) * 12}px` }}
    >
      <FileReviewCheckbox file={file} pending={pending} onToggle={onToggle} />
      <button
        type="button"
        id={reviewFileTreeControlId(file.path)}
        onClick={() => onSelect(file)}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        title={file.path}
      >
        {file.isBinary ? (
          <FileCode2 className="text-fog size-3 shrink-0" />
        ) : (
          <FileDiff className="text-fog size-3 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-cloud">
          {name}
        </span>
        {file.waitingUnits > 0 && (
          <span className="text-cyan flex shrink-0 items-center gap-0.5 text-[8px]">
            <Clock3 className="size-2.5" />
            {file.waitingUnits}
          </span>
        )}
        {file.newUnits + file.updatedUnits > 0 && (
          <span className="text-cyan shrink-0 text-[8px]">
            {file.newUnits + file.updatedUnits}
          </span>
        )}
        {file.totalUnits > 0 && (
          <span className="text-fog shrink-0 text-[8px]">
            {file.reviewedUnits}/{file.totalUnits}
          </span>
        )}
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
      <div
        key={node.path}
        role="treeitem"
        aria-expanded={open}
        tabIndex={-1}
        data-review-file-path={node.path}
      >
        <button
          type="button"
          id={reviewFileTreeControlId(node.path)}
          aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`}
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
  const visibleItems = useMemo(
    () => visibleReviewFileTreeItems(tree, expanded),
    [expanded, tree],
  );

  /** Expands or collapses one folder without rebuilding the rest of the tree. */
  function onExpandedChange(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  /** Moves keyboard focus across visible tree rows without changing mouse behavior. */
  function handleTreeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const keys = [
      "ArrowDown",
      "ArrowUp",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
    ];
    if (!keys.includes(event.key)) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const currentPath =
      target
        .closest("[data-review-file-path]")
        ?.getAttribute("data-review-file-path") ??
      (target.id.startsWith("review-file-tree-")
        ? decodeURIComponent(target.id.slice("review-file-tree-".length))
        : undefined);
    const currentIndex = visibleItems.findIndex(
      (item) => item.path === currentPath,
    );
    const current =
      currentIndex >= 0 ? visibleItems[currentIndex] : visibleItems[0];
    if (!current) return;

    /** Focuses the control for one visible tree row. */
    const focusPath = (path: string) => {
      document.getElementById(reviewFileTreeControlId(path))?.focus();
    };
    const parentPath = current.path.includes("/")
      ? current.path.slice(0, current.path.lastIndexOf("/"))
      : undefined;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next =
        visibleItems[
          Math.min(
            visibleItems.length - 1,
            Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + delta),
          )
        ];
      if (next) focusPath(next.path);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      const first = visibleItems[0];
      if (first) focusPath(first.path);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      const last = visibleItems.at(-1);
      if (last) focusPath(last.path);
      return;
    }
    if (event.key === "ArrowRight") {
      if (current.kind === "directory" && !expanded.has(current.path)) {
        event.preventDefault();
        onExpandedChange(current.path);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      if (current.kind === "directory" && expanded.has(current.path)) {
        event.preventDefault();
        onExpandedChange(current.path);
        return;
      }
      if (parentPath) {
        event.preventDefault();
        focusPath(parentPath);
      }
      return;
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line px-4 py-2.5">
        <fieldset
          aria-label="Filter files"
          className="bg-ink/55 m-0 flex w-full min-w-0 rounded-lg border border-line p-0.5 shadow-inner"
        >
          {filters.map((option) => {
            const Icon = option.icon;
            const selected = filter === option.id;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                onClick={() => setFilter(option.id)}
                className={cn(
                  "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 text-[10px] font-medium transition",
                  selected
                    ? "bg-surface text-cloud shadow-sm ring-1 ring-line-strong"
                    : "text-fog hover:bg-surface/60 hover:text-mist",
                )}
              >
                <Icon
                  className={cn("size-3", selected && "text-cyan")}
                  aria-hidden="true"
                />
                {option.label}
              </button>
            );
          })}
        </fieldset>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tree.length > 0 ? (
          <div
            role="tree"
            aria-label={treeLabel}
            className="space-y-0.5"
            onKeyDown={handleTreeKeyDown}
          >
            <ReviewFileTreeRows
              nodes={tree}
              level={0}
              selectedPath={selectedPath}
              pendingFileId={pendingFileId}
              expanded={expanded}
              onExpandedChange={onExpandedChange}
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
