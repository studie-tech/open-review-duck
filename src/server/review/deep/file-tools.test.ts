import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/env", () => ({
  env: {
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    AI_MAX_SOURCE_BYTES: 8 * 1024 * 1024,
    AI_MAX_DISTINCT_FILES: 40,
  },
}));

import { aiReviewFindings } from "@/drizzle/schema";
import { openVaultSecret } from "~/server/security/vault";
import type { DeepReviewContext } from "./context";
import {
  type DeepReviewFileToolContext,
  type DeepReviewToolInvocation,
  deepReviewFileFinished,
  deepReviewFileTools,
} from "./file-tools";

const workspaceId = "00000000-0000-4000-8000-00000000bbbb";
const jobId = "00000000-0000-4000-8000-000000000002";

interface InsertedRow {
  table: string;
  values: Record<string, unknown>[];
}

interface FakeDatabaseOptions {
  beforeFindingInsert?: () => Promise<void>;
}

/** Collects inserted rows and enforces the primary keys the schema declares. */
function fakeDatabase(options: FakeDatabaseOptions = {}) {
  const inserts: InsertedRow[] = [];
  const findings = new Map<string, Record<string, unknown>>();
  const evidence: Record<string, unknown>[] = [];
  const database = {
    insert: (table: unknown) => ({
      values: (rows: Record<string, unknown> | Record<string, unknown>[]) => ({
        onConflictDoNothing: async () => {
          const list = Array.isArray(rows) ? rows : [rows];
          const name =
            table === aiReviewFindings
              ? "ai_review_finding"
              : "ai_job_evidence";
          if (name === "ai_review_finding") {
            await options.beforeFindingInsert?.();
          }
          inserts.push({ table: name, values: list });
          for (const row of list) {
            if (name === "ai_review_finding") {
              if (!findings.has(String(row.id))) {
                findings.set(String(row.id), row);
              }
            } else {
              evidence.push(row);
            }
          }
        },
      }),
    }),
  };
  return { database: database as never, inserts, findings, evidence };
}

