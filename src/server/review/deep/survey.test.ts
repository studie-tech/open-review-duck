import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/env", () => ({
  env: {
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    AI_MAX_SOURCE_BYTES: 8 * 1024 * 1024,
    AI_MAX_DISTINCT_FILES: 40,
  },
}));

import {
  aiJobEvidence,
  type aiJobs,
  aiReviewFindingLocations,
  aiReviewFindings,
  aiReviewItems,
  reviewUnitDependencies,
} from "@/drizzle/schema";
import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";
import type { DeepReviewContext } from "./context";
import type { DeepReviewToolInvocation } from "./file-tools";
import {
  DEEP_REVIEW_SURVEY_ITEM_PATH,
  deepReviewReportSurveyFindingSchema,
  deepReviewSurveyPromptInput,
  deepReviewSurveyTools,
  downgradeFindingSeverity,
  ensureDeepReviewSurveyItem,
  type SurveyLocationAnchor,
  surveyFindingResolution,
  surveyLocationId,
  validateDeepReviewSurveyFindings,
} from "./survey";

const workspaceId = "00000000-0000-4000-8000-0000000000aa";
const jobId = "00000000-0000-4000-8000-0000000000bb";
const itemId = "00000000-0000-4000-8000-0000000000cc";

const currentSource = "header\nconst value = compute();\nfooter\n";
const otherSource = 'import { value } from "./a";\nuse(value);\n';

const job = {
  id: jobId,
  workspaceId,
  pullRequestId: "00000000-0000-4000-8000-0000000000dd",
  provider: "openrouter",
  model: "anthropic/claude",
} as never as typeof aiJobs.$inferSelect;

/** Builds one resolved location with the fields the resolution reads. */
function location(
  overrides: Partial<SurveyLocationAnchor> = {},
): SurveyLocationAnchor {
  return {
    path: "src/a.ts",
    tier: "file_current",
    side: "current",
    startLine: 2,
    endLine: 2,
    changed: true,
    grounded: true,
    ...overrides,
  };
}

interface InsertedRow {
  table: string;
  values: Record<string, unknown>[];
}

interface FakeDatabaseOptions {
  beforeInsert?: (table: string) => Promise<void>;
}

/** Names the table an insert or select targeted, for the doubles below. */
function tableName(table: unknown): string {
  if (table === aiReviewFindings) return "ai_review_finding";
  if (table === aiReviewFindingLocations) return "ai_review_finding_location";
  if (table === aiReviewItems) return "ai_review_item";
  if (table === aiJobEvidence) return "ai_job_evidence";
  if (table === reviewUnitDependencies) return "review_unit_dependency";
  return "unknown";
}

/** Collects inserted rows and honours the primary keys the schema declares. */
function fakeDatabase(
  rows: Partial<Record<string, Record<string, unknown>[]>> = {},
  options: FakeDatabaseOptions = {},
) {
  const inserts: InsertedRow[] = [];
  const updates: { table: string; values: Record<string, unknown> }[] = [];
  const stored = new Map<string, Map<string, Record<string, unknown>>>();
  /** Records one insert once per primary key, as the real conflict clause does. */
  const write = async (
    table: unknown,
    values: Record<string, unknown> | Record<string, unknown>[],
  ) => {
    const list = Array.isArray(values) ? values : [values];
    const name = tableName(table);
    await options.beforeInsert?.(name);
    inserts.push({ table: name, values: list });
    const byId = stored.get(name) ?? new Map();
    for (const row of list) {
      if (!byId.has(String(row.id))) byId.set(String(row.id), row);
    }
    stored.set(name, byId);
  };
  const database = {
    query: {
      aiJobToolCalls: {
        findFirst: async () => undefined,
      },
      aiReviewItems: {
        findFirst: async () => ({ id: itemId }),
        findMany: async () => [{ id: itemId }],
      },
      pullRequests: {
        findFirst: async () => ({
          id: job.pullRequestId,
          title: "Remove the legacy export",
          description: null,
          sourceBranch: "feature",
          targetBranch: "main",
        }),
      },
    },
    insert: (table: unknown) => ({
      values: (
        values: Record<string, unknown> | Record<string, unknown>[],
      ) => ({
        onConflictDoNothing: () => write(table, values),
      }),
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          // The seeds stand in for a heap scan, so a reader that names no
          // order gets them back exactly as seeded.
          const seeded = rows[tableName(table)] ?? [];
          /** Returns the seeded rows, sorted only when the caller orders them. */
          const read = (order?: unknown) =>
            order === aiReviewFindingLocations.position
              ? [...seeded].sort(
                  (a, b) => Number(a.position) - Number(b.position),
                )
              : seeded;
          return Object.assign(Promise.resolve(read()), {
            orderBy: (order: unknown) => Promise.resolve(read(order)),
          });
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ table: tableName(table), values });
          return [];
        },
      }),
    }),
    transaction: async <T>(execute: (tx: never) => Promise<T>) => {
      const insertCount = inserts.length;
      const snapshot = new Map(
        [...stored].map(([table, values]) => [table, new Map(values)]),
      );
      try {
        return await execute(database as never);
      } catch (error) {
        inserts.length = insertCount;
        stored.clear();
        for (const [table, values] of snapshot) stored.set(table, values);
        throw error;
      }
    },
  };
  return { database: database as never, inserts, updates, stored };
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

