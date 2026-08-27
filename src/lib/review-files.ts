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

/** Filters files without hiding an opened path unexpectedly. */
export function filterReviewFiles(
  files: readonly ReviewFileEntry[],
  filter: ReviewFileFilter,
  search: string,
) {
  const query = search.trim().toLowerCase();
  return files.filter((file) => {
    if (query && !file.path.toLowerCase().includes(query)) return false;
    if (filter === "needs_review") return file.state !== "reviewed";
    if (filter === "attention")
      return file.newUnits > 0 || file.updatedUnits > 0;
    if (filter === "reviewed") return file.state === "reviewed";
    return true;
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

/** Reads the reviewer's preferred navigation projection. */
export function storedReviewMode(storage: Pick<Storage, "getItem">) {
  try {
    return storage.getItem(REVIEW_MODE_STORAGE_KEY) === "files"
      ? ("files" as const)
      : ("path" as const);
  } catch {
    return "path" as const;
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
