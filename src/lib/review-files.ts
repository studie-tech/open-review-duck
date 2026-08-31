export type ReviewMode = "path" | "files";

export type ReviewFileFilter =
  | "all"
  | "needs_review"
  | "attention"
  | "reviewed";

export interface ReviewFileManifestEntry {
  id: string;
  path: string;
  previousPath: string | null;
  changeType: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
  skipReason: string | null;
}

export interface FileReviewUnit {
  id: string;
  path: string;
  status: string;
  revisionState: "initial" | "new" | "updated" | "unchanged";
}

export interface ReviewFileEntry<Unit extends FileReviewUnit = FileReviewUnit>
  extends ReviewFileManifestEntry {
  units: Unit[];
  reviewedUnits: number;
  waitingUnits: number;
  newUnits: number;
  updatedUnits: number;
  totalUnits: number;
  state: "empty" | "pending" | "partial" | "reviewed" | "waiting";
}

export interface ReviewFileTreeDirectory {
  kind: "directory";
  name: string;
  path: string;
  children: ReviewFileTreeNode[];
  reviewedUnits: number;
  totalUnits: number;
  attentionUnits: number;
}

export interface ReviewFileTreeFile {
  kind: "file";
  name: string;
  path: string;
  file: ReviewFileEntry;
}

export type ReviewFileTreeNode = ReviewFileTreeDirectory | ReviewFileTreeFile;