/** Mimics `persistToolCall`: a replay returns the stored output verbatim. */
function fakeExecutor() {
  const stored = new Map<string, unknown>();
  const handlerRuns: string[] = [];
  /** Runs a tool body once and replays its output on every later call. */
  const execute = async (invocation: DeepReviewToolInvocation) => {
    if (stored.has(invocation.callId)) return stored.get(invocation.callId);
    handlerRuns.push(invocation.name);
    const output = await invocation.execute();
    stored.set(invocation.callId, output);
    return output;
  };
  return { execute, handlerRuns };
}

/** Builds a repository context covering one changed and one unchanged file. */
function fakeRepository(
  overrides: Partial<DeepReviewContext> = {},
): DeepReviewContext {
  return {
    runJobId: "run",
    snapshot: { id: "snapshot" },
    repository: { id: "repository" },
    listFiles: async () => ["src/a.ts", "src/b.ts"],
    readFile: async (path: string) =>
      path === "src/a.ts"
        ? {
            blob: { id: "blob-a", digest: "d1" },
            snapshotFileId: "file-a",
            source: currentSource,
          }
        : { blob: { id: "blob-b", digest: "d2" }, source: otherSource },
    readPreviousSource: async () => undefined,
    searchCode: async () => [],
    units: async () => [
      {
        id: "unit-1",
        path: "src/a.ts",
        name: "compute",
        kind: "function",
        startLine: 1,
        endLine: 3,
      },
    ],
    changedFile: (path: string) =>
      path === "src/a.ts"
        ? { path, changeType: "modified", currentBlob: { id: "blob-a" } }
        : undefined,
    changedFiles: () => [],
    sourceDecision: async () => ({ allowed: true }),
    dispose: () => undefined,
    ...overrides,
  } as never as DeepReviewContext;
}

/** Seals one location snippet exactly as `report_survey_finding` writes it. */
async function sealedLocation(id: string, snippet: string) {
  return {
    id,
    encryptedExistingCode: await sealVaultSecret(
      {
        workspaceId,
        recordId: id,
        provider: "ai-review-finding-location",
      },
      snippet,
    ),
  };
}

/** Builds the tool-execution options the AI SDK passes a tool body. */
const toolOptions = (toolCallId: string) =>
  ({ toolCallId, messages: [] }) as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("downgradeFindingSeverity", () => {
  it("moves exactly one level and floors at the mildest", () => {
    expect(downgradeFindingSeverity("critical")).toBe("high");
    expect(downgradeFindingSeverity("high")).toBe("medium");
    expect(downgradeFindingSeverity("medium")).toBe("low");
    expect(downgradeFindingSeverity("low")).toBe("low");
  });
});

