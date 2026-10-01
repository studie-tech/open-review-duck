import { describe, expect, it } from "vitest";
import {
  buildReviewFileTree,
  commonDirectory,
  filterReviewFiles,
  firstReviewFileUnitIndex,
  flattenReviewFileTree,
  initialReviewFileTreeDirectoryPaths,
  isUnchangedMove,
  nearbyReviewFilePaths,
  nextOutstandingReviewFile,
  outstandingReviewFileUnits,
  rememberMarkdownReviewView,
  rememberReviewMode,
  reviewChangeComposition,
  reviewFileCardsInTreeOrder,
  reviewFileEntries,
  reviewFileTreeDirectoryPaths,
  reviewFileTreeMovesPath,
  sortByReviewFileTreeOrder,
  storedMarkdownReviewView,
  storedReviewMode,
  visibleReviewFileTreeItems,
  waitingReviewFileUnits,
  windowReviewFileCards,
} from "./review-files";

describe("firstReviewFileUnitIndex", () => {
  it("starts at the first explorer file rather than the first guided unit", () => {
    const units = [
      { path: "app/tests/setup/testDatabase.ts", status: "pending" },
      { path: "app/index.ts", status: "pending" },
      { path: "app/components/button.ts", status: "signed_off" },
      { path: "app/components/button.ts", status: "pending" },
    ];
    expect(firstReviewFileUnitIndex(units)).toBe(2);
  });

  it("handles an empty review", () => {
    expect(firstReviewFileUnitIndex([])).toBe(0);
  });
});

const files = [
  {
    id: "one",
    path: "src/review/one.ts",
    previousPath: null,
    changeType: "modified",
    additions: 4,
    deletions: 1,
    isBinary: false,
    skipReason: null,
  },
  {
    id: "two",
    path: "src/two.ts",
    previousPath: null,
    changeType: "added",
    additions: 2,
    deletions: 0,
    isBinary: false,
    skipReason: null,
  },
  {
    id: "asset",
    path: "public/duck.png",
    previousPath: null,
    changeType: "modified",
    additions: 0,
    deletions: 0,
    isBinary: true,
    skipReason: null,
  },
];

const units = [
  {
    id: "reviewed",
    path: "src/review/one.ts",
    status: "signed_off",
    revisionState: "unchanged" as const,
  },
  {
    id: "updated",
    path: "src/review/one.ts",
    status: "changed",
    revisionState: "updated" as const,
  },
  {
    id: "new",
    path: "src/two.ts",
    status: "pending",
    revisionState: "new" as const,
  },
];

describe("reviewFileEntries", () => {
  it("derives file completion without inventing a file ledger", () => {
    const entries = reviewFileEntries(files, units);
    expect(entries[1]).toMatchObject({
      path: "src/review/one.ts",
      reviewedUnits: 1,
      totalUnits: 2,
      updatedUnits: 1,
      state: "partial",
    });
    expect(entries[0]).toMatchObject({
      path: "public/duck.png",
      totalUnits: 0,
      state: "empty",
    });
  });

  it("names only the units a file checkbox can still record", () => {
    const entries = reviewFileEntries(files, [
      ...units,
      {
        id: "waiting",
        path: "src/review/one.ts",
        status: "waiting",
        revisionState: "unchanged",
      },
    ]);
    const partial = entries.find(({ id }) => id === "one");
    expect(
      partial ? outstandingReviewFileUnits(partial).map(({ id }) => id) : [],
    ).toEqual(["updated"]);
    expect(
      partial ? waitingReviewFileUnits(partial).map(({ id }) => id) : [],
    ).toEqual(["waiting"]);
  });

  it("keeps revision attention independent from review progress", () => {
    const newUnit = units[2];
    if (!newUnit) throw new Error("Missing new unit fixture");
    const entries = reviewFileEntries(files, [
      ...units.filter(({ id }) => id !== "new"),
      { ...newUnit, status: "signed_off" },
    ]);
    expect(entries.find(({ id }) => id === "two")).toMatchObject({
      state: "reviewed",
      newUnits: 1,
    });
  });
});