/** Derives file progress from the atomic review ledger. */
export function reviewFileEntries<Unit extends FileReviewUnit>(
  files: readonly ReviewFileManifestEntry[],
  units: readonly Unit[],
) {
  const unitsByPath = new Map<string, Unit[]>();
  for (const unit of units) {
    const current = unitsByPath.get(unit.path) ?? [];
    current.push(unit);
    unitsByPath.set(unit.path, current);
  }
  return files
    .map((file): ReviewFileEntry<Unit> => {
      const members = unitsByPath.get(file.path) ?? [];
      const reviewedUnits = members.filter(
        ({ status }) => status === "signed_off",
      ).length;
      const waitingUnits = members.filter(
        ({ status }) => status === "waiting",
      ).length;
      const newUnits = members.filter(
        ({ revisionState }) => revisionState === "new",
      ).length;
      const updatedUnits = members.filter(
        ({ revisionState }) => revisionState === "updated",
      ).length;
      const totalUnits = members.length;
      const state =
        totalUnits === 0
          ? "empty"
          : reviewedUnits === totalUnits
            ? "reviewed"
            : waitingUnits > 0 && reviewedUnits + waitingUnits === totalUnits
              ? "waiting"
              : reviewedUnits > 0 || waitingUnits > 0
                ? "partial"
                : "pending";
      return {
        ...file,
        units: members,
        reviewedUnits,
        waitingUnits,
        newUnits,
        updatedUnits,
        totalUnits,
        state,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** Selects the units a file checkbox can still record. */
export function outstandingReviewFileUnits<Unit extends FileReviewUnit>(
  file: Pick<ReviewFileEntry<Unit>, "units">,
) {
  return file.units.filter(
    (unit) => unit.status !== "signed_off" && unit.status !== "waiting",
  );
}

/** Selects the units a file-level resume can return to the review path. */
export function waitingReviewFileUnits<Unit extends FileReviewUnit>(
  file: Pick<ReviewFileEntry<Unit>, "units">,
) {
  return file.units.filter((unit) => unit.status === "waiting");
}

/** Walks the changed-file tree in the same order the sidebar renders. */
export function flattenReviewFileTree(
  nodes: readonly ReviewFileTreeNode[],
): ReviewFileEntry[] {
  return nodes.flatMap((node) =>
    node.kind === "file" ? [node.file] : flattenReviewFileTree(node.children),
  );
}

/**
 * Compares repository paths the same way the Files sidebar walks folders:
 * directories before files at each level, then locale-sorted names.
 */
export function compareReviewFileTreePaths(left: string, right: string) {
  const leftParts = left.split("/").filter(Boolean);
  const rightParts = right.split("/").filter(Boolean);
  const limit = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < limit; index += 1) {
    const leftPart = leftParts[index] ?? "";
    const rightPart = rightParts[index] ?? "";
    const leftIsFile = index === leftParts.length - 1;
    const rightIsFile = index === rightParts.length - 1;
    if (leftPart === rightPart) {
      if (leftIsFile !== rightIsFile) return leftIsFile ? 1 : -1;
      continue;
    }
    if (leftIsFile !== rightIsFile) return leftIsFile ? 1 : -1;
    return leftPart.localeCompare(rightPart);
  }
  return leftParts.length - rightParts.length;
}

/** Orders file cards to match the changed-file sidebar. */
export function sortByReviewFileTreeOrder<Item extends { path: string }>(
  items: readonly Item[],
) {
  return [...items].sort((left, right) =>
    compareReviewFileTreePaths(left.path, right.path),
  );
}

/** How many file cards sit on each side of the selected file in Files mode. */
export const FILES_VIEWER_PAGE_SIZE = 40;
/** How many neighboring cards render full source instead of a header. */
export const FILES_VIEWER_PREVIEW_RADIUS = 2;
/** Extra tree neighbors to hydrate and syntax-preload beyond the visible window. */
export const FILES_VIEWER_PREFETCH_RADIUS = 4;

/** Builds file-sized viewer cards for every changed file that has review units. */
export function reviewFileCardsInTreeOrder<Unit extends FileReviewUnit>(
  files: readonly ReviewFileEntry<Unit>[],
) {
  return sortByReviewFileTreeOrder(
    files
      .filter((file) => file.totalUnits > 0)
      .map((file) => ({ path: file.path, members: file.units })),
  );
}

/** Window of cards around the selected file, plus how many remain on each side. */
export function windowReviewFileCards<Card>(
  cards: readonly Card[],
  selectedIndex: number,
  above: number,
  below: number,
) {
  const start = Math.max(0, selectedIndex - above);
  const end = Math.min(cards.length, selectedIndex + 1 + below);
  return {
    start,
    end,
    cards: cards.slice(start, end),
    hiddenAbove: start,
    hiddenBelow: cards.length - end,
  };
}

/** Paths around the selected file to hydrate and syntax-preload first. */
export function nearbyReviewFilePaths(
  files: readonly ReviewFileEntry[],
  activePath: string | undefined,
  radius: number,
) {
  const cards = reviewFileCardsInTreeOrder(files);
  const selectedIndex = activePath
    ? cards.findIndex((card) => card.path === activePath)
    : 0;
  const start = Math.max(0, (selectedIndex < 0 ? 0 : selectedIndex) - radius);
  const end = Math.min(
    cards.length,
    (selectedIndex < 0 ? 0 : selectedIndex) + radius + 1,
  );
  return new Set(cards.slice(start, end).map(({ path }) => path));
}

/** Finds the next file that still has work, wrapping once through the tree. */
export function nextOutstandingReviewFile<Unit extends FileReviewUnit>(
  files: readonly ReviewFileEntry<Unit>[],
  currentPath: string,
) {
  const ordered = flattenReviewFileTree(buildReviewFileTree(files));
  /** True when a file still has work and is not the one just signed off. */
  const actionable = (file: ReviewFileEntry) =>
    file.path !== currentPath && outstandingReviewFileUnits(file).length > 0;
  const currentIndex = ordered.findIndex((file) => file.path === currentPath);
  if (currentIndex < 0) return ordered.find(actionable);
  return (
    ordered.slice(currentIndex + 1).find(actionable) ??
    ordered.slice(0, currentIndex).find(actionable)
  );
}

/**
 * Filters the changed-file tree. All keeps empty and binary files visible.
 * Needs review hides signed-off files and files with no units to sign.
 */
export function filterReviewFiles(
  files: readonly ReviewFileEntry[],
  filter: ReviewFileFilter,
  search: string,
) {
  const query = search.trim().toLowerCase();
  return files.filter((file) => {
    if (query && !file.path.toLowerCase().includes(query)) return false;
    if (filter === "needs_review") {
      return file.state !== "reviewed" && file.totalUnits > 0;
    }
    if (filter === "attention")
      return file.newUnits > 0 || file.updatedUnits > 0;
    if (filter === "reviewed") return file.state === "reviewed";
    return true;
  });
}

/** One visible tree row the Files sidebar can move keyboard focus across. */
export type ReviewFileTreeFocus =
  | { kind: "directory"; path: string }
  | { kind: "file"; path: string; file: ReviewFileEntry };

/** Lists every folder path in a changed-file tree, in render order. */
export function reviewFileTreeDirectoryPaths(
  nodes: readonly ReviewFileTreeNode[],
): string[] {
  return nodes.flatMap((node) =>
    node.kind === "directory"
      ? [node.path, ...reviewFileTreeDirectoryPaths(node.children)]
      : [],
  );
}

/** Lists currently visible tree rows in render order, honoring collapsed folders. */
export function visibleReviewFileTreeItems(
  nodes: readonly ReviewFileTreeNode[],
  expanded: ReadonlySet<string>,
): ReviewFileTreeFocus[] {
  return nodes.flatMap((node) => {
    if (node.kind === "file") {
      return [{ kind: "file" as const, path: node.path, file: node.file }];
    }
    const row: ReviewFileTreeFocus = {
      kind: "directory",
      path: node.path,
    };
    return expanded.has(node.path)
      ? [row, ...visibleReviewFileTreeItems(node.children, expanded)]
      : [row];
  });
}

interface MutableDirectory {
  directories: Map<string, MutableDirectory>;
  files: ReviewFileEntry[];
  name: string;
  path: string;
}

/** Builds a deterministic folder hierarchy from repository paths. */
export function buildReviewFileTree(
  files: readonly ReviewFileEntry[],
): ReviewFileTreeNode[] {
  const root: MutableDirectory = {
    directories: new Map(),
    files: [],
    name: "",
    path: "",
  };
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    segments.pop();
    let directory = root;
    for (const segment of segments) {
      const path = directory.path ? `${directory.path}/${segment}` : segment;
      const next = directory.directories.get(segment) ?? {
        directories: new Map(),
        files: [],
        name: segment,
        path,
      };
      directory.directories.set(segment, next);
      directory = next;
    }
    directory.files.push(file);
  }

  /** Converts the mutable assembly trie into immutable display nodes. */
  function materialize(directory: MutableDirectory): ReviewFileTreeNode[] {
    const directories = [...directory.directories.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((child): ReviewFileTreeDirectory => {
        const children = materialize(child);
        return {
          kind: "directory",
          name: child.name,
          path: child.path,
          children,
          reviewedUnits: children.reduce(
            (total, node) =>
              total +
              (node.kind === "file"
                ? node.file.reviewedUnits
                : node.reviewedUnits),
            0,
          ),
          totalUnits: children.reduce(
            (total, node) =>
              total +
              (node.kind === "file" ? node.file.totalUnits : node.totalUnits),
            0,
          ),
          attentionUnits: children.reduce(
            (total, node) =>
              total +
              (node.kind === "file"
                ? node.file.newUnits + node.file.updatedUnits
                : node.attentionUnits),
            0,
          ),
        };
      });
    const fileNodes = directory.files
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(
        (file): ReviewFileTreeFile => ({
          kind: "file",
          name: file.path.split("/").at(-1) ?? file.path,
          path: file.path,
          file,
        }),
      );
    return [...directories, ...fileNodes];
  }

  return materialize(root);
}

const REVIEW_MODE_STORAGE_KEY = "reviewduck:review-mode";

/** Reads the reviewer's preferred navigation projection, defaulting to Files. */
export function storedReviewMode(storage: Pick<Storage, "getItem">) {
  try {
    return storage.getItem(REVIEW_MODE_STORAGE_KEY) === "path"
      ? ("path" as const)
      : ("files" as const);
  } catch {
    return "files" as const;
  }
}

/** Remembers the reviewer's preferred navigation projection. */
export function rememberReviewMode(
  storage: Pick<Storage, "setItem">,
  mode: ReviewMode,
) {
  try {
    storage.setItem(REVIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Browser privacy settings can make local storage unavailable.
  }
}