/** Exposes a promise and its resolver for deliberately interleaved calls. */
function deferred() {
  /** Resolves the promise once the test reaches its intended interleave. */
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Mimics `persistToolCall`: the first call runs the handler and stores its
 * output, and every replay returns that output without re-running anything.
 */
function fakeExecutor() {
  const stored = new Map<string, unknown>();
  const handlerRuns: string[] = [];
  /** Replays a stored output instead of running the handler a second time. */
  const execute = async (invocation: DeepReviewToolInvocation) => {
    if (stored.has(invocation.callId)) return stored.get(invocation.callId);
    handlerRuns.push(invocation.name);
    const output = await invocation.execute();
    stored.set(invocation.callId, output);
    return output;
  };
  return { execute, stored, handlerRuns };
}

/** Builds a repository context stub with the two revisions of one file. */
function fakeRepository(overrides: Partial<DeepReviewContext> = {}) {
  const current = "one\ntwo changed\nthree\nfour\nfive\n";
  const previous = "one\ntwo\nthree\nfour\nfive\n";
  return {
    runJobId: "run",
    snapshot: { id: "snapshot" },
    repository: { id: "repository" },
    listFiles: async () => ["src/a.ts", "src/secrets/token.ts"],
    readFile: async (path: string) =>
      path === "src/a.ts"
        ? {
            blob: { id: "blob-current", digest: "d1" },
            snapshotFileId: "file-1",
            source: current,
          }
        : {
            blob: { id: "blob-secret", digest: "d9" },
            source: "AKIA0123456789ABCDEF\n",
          },
    readPreviousSource: async (path: string) =>
      path === "src/a.ts" ? previous : undefined,
    searchCode: async () => [
      {
        path: "src/a.ts",
        unitId: "unit-1",
        symbol: "handler",
        kind: "function",
        startLine: 2,
        endLine: 4,
        source: "two changed",
      },
    ],
    units: async () => [
      {
        path: "src/a.ts",
        name: "handler",
        kind: "function",
        startLine: 2,
        endLine: 4,
        changeType: "modified",
      },
    ],
    changedFile: (path: string) =>
      path === "src/a.ts"
        ? {
            snapshotFileId: "file-1",
            path,
            previousPath: null,
            language: "typescript",
            changeType: "modified",
            additions: 1,
            deletions: 1,
            isBinary: false,
            currentBlob: { id: "blob-current", digest: "d1" },
            previousBlob: { id: "blob-previous", digest: "d0" },
          }
        : undefined,
    changedFiles: () => [],
    sourceDecision: async (path: string) =>
      path.includes("secrets")
        ? { allowed: false, reason: "protected_path" }
        : { allowed: true },
    dispose: () => undefined,
    ...overrides,
  } as unknown as DeepReviewContext;
}

/** Assembles the tool context a single file scout runs with. */
function fakeToolContext(overrides: Partial<DeepReviewFileToolContext> = {}): {
  context: DeepReviewFileToolContext;
  db: ReturnType<typeof fakeDatabase>;
  executor: ReturnType<typeof fakeExecutor>;
} {
  const db = fakeDatabase();
  const executor = fakeExecutor();
  return {
    db,
    executor,
    context: {
      db: db.database,
      job: { id: jobId, workspaceId, provider: "opencode" } as never,
      item: { id: "item-1", path: "src/a.ts" },
      repository: fakeRepository(),
      execute: executor.execute,
      ...overrides,
    },
  };
}

/** Wraps expected text in the framing every source-returning tool applies. */
function untrusted(source: string) {
  return `<untrusted-file path="src/a.ts">${source}</untrusted-file>`;
}

/** Shapes the options object the AI SDK passes to a tool body. */
const toolOptions = (toolCallId: string) =>
  ({ toolCallId, messages: [] }) as never;

/** Invokes one tool the way the AI SDK invokes it. */
async function callTool(
  tools: ReturnType<typeof deepReviewFileTools>,
  name: keyof ReturnType<typeof deepReviewFileTools>,
  input: unknown,
  callId: string,
) {
  const tool = tools[name] as {
    execute: (input: unknown, options: unknown) => Promise<unknown>;
  };
  return (await tool.execute(input, toolOptions(callId))) as Record<
    string,
    unknown
  >;
}

const finding = {
  title: "Unvalidated input",
  body: "The handler trusts the request body.",
  existing_code: "two changed",
  severity: "HIGH",
  category: "security",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("report_finding persistence", () => {
  it("writes rows inside the tool body and keeps them across a replay", async () => {
    const { context, db, executor } = fakeToolContext();
    const first = await callTool(
      deepReviewFileTools(context),
      "report_finding",
      { findings: [finding, { ...finding, title: "Second" }] },
      "call-1",
    );

    expect(first.accepted).toBe(2);
    expect(db.findings.size).toBe(2);
    expect(executor.handlerRuns).toEqual(["report_finding"]);

    // A replayed durable step rebuilds the tools in a fresh process. The stored
    // tool output comes back without the handler running, which is exactly why
    // a post-turn findings buffer would lose every row.
    const replayContext = fakeToolContext({ db: db.database }).context;
    const replay = await callTool(
      deepReviewFileTools({ ...replayContext, execute: executor.execute }),
      "report_finding",
      { findings: [finding, { ...finding, title: "Second" }] },
      "call-1",
    );

    expect(replay).toEqual(first);
    expect(db.findings.size).toBe(2);
    expect(executor.handlerRuns).toEqual(["report_finding"]);
    expect(
      db.inserts.filter((insert) => insert.table === "ai_review_finding"),
    ).toHaveLength(1);
  });

  it("seals the reported content against the finding's own id", async () => {
    const { context, db } = fakeToolContext();
    const result = await callTool(
      deepReviewFileTools(context),
      "report_finding",
      { findings: [{ ...finding, suggestion_code: "validate(body)" }] },
      "call-2",
    );

    const id = (result.findingIds as string[])[0] as string;
    const row = db.findings.get(id) as Record<string, string>;
    const sealed = row.encryptedContent ?? "";
    expect(row.path).toBe("src/a.ts");
    expect(row.itemId).toBe("item-1");
    expect(row.jobId).toBe(jobId);
    expect(row.workspaceId).toBe(workspaceId);
    expect(
      JSON.parse(
        await openVaultSecret(
          { workspaceId, recordId: id, provider: "ai-review-finding" },
          sealed,
        ),
      ),
    ).toEqual({
      title: finding.title,
      body: finding.body,
      existingCode: "two changed",
      suggestionCode: "validate(body)",
    });
  });

  it("degrades an unknown severity and category rather than rejecting", async () => {
    const { context, db } = fakeToolContext();
    const result = await callTool(
      deepReviewFileTools(context),
      "report_finding",
      {
        findings: [{ ...finding, severity: "catastrophic", category: "vibes" }],
      },
      "call-3",
    );

    const id = (result.findingIds as string[])[0] as string;
    expect(db.findings.get(id)).toMatchObject({
      severity: "low",
      category: "other",
    });
  });

  it("stops accepting findings once the file reaches its cap", async () => {
    const { context, db } = fakeToolContext({
      limits: { maxFindings: 1 },
    });
    const tools = deepReviewFileTools(context);
    await callTool(tools, "report_finding", { findings: [finding] }, "call-4");
    const second = await callTool(
      tools,
      "report_finding",
      { findings: [{ ...finding, title: "Third" }] },
      "call-5",
    );

    expect(second).toMatchObject({ accepted: 0, declined: 1, findingIds: [] });
    expect(db.findings.size).toBe(1);
  });

  it("reserves the cap before concurrent finding preparation can overlap", async () => {
    const entered = deferred();
    const release = deferred();
    let inserts = 0;
    const db = fakeDatabase({
      beforeFindingInsert: async () => {
        inserts += 1;
        if (inserts !== 1) return;
        entered.resolve();
        await release.promise;
      },
    });
    const context = fakeToolContext({
      db: db.database,
      limits: { maxFindings: 1 },
    }).context;
    const tools = deepReviewFileTools(context);
    const first = callTool(
      tools,
      "report_finding",
      { findings: [finding] },
      "concurrent-1",
    );
    await entered.promise;
    const second = await callTool(
      tools,
      "report_finding",
      { findings: [{ ...finding, title: "Second" }] },
      "concurrent-2",
    );
    release.resolve();

    await expect(first).resolves.toMatchObject({ accepted: 1, declined: 0 });
    expect(second).toMatchObject({ accepted: 0, declined: 1 });
    expect(db.findings.size).toBe(1);
  });

  it("releases a reservation when finding persistence fails", async () => {
    let fail = true;
    const db = fakeDatabase({
      beforeFindingInsert: async () => {
        if (!fail) return;
        fail = false;
        throw new Error("injected finding insert failure");
      },
    });
    const context = fakeToolContext({
      db: db.database,
      limits: { maxFindings: 1 },
    }).context;
    const tools = deepReviewFileTools(context);

    await expect(
      callTool(tools, "report_finding", { findings: [finding] }, "failed-call"),
    ).rejects.toThrow("injected finding insert failure");
    await expect(
      callTool(tools, "report_finding", { findings: [finding] }, "retry-call"),
    ).resolves.toMatchObject({ accepted: 1, declined: 0 });
    expect(db.findings.size).toBe(1);
  });
});

describe("file scout source tools", () => {
  it("returns a unified diff and grounds both revisions in evidence", async () => {
    const { context, db } = fakeToolContext();
    const result = await callTool(
      deepReviewFileTools(context),
      "read_diff",
      {},
      "call-6",
    );

    expect(result.changeType).toBe("modified");
    expect(String(result.diff)).toBe(
      untrusted(
        [
          "@@ -1,5 +1,5 @@",
          " one",
          "-two",
          "+two changed",
          " three",
          " four",
          " five",
        ].join("\n"),
      ),
    );
    expect(new Set(db.evidence.map((row) => row.sourceBlobId))).toEqual(
      new Set(["blob-current", "blob-previous"]),
    );
    expect(db.evidence.every((row) => row.jobId === jobId)).toBe(true);
  });

  it("keeps distant changes in separate hunks with real line numbers", async () => {
    const previous = Array.from(
      { length: 20 },
      (_, index) => `line ${index + 1}`,
    ).join("\n");
    const current = previous
      .split("\n")
      .map((line, index) => (index === 1 || index === 15 ? `${line} !` : line))
      .join("\n");
    const { context } = fakeToolContext({
      repository: fakeRepository({
        readFile: async () => ({
          blob: { id: "blob-current", digest: "d1" },
          snapshotFileId: "file-1",
          source: current,
        }),
        readPreviousSource: async () => previous,
      } as never),
    });

    const result = await callTool(
      deepReviewFileTools(context),
      "read_diff",
      {},
      "call-diff",
    );

    expect(
      String(result.diff)
        .split("\n")
        .filter((line) => line.includes("@@ -"))
        .map((line) => line.slice(line.indexOf("@@ -"))),
    ).toEqual(["@@ -1,5 +1,5 @@", "@@ -13,7 +13,7 @@"]);
  });

  it("shows a deleted file entirely from the previous revision", async () => {
    const { context, db } = fakeToolContext({
      repository: fakeRepository({
        readFile: async () => undefined,
        readPreviousSource: async () => "gone one\ngone two\n",
        changedFile: () => ({
          snapshotFileId: "file-1",
          path: "src/a.ts",
          previousPath: null,
          language: "typescript",
          changeType: "deleted",
          additions: 0,
          deletions: 2,
          isBinary: false,
          currentBlob: null,
          previousBlob: { id: "blob-previous", digest: "d0" },
        }),
      } as never),
    });

    const result = await callTool(
      deepReviewFileTools(context),
      "read_diff",
      {},
      "call-deleted",
    );

    expect(String(result.diff)).toBe(
      untrusted(["@@ -1,3 +0,0 @@", "-gone one", "-gone two", "-"].join("\n")),
    );
    expect(db.evidence).toEqual([
      expect.objectContaining({ sourceBlobId: "blob-previous", endLine: 3 }),
    ]);
  });

  it("reads a bounded range, records its bytes, and honours the byte ceiling", async () => {
    const { context, db } = fakeToolContext({
      limits: { maxSourceBytes: 20 },
    });
    const tools = deepReviewFileTools(context);
    const read = await callTool(
      tools,
      "read_file",
      { path: "src/a.ts", startLine: 1, endLine: 2 },
      "call-7",
    );

    expect(read.source).toContain("two changed");
    expect(db.evidence).toHaveLength(1);
    expect(db.evidence[0]).toMatchObject({
      path: "src/a.ts",
      startByte: 0,
      startLine: 1,
      endLine: 2,
      digest: "d1",
    });

    expect(
      await callTool(
        tools,
        "read_file",
        { path: "src/a.ts", startLine: 3, endLine: 5 },
        "call-8",
      ),
    ).toEqual({ limit: "source_bytes" });
  });

  it("refuses a protected path in every reading tool", async () => {
    const { context } = fakeToolContext();
    const tools = deepReviewFileTools(context);

    expect(
      await callTool(
        tools,
        "read_file",
        { path: "src/secrets/token.ts", startLine: 1, endLine: 2 },
        "call-9",
      ),
    ).toEqual({ error: "File is protected by the source policy" });
    expect(await callTool(tools, "list_files", {}, "call-10")).toEqual([
      { path: "src/a.ts", changedSymbols: [expect.anything()] },
    ]);
  });

  it("stops reading new files at the distinct-file ceiling", async () => {
    const { context } = fakeToolContext({
      limits: { maxDistinctFiles: 1 },
      readPaths: ["src/other.ts"],
    });
    expect(
      await callTool(
        deepReviewFileTools(context),
        "read_file",
        { path: "src/a.ts", startLine: 1, endLine: 1 },
        "call-11",
      ),
    ).toEqual({ limit: "distinct_files" });
  });

  it("frames search results as untrusted data", async () => {
    const { context } = fakeToolContext();
    const result = (await callTool(
      deepReviewFileTools(context),
      "search_code",
      { query: "changed" },
      "call-12",
    )) as unknown as Array<{ excerpt: string; line: number }>;

    expect(result[0]?.line).toBe(2);
    expect(result[0]?.excerpt).toContain("<untrusted-file");
  });

  it("accepts one finish and reports a replayed finish durably", async () => {
    const { context } = fakeToolContext({
      onFinishFile: vi.fn(),
    });
    const tools = deepReviewFileTools(context);
    expect(
      await callTool(tools, "finish_file", { summary: "Done" }, "call-13"),
    ).toEqual({ accepted: true });
    expect(context.onFinishFile).toHaveBeenCalledWith({ summary: "Done" });
    expect(
      await callTool(tools, "finish_file", { summary: "Done" }, "call-14"),
    ).toMatchObject({ accepted: false });

    const findFirst = vi.fn(async () => ({ id: "call" }));
    expect(
      await deepReviewFileFinished(
        { query: { aiJobToolCalls: { findFirst } } } as never,
        jobId,
      ),
    ).toBe(true);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});