describe("review file browsing", () => {
  it("builds nested repository folders with aggregate progress", () => {
    const tree = buildReviewFileTree(reviewFileEntries(files, units));
    const source = tree.find(
      (node) => node.kind === "directory" && node.path === "src",
    );
    expect(source).toMatchObject({
      reviewedUnits: 1,
      totalUnits: 3,
      attentionUnits: 2,
    });
    expect(reviewFileTreeDirectoryPaths(tree)).toEqual([
      "public",
      "src",
      "src/review",
    ]);
  });

  it("filters new and updated files without hiding zero-unit files from All", () => {
    const entries = reviewFileEntries(files, units);
    expect(
      filterReviewFiles(entries, "attention", "").map(({ id }) => id),
    ).toEqual(["one", "two"]);
    expect(
      filterReviewFiles(entries, "all", "duck").map(({ id }) => id),
    ).toEqual(["asset"]);
    expect(
      filterReviewFiles(entries, "needs_review", "").map(({ id }) => id),
    ).toEqual(["one", "two"]);
  });

  it("advances to the next outstanding file in sidebar order", () => {
    const entries = reviewFileEntries(files, units);
    expect(nextOutstandingReviewFile(entries, "src/review/one.ts")?.path).toBe(
      "src/two.ts",
    );
    expect(nextOutstandingReviewFile(entries, "src/two.ts")?.path).toBe(
      "src/review/one.ts",
    );
  });

  it("follows directory-before-file tree order rather than raw path sort", () => {
    const nested = reviewFileEntries(
      [
        {
          id: "root-file",
          path: "src/a.ts",
          previousPath: null,
          changeType: "modified",
          additions: 1,
          deletions: 0,
          isBinary: false,
          skipReason: null,
        },
        {
          id: "nested-file",
          path: "src/b/c.ts",
          previousPath: null,
          changeType: "modified",
          additions: 1,
          deletions: 0,
          isBinary: false,
          skipReason: null,
        },
      ],
      [
        {
          id: "root-unit",
          path: "src/a.ts",
          status: "pending",
          revisionState: "unchanged",
        },
        {
          id: "nested-unit",
          path: "src/b/c.ts",
          status: "pending",
          revisionState: "unchanged",
        },
      ],
    );
    expect(nextOutstandingReviewFile(nested, "src/b/c.ts")?.path).toBe(
      "src/a.ts",
    );
  });

  it("advances through a whole-file fallback before the next semantic file", () => {
    const ordered = reviewFileEntries(
      [
        {
          id: "snowflake-file",
          path: "app/flakegraph_app/backends/snowflake.py",
          previousPath: null,
          changeType: "modified",
          additions: 1,
          deletions: 0,
          isBinary: false,
          skipReason: null,
        },
        {
          id: "init-file",
          path: "app/flakegraph_app/ui/__init__.py",
          previousPath: null,
          changeType: "added",
          additions: 0,
          deletions: 0,
          isBinary: false,
          skipReason: null,
        },
        {
          id: "authentication-file",
          path: "app/flakegraph_app/ui/authentication.py",
          previousPath: null,
          changeType: "added",
          additions: 10,
          deletions: 0,
          isBinary: false,
          skipReason: null,
        },
      ],
      [
        {
          id: "snowflake-unit",
          path: "app/flakegraph_app/backends/snowflake.py",
          status: "signed_off",
          revisionState: "unchanged" as const,
        },
        {
          id: "init-whole-file-unit",
          path: "app/flakegraph_app/ui/__init__.py",
          status: "pending",
          revisionState: "new" as const,
        },
        {
          id: "authentication-unit",
          path: "app/flakegraph_app/ui/authentication.py",
          status: "pending",
          revisionState: "new" as const,
        },
      ],
    );

    expect(
      nextOutstandingReviewFile(
        ordered,
        "app/flakegraph_app/backends/snowflake.py",
      )?.path,
    ).toBe("app/flakegraph_app/ui/__init__.py");
  });

  it("sorts concept cards in the same order the sidebar walks the tree", () => {
    const nested = reviewFileEntries(
      [
        {
          id: "root-file",
          path: "src/a.ts",
          previousPath: null,
          changeType: "modified",
          additions: 1,
          deletions: 0,
          isBinary: false,
          skipReason: null,
        },
        {
          id: "nested-file",
          path: "src/b/c.ts",
          previousPath: null,
          changeType: "modified",
          additions: 1,
          deletions: 0,
          isBinary: false,
          skipReason: null,
        },
        {
          id: "profile",
          path: "app/src/server/api/routers/profile.ts",
          previousPath: null,
          changeType: "modified",
          additions: 1,
          deletions: 0,
          isBinary: false,
          skipReason: null,
        },
        {
          id: "user",
          path: "app/src/server/api/validators/user.ts",
          previousPath: null,
          changeType: "modified",
          additions: 1,
          deletions: 0,
          isBinary: false,
          skipReason: null,
        },
      ],
      [],
    );
    const sidebarOrder = flattenReviewFileTree(buildReviewFileTree(nested)).map(
      ({ path }) => path,
    );

    expect(
      sortByReviewFileTreeOrder([
        { path: "app/src/server/api/validators/user.ts" },
        { path: "src/a.ts" },
        { path: "app/src/server/api/routers/profile.ts" },
        { path: "src/b/c.ts" },
      ]).map(({ path }) => path),
    ).toEqual(sidebarOrder);
  });

  it("lists only expanded tree rows for keyboard focus", () => {
    const tree = buildReviewFileTree(reviewFileEntries(files, units));
    expect(
      visibleReviewFileTreeItems(tree, new Set()).map(({ path }) => path),
    ).toEqual(["public", "src"]);
    expect(
      visibleReviewFileTreeItems(tree, new Set(["src"])).map(
        ({ path }) => path,
      ),
    ).toEqual(["public", "src", "src/review", "src/two.ts"]);
  });
});

