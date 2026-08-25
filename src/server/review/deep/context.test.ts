import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listRepositoryFiles: vi.fn(async () => [
    "src/a.ts",
    "src/b.ts",
    ".gitignore",
  ]),
  getFileContent: vi.fn(async () => "provider source\n"),
  providerForConnection: vi.fn(),
  readSourceText: vi.fn(),
  persistSourceBlob: vi.fn(),
  hydrateReviewUnits: vi.fn(),
}));

vi.mock("~/server/providers/credentials", () => ({
  providerForConnection: mocks.providerForConnection,
}));
vi.mock("~/server/storage/source-blobs", () => ({
  readSourceText: mocks.readSourceText,
  persistSourceBlob: mocks.persistSourceBlob,
}));
vi.mock("~/server/storage/review-units", () => ({
  hydrateReviewUnits: mocks.hydrateReviewUnits,
}));

import {
  clearDeepReviewContexts,
  createDeepReviewContext,
  deepReviewRunId,
} from "./context";

const snapshotId = "00000000-0000-4000-8000-00000000aaaa";
const workspaceId = "00000000-0000-4000-8000-00000000bbbb";

/** Builds one parent or child job row shaped like the persisted table. */
function fakeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    parentJobId: null,
    workspaceId,
    snapshotId,
    provider: "openrouter",
    ...overrides,
  } as never;
}

/** Serves queued rowsets through a drizzle-shaped chainable query builder. */
function fakeDatabase(rowsets: unknown[][], units: unknown[] = []) {
  const queue = [...rowsets];
  const select = vi.fn(() => {
    // Drizzle's builder is a thenable that also chains, so the fake is a real
    // promise carrying the chain methods rather than a hand-rolled `then`.
    const chain = Promise.resolve(queue.shift() ?? []) as unknown as Record<
      string,
      unknown
    >;
    for (const method of ["from", "innerJoin", "leftJoin", "where", "limit"]) {
      chain[method] = () => chain;
    }
    return chain;
  });
  const findMany = vi.fn(async () => units);
  return {
    database: {
      select,
      query: { reviewUnits: { findMany } },
    } as never,
    select,
    findMany,
  };
}

/** Produces the scope row the context resolves before touching a provider. */
function scopeRow() {
  return [
    {
      repository: { id: "repo", externalId: "owner/repo", workspaceId },
      snapshot: { id: snapshotId, headSha: "abc123" },
      connection: { id: "connection" },
    },
  ];
}

/** Produces one changed-file row with both revisions of its source. */
function changedFileRow(overrides: Record<string, unknown> = {}) {
  return {
    file: {
      id: "file-1",
      path: "src/a.ts",
      previousPath: null,
      language: "typescript",
      changeType: "modified",
      additions: 2,
      deletions: 1,
      isBinary: false,
    },
    currentBlob: { id: "blob-current", digest: "d1", text: "current\n" },
    previousBlob: { id: "blob-previous", digest: "d0", text: "previous\n" },
    ...overrides,
  };
}

beforeEach(() => {
  clearDeepReviewContexts();
  vi.clearAllMocks();
  mocks.providerForConnection.mockResolvedValue({
    listRepositoryFiles: mocks.listRepositoryFiles,
    getFileContent: mocks.getFileContent,
  } as never);
  mocks.listRepositoryFiles.mockResolvedValue([
    "src/a.ts",
    "src/b.ts",
    "src/secrets/token.ts",
  ]);
  mocks.getFileContent.mockResolvedValue("provider source\n");
  mocks.readSourceText.mockImplementation(
    async (blob: { text?: string }) => blob.text ?? "",
  );
  mocks.persistSourceBlob.mockResolvedValue({
    id: "blob-new",
    digest: "d2",
  } as never);
  mocks.hydrateReviewUnits.mockImplementation(
    async (_db: unknown, units: unknown[]) => units,
  );
});