describe("surveyFindingResolution", () => {
  it("anchors on the first location that resolves", () => {
    const resolution = surveyFindingResolution({
      severity: "high",
      locations: [
        location({ path: "src/a.ts", startLine: null, endLine: null }),
        location({ path: "src/b.ts", startLine: 7, endLine: 8 }),
      ],
    });
    expect(resolution).toMatchObject({
      state: "anchored",
      path: "src/b.ts",
      startLine: 7,
      severity: "high",
    });
  });

  it("keeps the severity of a grounded finding", () => {
    expect(
      surveyFindingResolution({
        severity: "critical",
        locations: [location()],
      }),
    ).toMatchObject({ severity: "critical", downgraded: false });
  });

  it("demotes an ungrounded finding instead of dropping it", () => {
    const resolution = surveyFindingResolution({
      severity: "critical",
      locations: [location({ grounded: false })],
    });
    expect(resolution.state).toBe("anchored");
    expect(resolution.severity).toBe("high");
    expect(resolution.downgraded).toBe(true);
  });

  it("stays in scope when only one location names a changed file", () => {
    expect(
      surveyFindingResolution({
        severity: "medium",
        locations: [
          location({ path: "src/a.ts", changed: true }),
          location({ path: "src/b.ts", changed: false }),
        ],
      }).state,
    ).toBe("anchored");
  });

  it("falls out of scope when no location names a changed file", () => {
    expect(
      surveyFindingResolution({
        severity: "medium",
        locations: [location({ changed: false })],
      }).state,
    ).toBe("out_of_scope");
  });

  it("reports an unanchored finding without demoting it", () => {
    const resolution = surveyFindingResolution({
      severity: "high",
      locations: [
        location({ startLine: null, endLine: null, tier: "none" }),
        location({ startLine: null, endLine: null, tier: "ambiguous" }),
      ],
    });
    expect(resolution).toMatchObject({
      state: "unanchored",
      severity: "high",
      downgraded: false,
      anchorAmbiguous: true,
      anchorTier: "ambiguous",
    });
  });
});