/** A file the revision moved, changing nothing unless `additions` says so. */
function movedFile(
  id: string,
  previousPath: string,
  path: string,
  additions = 0,
) {
  return {
    id,
    path,
    previousPath,
    changeType: "renamed",
    additions,
    deletions: 0,
    isBinary: false,
    skipReason: null,
  };
}

describe("moved files", () => {
  const shellMove = [
    movedFile(
      "academy-layout",
      "app/src/app/academy/layout.tsx",
      "app/src/app/[shell]/academy/layout.tsx",
    ),
    movedFile(
      "academy-page",
      "app/src/app/academy/page.tsx",
      "app/src/app/[shell]/academy/page.tsx",
    ),
    movedFile(
      "delete-page",
      "app/src/app/account/delete/page.tsx",
      "app/src/app/[shell]/account/delete/page.tsx",
    ),
    movedFile(
      "admin-page",
      "app/src/app/adminbuilding/page.tsx",
      "app/src/app/[shell]/adminbuilding/page.tsx",
      1,
    ),
    {
      id: "shell-layout",
      path: "app/src/app/[shell]/layout.tsx",
      previousPath: null,
      changeType: "added",
      additions: 12,
      deletions: 0,
      isBinary: false,
      skipReason: null,
    },
  ];
  const shellUnits = [
    {
      id: "admin-import",
      path: "app/src/app/[shell]/adminbuilding/page.tsx",
      status: "pending",
      revisionState: "initial" as const,
    },
    {
      id: "shell-layout-unit",
      path: "app/src/app/[shell]/layout.tsx",
      status: "pending",
      revisionState: "initial" as const,
    },
  ];

  it("recognizes a move that changed nothing and nothing else", () => {
    const entries = reviewFileEntries(shellMove, shellUnits);
    expect(entries.filter(isUnchangedMove).map(({ id }) => id)).toEqual([
      "academy-layout",
      "academy-page",
      "delete-page",
    ]);
    expect(
      isUnchangedMove({
        ...movedFile("stale", "old.ts", "new.ts"),
        totalUnits: 2,
      }),
    ).toBe(false);
    expect(
      isUnchangedMove({
        ...movedFile("binary", "old.png", "new.png"),
        isBinary: true,
        totalUnits: 0,
      }),
    ).toBe(false);
  });

  it("folds a relocated subtree into one row where it landed", () => {
    const tree = buildReviewFileTree(reviewFileEntries(shellMove, shellUnits));
    const shell = tree
      .flatMap((node) => (node.kind === "directory" ? [node] : []))
      .flatMap((node) => flattenDirectories(node))
      .find((node) => node.path === "app/src/app/[shell]");
    expect(shell?.children.map((node) => [node.kind, node.path])).toEqual([
      ["directory", "app/src/app/[shell]/adminbuilding"],
      ["file", "app/src/app/[shell]/layout.tsx"],
      ["moves", reviewFileTreeMovesPath("app/src/app/[shell]")],
    ]);
    const moves = shell?.children.at(-1);
    expect(moves).toMatchObject({
      kind: "moves",
      directory: "app/src/app/[shell]",
      origin: "app/src/app",
    });
    expect(
      moves?.kind === "moves" ? moves.files.map(({ id }) => id) : [],
    ).toEqual(["academy-layout", "academy-page", "delete-page"]);
    expect(shell).toMatchObject({ totalUnits: 2, reviewedUnits: 0 });
    expect(reviewFileTreeDirectoryPaths(tree)).not.toContain(
      "app/src/app/[shell]/academy",
    );
    expect(flattenReviewFileTree(tree).map(({ id }) => id)).toEqual([
      "admin-page",
      "shell-layout",
    ]);
  });

  it("keeps a moved file that also changed as an ordinary row", () => {
    const entries = reviewFileEntries(shellMove, shellUnits);
    expect(reviewFileCardsInTreeOrder(entries).map(({ path }) => path)).toEqual(
      [
        "app/src/app/[shell]/adminbuilding/page.tsx",
        "app/src/app/[shell]/layout.tsx",
      ],
    );
  });

  it("leaves the moves row closed but reachable by keyboard", () => {
    const tree = buildReviewFileTree(reviewFileEntries(shellMove, shellUnits));
    const movesPath = reviewFileTreeMovesPath("app/src/app/[shell]");
    const open = new Set(initialReviewFileTreeDirectoryPaths(tree));
    expect(open.has("app/src/app/[shell]")).toBe(true);
    expect(open.has(movesPath)).toBe(false);
    expect(
      visibleReviewFileTreeItems(tree, open).map(({ kind, path }) => [
        kind,
        path,
      ]),
    ).toContainEqual(["moves", movesPath]);
  });

  it("finds a moved file by the path it came from", () => {
    const entries = reviewFileEntries(shellMove, shellUnits);
    expect(
      filterReviewFiles(entries, "all", "app/academy/").map(({ id }) => id),
    ).toEqual(["academy-layout", "academy-page"]);
    expect(filterReviewFiles(entries, "needs_review", "")).not.toContainEqual(
      expect.objectContaining({ id: "academy-layout" }),
    );
  });

  it("names the one folder a group of moves came from", () => {
    expect(
      commonDirectory([
        "app/src/app/academy/layout.tsx",
        "app/src/app/account/delete/page.tsx",
      ]),
    ).toBe("app/src/app");
    expect(commonDirectory(["lib/a.ts", "docs/a.md"])).toBeNull();
    expect(commonDirectory([])).toBeNull();
    expect(commonDirectory(["README.md"])).toBeNull();
  });

  it("counts the files each kind of revision accounts for", () => {
    expect(
      reviewChangeComposition(reviewFileEntries(shellMove, shellUnits)),
    ).toEqual({
      movedUnchanged: 3,
      movedEdited: 1,
      modified: 0,
      added: 1,
      deleted: 0,
    });
  });
});