describe("deep review repository context", () => {
  it("resolves one tree for a whole run instead of one per child", async () => {
    const { database, select } = fakeDatabase([scopeRow(), [changedFileRow()]]);
    const parent = fakeJob();
    const children = [1, 2, 3].map((index) =>
      fakeJob({
        id: `00000000-0000-4000-8000-00000000000${index + 1}`,
        parentJobId: (parent as unknown as { id: string }).id,
      }),
    );

    const contexts = await Promise.all(
      [parent, ...children].map((job) =>
        createDeepReviewContext(database, { job }),
      ),
    );
    await Promise.all(contexts.map((context) => context.listFiles()));

    expect(new Set(contexts).size).toBe(1);
    expect(select).toHaveBeenCalledTimes(2);
    expect(mocks.listRepositoryFiles).toHaveBeenCalledTimes(1);
    expect(mocks.providerForConnection).toHaveBeenCalledTimes(1);
    expect(deepReviewRunId(children[0] as never)).toBe(
      (parent as unknown as { id: string }).id,
    );
  });

  it("rebuilds only after the run disposes its context", async () => {
    const first = fakeDatabase([scopeRow(), [changedFileRow()]]);
    const context = await createDeepReviewContext(first.database, {
      job: fakeJob(),
    });
    await context.listFiles();
    expect(
      await createDeepReviewContext(first.database, { job: fakeJob() }),
    ).toBe(context);

    context.dispose();
    const second = fakeDatabase([scopeRow(), [changedFileRow()]]);
    const rebuilt = await createDeepReviewContext(second.database, {
      job: fakeJob(),
    });
    await rebuilt.listFiles();

    expect(rebuilt).not.toBe(context);
    expect(mocks.listRepositoryFiles).toHaveBeenCalledTimes(2);
  });

  it("forgets a failed build so the next child can retry it", async () => {
    const failing = fakeDatabase([[], []]);
    await expect(
      createDeepReviewContext(failing.database, { job: fakeJob() }),
    ).rejects.toThrow("Deep review repository scope not found");

    const recovered = fakeDatabase([scopeRow(), [changedFileRow()]]);
    await expect(
      createDeepReviewContext(recovered.database, { job: fakeJob() }),
    ).resolves.toBeDefined();
  });

  it("refuses a snapshot the job is not pinned to", async () => {
    const { database } = fakeDatabase([scopeRow(), [changedFileRow()]]);
    await expect(
      createDeepReviewContext(database, {
        job: fakeJob(),
        snapshot: { id: "other-snapshot" } as never,
      }),
    ).rejects.toThrow("disagree on the revision");
  });

  it("prefers the snapshot's own blob and caches provider reads", async () => {
    const { database } = fakeDatabase([scopeRow(), [changedFileRow()]]);
    const context = await createDeepReviewContext(database, { job: fakeJob() });

    const changed = await context.readFile("src/a.ts", 1_000);
    expect(changed?.source).toBe("current\n");
    expect(changed?.snapshotFileId).toBe("file-1");
    expect(mocks.getFileContent).not.toHaveBeenCalled();
    expect(await context.readPreviousSource("src/a.ts")).toBe("previous\n");

    await context.readFile("src/b.ts", 1_000);
    await context.readFile("src/b.ts", 1_000);
    expect(mocks.getFileContent).toHaveBeenCalledTimes(1);
    expect(await context.readFile("src/b.ts", 4)).toBeUndefined();
    expect(await context.readFile("src/absent.ts", 1_000)).toBeUndefined();
  });

  it("applies the source policy to every provider", async () => {
    const { database } = fakeDatabase([scopeRow(), [changedFileRow()]]);
    const context = await createDeepReviewContext(database, {
      job: fakeJob(),
    });
    expect(await context.sourceDecision("src/secrets/token.ts", "")).toEqual({
      allowed: false,
      reason: "protected_path",
    });
    expect(
      await context.sourceDecision("src/a.ts", "AKIA0123456789ABCDEF"),
    ).toEqual({ allowed: false, reason: "secret_detected" });
    expect(await context.sourceDecision("src/a.ts", "current")).toEqual({
      allowed: true,
    });
  });

  it("hydrates the snapshot's units once for every searching child", async () => {
    const { database, findMany } = fakeDatabase(
      [scopeRow(), [changedFileRow()]],
      [
        {
          id: "unit-1",
          path: "src/a.ts",
          name: "handler",
          kind: "function",
          startLine: 10,
          endLine: 20,
          source: "export function handler() { return TOKEN; }",
        },
      ],
    );
    const context = await createDeepReviewContext(database, { job: fakeJob() });

    const hits = await context.searchCode({ query: "token" });
    expect(hits).toEqual([
      {
        path: "src/a.ts",
        unitId: "unit-1",
        symbol: "handler",
        kind: "function",
        startLine: 10,
        endLine: 20,
        source: "export function handler() { return TOKEN; }",
      },
    ]);
    await context.searchCode({ query: "handler", pathPrefix: "docs/" });
    expect(
      await context.searchCode({ query: "handler", pathPrefix: "docs/" }),
    ).toHaveLength(0);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(mocks.hydrateReviewUnits).toHaveBeenCalledTimes(1);
  });
});