describe("deepReviewReportSurveyFindingSchema", () => {
  it("refuses a finding that names only one location", () => {
    const parsed = deepReviewReportSurveyFindingSchema.safeParse({
      findings: [
        {
          title: "t",
          body: "b",
          severity: "high",
          category: "bug",
          locations: [{ path: "src/a.ts", existing_code: "x" }],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("names no line field the model could fill in", () => {
    const fields = Object.keys(
      deepReviewReportSurveyFindingSchema.shape.findings.element.shape,
    );
    expect(fields).toEqual([
      "title",
      "body",
      "severity",
      "category",
      "locations",
    ]);
  });
});

describe("surveyLocationId", () => {
  it("is stable per finding and position, and uuid shaped", () => {
    const id = surveyLocationId("finding", 0);
    expect(id).toBe(surveyLocationId("finding", 0));
    expect(id).not.toBe(surveyLocationId("finding", 1));
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("ensureDeepReviewSurveyItem", () => {
  it("seals one item under the sentinel path", async () => {
    const { database, inserts } = fakeDatabase();
    const id = await ensureDeepReviewSurveyItem(database, {
      parentJobId: "00000000-0000-4000-8000-000000000001",
      workspaceId,
      childJobId: jobId,
    });
    expect(id).toBe(itemId);
    expect(inserts[0]?.table).toBe("ai_review_item");
    expect(inserts[0]?.values[0]).toMatchObject({
      path: DEEP_REVIEW_SURVEY_ITEM_PATH,
      state: "selected",
      childJobId: jobId,
    });
  });
});

describe("report_survey_finding", () => {
  /** Builds the survey tool set over one shared database double. */
  function survey(overrides: { reportedFindings?: number } = {}) {
    const { database, inserts, stored } = fakeDatabase();
    const executor = fakeExecutor();
    const tools = deepReviewSurveyTools({
      db: database,
      job,
      itemId,
      repository: fakeRepository(),
      execute: executor.execute,
      reportedFindings: overrides.reportedFindings,
    });
    return { tools, inserts, stored, executor };
  }

  const input = {
    findings: [
      {
        title: "Caller left behind",
        body: "The removed export still has an importer.",
        severity: "high",
        category: "bug",
        locations: [
          { path: "src/a.ts", existing_code: "const value = compute();" },
          { path: "src/b.ts", existing_code: "use(value);" },
        ],
      },
    ],
  };

  it("stores a finding with no path and one row per location", async () => {
    const { tools, inserts } = survey();
    const output = (await tools.report_survey_finding.execute?.(
      input,
      toolOptions("call-1"),
    )) as { accepted: number; findingIds: string[] };
    expect(output.accepted).toBe(1);
    const finding = inserts.find(
      (insert) => insert.table === "ai_review_finding",
    );
    expect(finding?.values[0]).toMatchObject({
      path: null,
      itemId,
      jobId,
      severity: "high",
      category: "bug",
    });
    const locations = inserts.filter(
      (insert) => insert.table === "ai_review_finding_location",
    );
    expect(locations).toHaveLength(1);
    const locationRows = locations[0]?.values ?? [];
    expect(locationRows.map((row) => [row.position, row.path])).toEqual([
      [0, "src/a.ts"],
      [1, "src/b.ts"],
    ]);
    await expect(
      openVaultSecret(
        {
          workspaceId,
          recordId: String(locationRows[0]?.id),
          provider: "ai-review-finding-location",
        },
        String(locationRows[0]?.encryptedExistingCode),
      ),
    ).resolves.toBe("const value = compute();");
  });

  it("declines a finding whose locations name one file", async () => {
    const { tools, inserts } = survey();
    const output = (await tools.report_survey_finding.execute?.(
      {
        findings: [
          {
            title: "Caller left behind",
            body: "The removed export still has an importer.",
            severity: "high",
            category: "bug",
            locations: [
              { path: "src/a.ts", existing_code: "one" },
              { path: "src/a.ts", existing_code: "two" },
            ],
          },
        ],
      },
      toolOptions("call-2"),
    )) as { accepted: number; declined: number };
    expect(output).toMatchObject({ accepted: 0, declined: 1 });
    expect(inserts).toEqual([]);
  });

  it("returns the stored output on replay without writing again", async () => {
    const { tools, inserts, executor } = survey();
    const first = await tools.report_survey_finding.execute?.(
      input,
      toolOptions("call-3"),
    );
    const second = await tools.report_survey_finding.execute?.(
      input,
      toolOptions("call-3"),
    );
    expect(second).toEqual(first);
    expect(executor.handlerRuns).toEqual(["report_survey_finding"]);
    expect(
      inserts.filter((insert) => insert.table === "ai_review_finding"),
    ).toHaveLength(1);
  });

  it("stops accepting findings once the run's ceiling is reached", async () => {
    const { tools, inserts } = survey({ reportedFindings: 15 });
    const output = (await tools.report_survey_finding.execute?.(
      input,
      toolOptions("call-4"),
    )) as { accepted: number; declined: number };
    expect(output).toMatchObject({ accepted: 0, declined: 1 });
    expect(inserts).toEqual([]);
  });

  it("reserves the cap before concurrent survey writes can overlap", async () => {
    const entered = deferred();
    const release = deferred();
    let findingInserts = 0;
    const { database, inserts } = fakeDatabase(
      {},
      {
        beforeInsert: async (table) => {
          if (table !== "ai_review_finding") return;
          findingInserts += 1;
          if (findingInserts !== 1) return;
          entered.resolve();
          await release.promise;
        },
      },
    );
    const tools = deepReviewSurveyTools({
      db: database,
      job,
      itemId,
      repository: fakeRepository(),
      execute: fakeExecutor().execute,
      limits: { maxFindings: 1 },
    });
    const first = tools.report_survey_finding.execute?.(
      input,
      toolOptions("concurrent-1"),
    );
    await entered.promise;
    const second = await tools.report_survey_finding.execute?.(
      input,
      toolOptions("concurrent-2"),
    );
    release.resolve();

    await expect(first).resolves.toMatchObject({ accepted: 1, declined: 0 });
    expect(second).toMatchObject({ accepted: 0, declined: 1 });
    expect(
      inserts.filter((insert) => insert.table === "ai_review_finding"),
    ).toHaveLength(1);
  });

  it("rolls back a partial survey write and releases its reservation", async () => {
    let failLocation = true;
    const { database, inserts, stored } = fakeDatabase(
      {},
      {
        beforeInsert: async (table) => {
          if (table !== "ai_review_finding_location" || !failLocation) return;
          failLocation = false;
          throw new Error("injected location insert failure");
        },
      },
    );
    const tools = deepReviewSurveyTools({
      db: database,
      job,
      itemId,
      repository: fakeRepository(),
      execute: fakeExecutor().execute,
      limits: { maxFindings: 1 },
    });

    await expect(
      tools.report_survey_finding.execute?.(input, toolOptions("failed-call")),
    ).rejects.toThrow("injected location insert failure");
    expect(inserts).toEqual([]);
    expect(stored.get("ai_review_finding")?.size ?? 0).toBe(0);
    await expect(
      tools.report_survey_finding.execute?.(input, toolOptions("retry-call")),
    ).resolves.toMatchObject({ accepted: 1, declined: 0 });
    expect(stored.get("ai_review_finding")?.size).toBe(1);
    expect(stored.get("ai_review_finding_location")?.size).toBe(2);
  });
});

describe("validateDeepReviewSurveyFindings", () => {
  /** Runs the validation over one finding with the supplied evidence rows. */
  async function validate(
    evidence: Record<string, unknown>[],
    snippets: [string, string] = ["const value = compute();", "use(value);"],
  ) {
    const locations = [
      await sealedLocation("loc-1", snippets[0]),
      await sealedLocation("loc-2", snippets[1]),
    ];
    const { database, updates } = fakeDatabase({
      ai_review_finding: [{ id: "finding-1", severity: "critical" }],
      // Seeded against their positions: the finding surfaces on the first
      // location that resolves, so only a read ordered by `position` puts
      // src/a.ts — the one the survey named first — in front.
      ai_review_finding_location: [
        {
          ...locations[1],
          findingId: "finding-1",
          position: 1,
          path: "src/b.ts",
        },
        {
          ...locations[0],
          findingId: "finding-1",
          position: 0,
          path: "src/a.ts",
        },
      ],
      ai_job_evidence: evidence,
    });
    const tally = await validateDeepReviewSurveyFindings(database, {
      job,
      itemId,
      repository: fakeRepository(),
    });
    return { tally, updates };
  }

  it("anchors each location and keeps a grounded severity", async () => {
    const { tally, updates } = await validate([
      { sourceBlobId: "blob-a", startLine: 1, endLine: 3 },
    ]);
    expect(tally).toMatchObject({ anchored: 1, downgraded: 0 });
    const locationUpdates = updates.filter(
      (update) => update.table === "ai_review_finding_location",
    );
    expect(locationUpdates[0]?.values).toMatchObject({
      startLine: 2,
      endLine: 2,
      anchorSide: "current",
    });
    const finding = updates.find(
      (update) => update.table === "ai_review_finding",
    );
    expect(finding?.values).toMatchObject({
      state: "anchored",
      severity: "critical",
      path: "src/a.ts",
      startLine: 2,
    });
  });

  it("demotes the finding one level when nothing grounds it", async () => {
    const { tally, updates } = await validate([]);
    expect(tally).toMatchObject({ anchored: 1, downgraded: 1 });
    const finding = updates.find(
      (update) => update.table === "ai_review_finding",
    );
    expect(finding?.values).toMatchObject({
      state: "anchored",
      severity: "high",
    });
  });

  it("does not let a read of one file ground an anchor in another", async () => {
    // Only the src/a.ts location resolves, and the only evidence is a read of
    // src/b.ts covering the same line numbers. Without the per-blob partition
    // that read would ground an anchor it never touched.
    const { tally, updates } = await validate(
      [{ sourceBlobId: "blob-b", startLine: 1, endLine: 3 }],
      ["const value = compute();", "never written anywhere"],
    );
    expect(tally).toMatchObject({ anchored: 1, downgraded: 1 });
    const finding = updates.find(
      (update) => update.table === "ai_review_finding",
    );
    expect(finding?.values).toMatchObject({
      path: "src/a.ts",
      severity: "high",
    });
  });
});

describe("deepReviewSurveyPromptInput", () => {
  it("carries the shape of the change and no file bodies", async () => {
    const { database } = fakeDatabase({
      review_unit_dependency: [{ unitId: "unit-1", dependencyId: "unit-2" }],
      ai_review_finding: [
        {
          id: "finding-1",
          path: "src/a.ts",
          severity: "high",
          encryptedContent: await sealVaultSecret(
            {
              workspaceId,
              recordId: "finding-1",
              provider: "ai-review-finding",
            },
            JSON.stringify({ title: "Null deref", body: "body" }),
          ),
        },
      ],
    });
    const input = await deepReviewSurveyPromptInput(database, {
      job,
      parentJobId: "00000000-0000-4000-8000-000000000001",
      repository: fakeRepository({
        changedFiles: () => [
          {
            path: "src/a.ts",
            changeType: "modified",
            additions: 3,
            deletions: 1,
          },
        ],
        units: async () => [
          {
            id: "unit-1",
            path: "src/a.ts",
            name: "compute",
            kind: "function",
            startLine: 1,
            endLine: 3,
          },
          {
            id: "unit-2",
            path: "src/b.ts",
            name: "use",
            kind: "function",
            startLine: 1,
            endLine: 2,
          },
        ],
      } as never as Partial<DeepReviewContext>),
    });
    expect(input.pullRequest.title).toBe("Remove the legacy export");
    expect(input.files).toEqual([
      { path: "src/a.ts", changeType: "modified", changedLineCount: 4 },
    ]);
    expect(input.dependencies).toEqual([
      {
        fromPath: "src/a.ts",
        fromName: "compute",
        toPath: "src/b.ts",
        toName: "use",
        kind: "function",
      },
    ]);
    expect(input.fileFindings).toEqual([
      { path: "src/a.ts", severity: "high", title: "Null deref" },
    ]);
  });
});