/** Every folder node below one folder, including itself. */
function flattenDirectories(
  node: Extract<
    ReturnType<typeof buildReviewFileTree>[number],
    { kind: "directory" }
  >,
): (typeof node)[] {
  return [
    node,
    ...node.children.flatMap((child) =>
      child.kind === "directory" ? flattenDirectories(child) : [],
    ),
  ];
}

describe("files-mode viewer cards", () => {
  it("includes every reviewable file across concepts and skips empty files", () => {
    const entries = reviewFileEntries(files, units);
    expect(reviewFileCardsInTreeOrder(entries).map(({ path }) => path)).toEqual(
      ["src/review/one.ts", "src/two.ts"],
    );
    expect(
      reviewFileCardsInTreeOrder(entries).map(({ members }) =>
        members.map(({ id }) => id),
      ),
    ).toEqual([["reviewed", "updated"], ["new"]]);
  });

  it("windows the selected file without hiding how many remain", () => {
    const cards = ["a", "b", "c", "d", "e"].map((path) => ({ path }));
    expect(windowReviewFileCards(cards, 2, 1, 1)).toEqual({
      start: 1,
      end: 4,
      cards: [{ path: "b" }, { path: "c" }, { path: "d" }],
      hiddenAbove: 1,
      hiddenBelow: 1,
    });
    expect(windowReviewFileCards(cards, 0, 2, 2).hiddenAbove).toBe(0);
    expect(windowReviewFileCards(cards, 4, 2, 2).hiddenBelow).toBe(0);
  });

  it("names nearby tree paths for prefetch around the open file", () => {
    const entries = reviewFileEntries(files, units);
    expect([...nearbyReviewFilePaths(entries, "src/two.ts", 1)]).toEqual([
      "src/review/one.ts",
      "src/two.ts",
    ]);
    expect(
      nearbyReviewFilePaths(entries, "missing.ts", 1).has("src/review/one.ts"),
    ).toBe(true);
  });
});

