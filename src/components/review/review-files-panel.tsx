"use client";

import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  FileCode2,
  FileDiff,
  FileImage,
  FileX2,
  Folder,
  FolderOpen,
  FoldVertical,
  List,
  UnfoldVertical,
} from "lucide-react";
import {
  type KeyboardEvent,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildReviewFileTree,
  filterReviewFiles,
  initialReviewFileTreeDirectoryPaths,
  outstandingReviewFileUnits,
  type ReviewFileEntry,
  type ReviewFileFilter,
  type ReviewFileTreeNode,
  reviewFileTreeDirectoryPaths,
  visibleReviewFileTreeItems,
} from "~/lib/review-files";
import { isPreviewableReviewImage } from "~/lib/review-images";
import { cn } from "~/lib/utils";

/** Stable id for the focusable control of one tree row. */
function reviewFileTreeControlId(path: string) {
  return `review-file-tree-${encodeURIComponent(path)}`;
}

/** Folder paths that must be open for a file row to exist in the tree. */
function reviewFileAncestorPaths(path: string) {
  const segments = path.split("/");
  segments.pop();
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
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
  onResumeWaiting,
}: {
  file: ReviewFileEntry;
  pending: boolean;
  onToggle: (file: ReviewFileEntry) => void;
  onResumeWaiting?: (file: ReviewFileEntry) => void;
}) {
  const checked = file.state === "reviewed";
  const waitingOnly = file.state === "waiting";
  const outstanding = outstandingReviewFileUnits(file).length;
  const mixed = file.state === "partial" || waitingOnly;
  const canResume = waitingOnly && Boolean(onResumeWaiting);
  const canSignOff = !checked && outstanding > 0;
  const disabled =
    file.totalUnits === 0 || (!checked && !canSignOff && !canResume);
  const action = checked ? "Return" : canResume ? "Resume" : "Sign off";
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
        canResume
          ? `Resume ${file.waitingUnits} waiting ${file.waitingUnits === 1 ? "unit" : "units"}`
          : canSignOff && file.waitingUnits > 0
            ? `Sign off ${outstanding} outstanding ${outstanding === 1 ? "unit" : "units"}. ${file.waitingUnits} stay waiting.`
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
        onChange={() => {
          if (canResume) onResumeWaiting?.(file);
          else onToggle(file);
        }}
        className="sr-only"
      />
      {checked ? (
        <Check className="size-3" strokeWidth={3} />
      ) : waitingOnly ? (
        <Clock3 className="size-3" strokeWidth={2.5} />
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
  onResumeWaiting,
}: {
  file: ReviewFileEntry;
  selected: boolean;
  pending: boolean;
  level: number;
  onSelect: (file: ReviewFileEntry) => void;
  onToggle: (file: ReviewFileEntry) => void;
  onResumeWaiting?: (file: ReviewFileEntry) => void;
}) {
  const name = file.path.split("/").at(-1) ?? file.path;
  const waitLabel = `${file.waitingUnits} waiting ${file.waitingUnits === 1 ? "unit" : "units"}`;
  const deleted = file.changeType === "deleted";
  return (
    <li
      data-review-file-path={file.path}
      aria-current={selected ? "page" : undefined}
      aria-label={`${file.path}${deleted ? ", deleted" : ""}, ${file.reviewedUnits} of ${file.totalUnits} review units reviewed`}
      className={cn(
        "group flex min-w-0 items-center gap-2 rounded-lg py-1.5 pr-2 transition",
        selected
          ? deleted
            ? "bg-coral/[.08]"
            : "bg-cyan/[.075]"
          : "hover:bg-surface-subtle",
      )}
      style={{ paddingLeft: `${8 + Math.min(level, 7) * 12}px` }}
    >
      <FileReviewCheckbox
        file={file}
        pending={pending}
        onToggle={onToggle}
        onResumeWaiting={onResumeWaiting}
      />
      <button
        type="button"
        id={reviewFileTreeControlId(file.path)}
        onClick={() => onSelect(file)}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        title={deleted ? `${file.path} (deleted)` : file.path}
      >
        {deleted ? (
          <FileX2 className="text-coral size-3 shrink-0" />
        ) : isPreviewableReviewImage(file.path) ? (
          <FileImage className="text-fog size-3 shrink-0" />
        ) : file.isBinary ? (
          <FileCode2 className="text-fog size-3 shrink-0" />
        ) : (
          <FileDiff className="text-fog size-3 shrink-0" />
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-[10px]",
            deleted
              ? "text-coral/90 line-through decoration-coral/40"
              : "text-cloud",
          )}
        >
          {name}
        </span>
        {deleted && (
          <span className="border-coral/25 bg-coral/10 text-coral shrink-0 rounded border px-1 py-px text-[8px] font-medium tracking-wide uppercase">
            Deleted
          </span>
        )}
        {file.waitingUnits > 0 && !onResumeWaiting && (
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
      {file.waitingUnits > 0 && onResumeWaiting && (
        <button
          type="button"
          aria-label={`Resume ${waitLabel} in ${file.path}`}
          title={`Resume ${waitLabel}`}
          disabled={pending}
          onClick={() => onResumeWaiting(file)}
          className="text-cyan hover:bg-cyan/10 flex shrink-0 items-center gap-0.5 rounded px-0.5 text-[8px] transition disabled:opacity-55"
        >
          <Clock3 className="size-2.5" />
          {file.waitingUnits}
        </button>
      )}
    </li>
  );
}

/** Renders nested changed-file folders with aggregate progress. */
function ReviewFileTreeRows({
  nodes,
  level,
  selectedPath,
  pendingFileIds,
  expanded,
  onExpandedChange,
  onSelect,
  onToggle,
  onResumeWaiting,
}: {
  nodes: ReviewFileTreeNode[];
  level: number;
  selectedPath?: string;
  pendingFileIds?: ReadonlySet<string>;
  expanded: Set<string>;
  onExpandedChange: (path: string) => void;
  onSelect: (file: ReviewFileEntry) => void;
  onToggle: (file: ReviewFileEntry) => void;
  onResumeWaiting?: (file: ReviewFileEntry) => void;
}) {
  return nodes.map((node) => {
    if (node.kind === "file") {
      return (
        <ReviewFileRow
          key={node.path}
          file={node.file}
          level={level}
          selected={node.path === selectedPath}
          pending={Boolean(pendingFileIds?.has(node.file.id))}
          onSelect={onSelect}
          onToggle={onToggle}
          onResumeWaiting={onResumeWaiting}
        />
      );
    }
    const open = expanded.has(node.path);
    return (
      <li key={node.path} data-review-file-path={node.path}>
        <button
          type="button"
          id={reviewFileTreeControlId(node.path)}
          aria-expanded={open}
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
          <ul className="m-0 list-none p-0">
            <ReviewFileTreeRows
              nodes={node.children}
              level={level + 1}
              selectedPath={selectedPath}
              pendingFileIds={pendingFileIds}
              expanded={expanded}
              onExpandedChange={onExpandedChange}
              onSelect={onSelect}
              onToggle={onToggle}
              onResumeWaiting={onResumeWaiting}
            />
          </ul>
        )}
      </li>
    );
  });
}

/**
 * Presents changed files as a searchable, revision-aware folder tree.
 *
 * The workspace around it re-renders on composer keystrokes, AI stream
 * chunks and scroll state, none of which touch the tree, so the panel is
 * memoized and rebuilds its rows only when the files, the search or the
 * selection actually move.
 */
export const ReviewFilesPanel = memo(function ReviewFilesPanel({
  files,
  search,
  selectedPath,
  pendingFileIds,
  treeLabel = "Changed files",
  emptyLabel = "No changed files match this view.",
  onSelect,
  onToggle,
  onResumeWaiting,
}: {
  files: ReviewFileEntry[];
  search: string;
  selectedPath?: string;
  pendingFileIds?: ReadonlySet<string>;
  treeLabel?: string;
  emptyLabel?: string;
  onSelect: (file: ReviewFileEntry) => void;
  onToggle: (file: ReviewFileEntry) => void;
  onResumeWaiting?: (file: ReviewFileEntry) => void;
}) {
  const [filter, setFilter] = useState<ReviewFileFilter>("all");
  // Only apply review progress to the initial outline; later sign-offs must
  // not collapse folders the reviewer is currently using.
  const [expanded, setExpanded] = useState(
    () =>
      new Set(initialReviewFileTreeDirectoryPaths(buildReviewFileTree(files))),
  );
  // A folder the reviewer closes while the query forces it open. The override
  // has to be tracked apart from `expanded` because the forced-open set would
  // otherwise reinstate the folder on the next render.
  const [collapsed, setCollapsed] = useState(() => new Set<string>());
  const filtered = useMemo(
    () => filterReviewFiles(files, filter, search),
    [files, filter, search],
  );
  const tree = useMemo(() => buildReviewFileTree(filtered), [filtered]);
  // A query or a filter has to show what it matched, so the render opens the
  // ancestors of every surviving file. Keeping that out of `expanded` leaves
  // the reviewer's own folders untouched once the query clears.
  const searching = search.trim().length > 0 || filter !== "all";
  const openPaths = useMemo(() => {
    if (!searching) return expanded;
    const next = new Set([
      ...expanded,
      ...filtered.flatMap((file) => reviewFileAncestorPaths(file.path)),
    ]);
    for (const path of collapsed) next.delete(path);
    return next;
  }, [collapsed, expanded, filtered, searching]);
  const visibleItems = useMemo(
    () => visibleReviewFileTreeItems(tree, openPaths),
    [openPaths, tree],
  );

  // The override only makes sense against a forced-open folder, so it ends
  // with the query or filter that forced the folder open.
  useEffect(() => {
    if (searching) return;
    setCollapsed((current) => (current.size > 0 ? new Set() : current));
  }, [searching]);

  // Sign-off and next/previous file change `selectedPath` from outside the
  // tree. Expand any collapsed ancestors so the row exists, then scroll it
  // into the sidebar with `nearest` so an already-visible file does not jump.
  useLayoutEffect(() => {
    if (!selectedPath) return;
    const ancestors = reviewFileAncestorPaths(selectedPath);
    setExpanded((current) => {
      if (ancestors.every((path) => current.has(path))) return current;
      const next = new Set(current);
      for (const path of ancestors) next.add(path);
      return next;
    });
    setCollapsed((current) => {
      if (!ancestors.some((path) => current.has(path))) return current;
      const next = new Set(current);
      for (const path of ancestors) next.delete(path);
      return next;
    });
  }, [selectedPath]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll after ancestor folders expand so the selected row exists
  useLayoutEffect(() => {
    if (!selectedPath) return;
    const row = document
      .getElementById(reviewFileTreeControlId(selectedPath))
      ?.closest("[data-review-file-path]");
    if (!(row instanceof HTMLElement)) return;
    row.scrollIntoView?.({ block: "nearest" });
  }, [expanded, selectedPath]);

  /** Expands or collapses one folder without rebuilding the rest of the tree. */
  function onExpandedChange(path: string) {
    const open = openPaths.has(path);
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!searching) return;
    setCollapsed((current) => {
      if (open) return new Set(current).add(path);
      if (!current.has(path)) return current;
      const next = new Set(current);
      next.delete(path);
      return next;
    });
  }

  const directoryPaths = useMemo(
    () => reviewFileTreeDirectoryPaths(tree),
    [tree],
  );
  const allFoldersOpen =
    directoryPaths.length > 0 &&
    directoryPaths.every((path) => openPaths.has(path));

  /** Opens or closes every folder in the current tree. */
  function toggleAllFolders() {
    if (allFoldersOpen) {
      setExpanded(new Set());
      if (searching) setCollapsed(new Set(directoryPaths));
      return;
    }
    setExpanded(new Set(directoryPaths));
    if (searching) setCollapsed(new Set());
  }

  /** Handles optional structural shortcuts without claiming review-scroll keys. */
  function handleFileListKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
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
      if (current.kind === "directory" && !openPaths.has(current.path)) {
        event.preventDefault();
        onExpandedChange(current.path);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      if (current.kind === "directory" && openPaths.has(current.path)) {
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
        <div className="flex items-center gap-1.5">
          <fieldset
            aria-label="Filter files"
            className="bg-ink/55 m-0 flex min-w-0 flex-1 rounded-lg border border-line p-0.5 shadow-inner"
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
          {directoryPaths.length > 0 && (
            <button
              type="button"
              aria-label={
                allFoldersOpen ? "Collapse all folders" : "Expand all folders"
              }
              title={
                allFoldersOpen ? "Collapse all folders" : "Expand all folders"
              }
              onClick={toggleAllFolders}
              className="text-fog hover:bg-surface/60 hover:text-mist grid size-7 shrink-0 place-items-center rounded-md border border-line transition"
            >
              {allFoldersOpen ? (
                <FoldVertical className="size-3.5" aria-hidden="true" />
              ) : (
                <UnfoldVertical className="size-3.5" aria-hidden="true" />
              )}
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tree.length > 0 ? (
          <ul
            aria-label={treeLabel}
            className="m-0 list-none space-y-0.5 p-0"
            onKeyDown={handleFileListKeyDown}
          >
            <ReviewFileTreeRows
              nodes={tree}
              level={0}
              selectedPath={selectedPath}
              pendingFileIds={pendingFileIds}
              expanded={openPaths}
              onExpandedChange={onExpandedChange}
              onSelect={onSelect}
              onToggle={onToggle}
              onResumeWaiting={onResumeWaiting}
            />
          </ul>
        ) : (
          <p className="text-mist rounded-xl border border-dashed border-line px-3 py-5 text-center text-[10px] leading-4">
            {emptyLabel}
          </p>
        )}
      </div>
    </div>
  );
});