describe("storedReviewMode", () => {
  it("defaults to Files when no preference is saved", () => {
    expect(storedReviewMode({ getItem: () => null })).toBe("files");
  });

  it("keeps a saved Guided preference", () => {
    expect(storedReviewMode({ getItem: () => "path" })).toBe("path");
  });

  it("restores a saved Files preference", () => {
    expect(storedReviewMode({ getItem: () => "files" })).toBe("files");
  });

  it("defaults to Files when storage is unavailable", () => {
    expect(
      storedReviewMode({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe("files");
  });

  it("round-trips the reviewer's last chosen projection", () => {
    const store = new Map<string, string>();
    rememberReviewMode(
      { setItem: (key, value) => store.set(key, value) },
      "path",
    );
    expect(storedReviewMode({ getItem: (key) => store.get(key) ?? null })).toBe(
      "path",
    );
    rememberReviewMode(
      { setItem: (key, value) => store.set(key, value) },
      "files",
    );
    expect(storedReviewMode({ getItem: (key) => store.get(key) ?? null })).toBe(
      "files",
    );
  });
});

describe("storedMarkdownReviewView", () => {
  it("defaults to preview when no preference is saved", () => {
    expect(storedMarkdownReviewView({ getItem: () => null })).toBe("preview");
  });

  it("keeps a saved raw preference", () => {
    expect(storedMarkdownReviewView({ getItem: () => "raw" })).toBe("raw");
  });

  it("defaults to preview when storage is unavailable", () => {
    expect(
      storedMarkdownReviewView({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe("preview");
  });

  it("round-trips the reviewer's last chosen Markdown presentation", () => {
    const store = new Map<string, string>();
    rememberMarkdownReviewView(
      { setItem: (key, value) => store.set(key, value) },
      "raw",
    );
    expect(
      storedMarkdownReviewView({ getItem: (key) => store.get(key) ?? null }),
    ).toBe("raw");
    rememberMarkdownReviewView(
      { setItem: (key, value) => store.set(key, value) },
      "preview",
    );
    expect(
      storedMarkdownReviewView({ getItem: (key) => store.get(key) ?? null }),
    ).toBe("preview");
  });
});
