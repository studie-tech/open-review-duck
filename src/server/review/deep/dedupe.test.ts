import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/env", () => ({
  env: {
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    DEEP_REVIEW_DEDUPE_MIN: 3,
  },
}));

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  resolveAiModel: vi.fn(async () => ({
    model: "model" as unknown,
    providerOptions: { openrouter: { provider: { zdr: true } } },
  })),
}));

vi.mock("ai", () => ({ generateText: mocks.generateText }));
vi.mock("~/server/ai/models", () => ({ resolveAiModel: mocks.resolveAiModel }));

import { aiJobs } from "@/drizzle/schema";
import { sealVaultSecret } from "~/server/security/vault";
import {
  collapseIdenticalFindings,
  type DeepReviewDedupeFinding,
  type DeepReviewDedupeGroup,
  deepReviewDedupeErrors,
  deterministicDedupeKey,
  normalizeFindingTitle,
  parseDedupeResponse,
  resolveDeepReviewDedupe,
  runDeepReviewDedupe,
} from "./dedupe";

const workspaceId = "00000000-0000-4000-8000-0000000000ff";
const parentJobId = "00000000-0000-4000-8000-000000000001";

/** Builds one candidate finding with the fields the collapse actually reads. */
function candidate(
  overrides: Partial<DeepReviewDedupeFinding> & { id: string },
): DeepReviewDedupeFinding {
  return {
    path: "src/a.ts",
    severity: "high",
    category: "bug",
    title: "Null dereference",
    body: "The handler dereferences a value it never checked.",
    startLine: 10,
    endLine: 12,
    anchorSide: "current",
    ...overrides,
  };
}

/** Builds a proposed group in the shape a parsed response produces. */
function group(
  canonicalId: string,
  memberIds: string[],
  text?: { title?: string; body?: string },
): DeepReviewDedupeGroup {
  return {
    canonicalId,
    memberIds,
    title: text?.title ?? null,
    body: text?.body ?? null,
  };
}

interface FakeFindingRow {
  id: string;
  workspaceId: string;
  path: string | null;
  severity: string;
  category: string;
  startLine: number | null;
  endLine: number | null;
  anchorSide: string | null;
  encryptedContent: string;
}

interface RecordedUpdate {
  table: "aiJobs" | "aiReviewFindings";
  values: Record<string, unknown>;
}

/** Seals a finding's wording exactly as `report_finding` persists it. */
async function fakeRow(
  id: string,
  overrides: Partial<FakeFindingRow> & { title?: string } = {},
): Promise<FakeFindingRow> {
  const { title, ...rest } = overrides;
  return {
    id,
    workspaceId,
    path: "src/a.ts",
    severity: "high",
    category: "bug",
    startLine: 10,
    endLine: 12,
    anchorSide: "current",
    encryptedContent: await sealVaultSecret(
      { workspaceId, recordId: id, provider: "ai-review-finding" },
      JSON.stringify({
        title: title ?? `Finding ${id}`,
        body: "body",
        existingCode: "const x = 1;",
      }),
    ),
    ...rest,
  };
}

/** Builds the smallest database double the dedupe path exercises. */
function createFakeDb(rows: FakeFindingRow[]) {
  const updates: RecordedUpdate[] = [];
  const db = {
    query: {
      aiReviewItems: {
        findMany: async () => [{ id: "item-1" }],
      },
    },
    select() {
      return {
        from: () => ({ where: async () => rows }),
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          updates.push({
            table: table === aiJobs ? "aiJobs" : "aiReviewFindings",
            values,
          });
          return { where: async () => [] };
        },
      };
    },
  };
  return { db: db as never, updates };
}

const job = {
  id: "00000000-0000-4000-8000-000000000009",
  workspaceId,
  provider: "openrouter",
  model: "anthropic/claude",
} as never as typeof aiJobs.$inferSelect;

/** Returns a generateText result carrying one response body and no usage. */
function modelResponse(text: string) {
  return {
    text,
    usage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {} },
  };
}

beforeEach(() => {
  mocks.generateText.mockReset();
});

describe("normalizeFindingTitle", () => {
  it("folds case, whitespace, emphasis and trailing punctuation", () => {
    expect(normalizeFindingTitle("  Null   `deref`  ")).toBe("null deref");
    expect(normalizeFindingTitle("Null deref.")).toBe("null deref");
    expect(normalizeFindingTitle("NULL DEREF!")).toBe("null deref");
  });
});

describe("deterministicDedupeKey", () => {
  it("matches findings that agree on the anchor and the title", () => {
    expect(deterministicDedupeKey(candidate({ id: "a" }))).toBe(
      deterministicDedupeKey(
        candidate({ id: "b", title: "null dereference." }),
      ),
    );
  });

  it("separates findings that differ in path, side or lines", () => {
    const base = deterministicDedupeKey(candidate({ id: "a" }));
    expect(
      deterministicDedupeKey(candidate({ id: "a", path: "src/b.ts" })),
    ).not.toBe(base);
    expect(
      deterministicDedupeKey(candidate({ id: "a", anchorSide: "previous" })),
    ).not.toBe(base);
    expect(
      deterministicDedupeKey(candidate({ id: "a", startLine: 11 })),
    ).not.toBe(base);
  });
});

describe("collapseIdenticalFindings", () => {
  it("keeps the first member as the canonical finding", () => {
    const groups = collapseIdenticalFindings([
      candidate({ id: "a" }),
      candidate({ id: "b", title: "Null Dereference" }),
      candidate({ id: "c", startLine: 40, endLine: 41, title: "Other" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      canonicalId: "a",
      memberIds: ["a", "b"],
      title: null,
      body: null,
    });
    expect(groups[1]?.memberIds).toEqual(["c"]);
  });
});

describe("deepReviewDedupeErrors", () => {
  const findings = [
    { id: "a", path: "src/a.ts" },
    { id: "b", path: "src/a.ts" },
    { id: "c", path: "src/b.ts" },
  ];

  it("accepts a grouping that partitions every id exactly once", () => {
    expect(
      deepReviewDedupeErrors({
        groups: [group("a", ["a", "b"]), group("c", ["c"])],
        findings,
      }),
    ).toEqual([]);
  });

  it("rejects an unknown id", () => {
    const errors = deepReviewDedupeErrors({
      groups: [group("a", ["a", "b"]), group("c", ["c", "zz"])],
      findings,
    });
    expect(errors.some((error) => error.includes("unknown finding id"))).toBe(
      true,
    );
  });

  it("rejects an id claimed by two groups", () => {
    const errors = deepReviewDedupeErrors({
      groups: [group("a", ["a", "b"]), group("c", ["c", "b"])],
      findings,
    });
    expect(
      errors.some((error) => error.includes("appears in more than one group")),
    ).toBe(true);
  });

  it("rejects an omitted id", () => {
    const errors = deepReviewDedupeErrors({
      groups: [group("a", ["a", "b"])],
      findings,
    });
    expect(
      errors.some((error) => error.includes("is missing from the grouping")),
    ).toBe(true);
  });

  it("rejects a canonical id that is not a member", () => {
    const errors = deepReviewDedupeErrors({
      groups: [group("c", ["a", "b"]), group("c", ["c"])],
      findings,
    });
    expect(
      errors.some((error) => error.includes("that is not one of its members")),
    ).toBe(true);
  });

  it("rejects a collapse of everything into one group", () => {
    const wide = [
      { id: "a", path: "src/a.ts" },
      { id: "b", path: "src/a.ts" },
      { id: "c", path: "src/a.ts" },
      { id: "d", path: "src/a.ts" },
      { id: "e", path: "src/a.ts" },
    ];
    const errors = deepReviewDedupeErrors({
      groups: [group("a", ["a", "b", "c", "d", "e"])],
      findings: wide,
    });
    expect(
      errors.some((error) => error.includes("more than the maximum of 4")),
    ).toBe(true);
  });

  it("rejects a group whose members span two paths", () => {
    const errors = deepReviewDedupeErrors({
      groups: [group("a", ["a", "b", "c"])],
      findings,
    });
    expect(errors.some((error) => error.includes("across 2 paths"))).toBe(true);
  });

  it("exempts a group the deterministic pass already matched", () => {
    expect(
      deepReviewDedupeErrors({
        groups: [group("a", ["a", "b", "c"])],
        findings,
        deterministicGroups: [["a", "b", "c"]],
      }),
    ).toEqual([]);
  });
});

describe("resolveDeepReviewDedupe", () => {
  const findings = [
    candidate({ id: "a" }),
    candidate({ id: "b", title: "null dereference" }),
    candidate({ id: "c", startLine: 40, endLine: 41, title: "Race" }),
  ];
  const deterministic = collapseIdenticalFindings(findings);

  it("keeps the deterministic collapse when nothing was proposed", () => {
    const resolution = resolveDeepReviewDedupe({ findings, deterministic });
    expect(resolution.rejected).toBe(false);
    expect(resolution.mergedCount).toBe(1);
    expect(resolution.groups.map((entry) => entry.memberIds)).toEqual([
      ["a", "b"],
      ["c"],
    ]);
  });

  it("expands a proposal back over the collapsed duplicates", () => {
    const resolution = resolveDeepReviewDedupe({
      findings,
      deterministic,
      proposed: [group("a", ["a", "c"], { title: "Merged", body: "Body" })],
    });
    expect(resolution.rejected).toBe(false);
    expect(resolution.groups).toHaveLength(1);
    expect(resolution.groups[0]?.memberIds).toEqual(["a", "b", "c"]);
    expect(resolution.groups[0]?.title).toBe("Merged");
    expect(resolution.mergedCount).toBe(2);
  });

  it("falls back to the deterministic collapse when the proposal is broken", () => {
    const resolution = resolveDeepReviewDedupe({
      findings,
      deterministic,
      proposed: [group("a", ["a"])],
    });
    expect(resolution.rejected).toBe(true);
    expect(resolution.errors).not.toEqual([]);
    expect(resolution.groups.map((entry) => entry.memberIds)).toEqual([
      ["a", "b"],
      ["c"],
    ]);
  });
});

describe("parseDedupeResponse", () => {
  it("reads a bare object and a fenced one alike", () => {
    const bare = parseDedupeResponse(
      '{"groups":[{"canonicalId":"a","memberIds":["a"],"title":"T"}]}',
    );
    expect(bare?.[0]).toMatchObject({ canonicalId: "a", title: "T" });
    const fenced = parseDedupeResponse(
      '```json\n{"groups":[{"canonicalId":"a","memberIds":["a"]}]}\n```',
    );
    expect(fenced?.[0]?.memberIds).toEqual(["a"]);
    expect(fenced?.[0]?.title).toBeNull();
  });

  it("returns nothing for text that is not a grouping", () => {
    expect(parseDedupeResponse("no json here")).toBeNull();
    expect(parseDedupeResponse('{"groups":[{"memberIds":[]}]}')).toBeNull();
  });
});

describe("runDeepReviewDedupe", () => {
  it("collapses identical findings without calling the model", async () => {
    const rows = [
      await fakeRow("a", { title: "Null deref" }),
      await fakeRow("b", { title: "null deref." }),
    ];
    const { db, updates } = createFakeDb(rows);
    const result = await runDeepReviewDedupe(db, { parentJobId, job });
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(result.clustered).toBe(false);
    expect(result.mergedCount).toBe(1);
    const merges = updates.filter((update) => update.values.state === "merged");
    expect(merges).toHaveLength(1);
    expect(merges[0]?.values.mergedIntoId).toBe("a");
  });

  it("merges the clustered groups the model proposes", async () => {
    const rows = await Promise.all(
      ["a", "b", "c", "d"].map((id, index) =>
        fakeRow(id, { title: `Finding ${id}`, startLine: 10 + index }),
      ),
    );
    mocks.generateText.mockResolvedValue(
      modelResponse(
        JSON.stringify({
          groups: [
            {
              canonicalId: "a",
              memberIds: ["a", "b"],
              title: "Merged title",
              body: "Merged body",
            },
            { canonicalId: "c", memberIds: ["c"] },
            { canonicalId: "d", memberIds: ["d"] },
          ],
        }),
      ),
    );
    const { db, updates } = createFakeDb(rows);
    const result = await runDeepReviewDedupe(db, { parentJobId, job });
    expect(result.clustered).toBe(true);
    expect(result.rejected).toBe(false);
    expect(result.mergedCount).toBe(1);
    // The canonical member is re-sealed with the merged wording, and its
    // anchor columns are never touched.
    const resealed = updates.filter((update) =>
      Object.hasOwn(update.values, "encryptedContent"),
    );
    expect(resealed).toHaveLength(1);
    expect(Object.keys(resealed[0]?.values ?? {})).toEqual([
      "encryptedContent",
    ]);
    expect(
      updates.some(
        (update) => update.table === "aiJobs" && "inputTokens" in update.values,
      ),
    ).toBe(true);
  });

  it("keeps every finding when the model collapses them into one group", async () => {
    const rows = await Promise.all(
      ["a", "b", "c", "d", "e"].map((id, index) =>
        fakeRow(id, { title: `Finding ${id}`, startLine: 10 + index }),
      ),
    );
    mocks.generateText.mockResolvedValue(
      modelResponse(
        JSON.stringify({
          groups: [
            {
              canonicalId: "a",
              memberIds: ["a", "b", "c", "d", "e"],
              title: "Everything",
            },
          ],
        }),
      ),
    );
    const { db, updates } = createFakeDb(rows);
    const result = await runDeepReviewDedupe(db, { parentJobId, job });
    expect(result.rejected).toBe(true);
    expect(result.mergedCount).toBe(0);
    expect(
      updates.filter((update) => update.values.state === "merged"),
    ).toEqual([]);
  });

  it("keeps every finding when the clustering call throws", async () => {
    const rows = await Promise.all(
      ["a", "b", "c", "d"].map((id, index) =>
        fakeRow(id, { title: `Finding ${id}`, startLine: 10 + index }),
      ),
    );
    mocks.generateText.mockRejectedValue(new Error("provider exploded"));
    const { db, updates } = createFakeDb(rows);
    const result = await runDeepReviewDedupe(db, { parentJobId, job });
    expect(result.mergedCount).toBe(0);
    expect(result.errors[0]).toContain("provider exploded");
    expect(
      updates.filter((update) => update.values.state === "merged"),
    ).toEqual([]);
  });

  it("spreads the resolved provider options onto the clustering call", async () => {
    const rows = await Promise.all(
      ["a", "b", "c", "d"].map((id, index) =>
        fakeRow(id, { title: `Finding ${id}`, startLine: 10 + index }),
      ),
    );
    mocks.generateText.mockResolvedValue(modelResponse("not json"));
    const { db } = createFakeDb(rows);
    await runDeepReviewDedupe(db, { parentJobId, job });
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    const call = mocks.generateText.mock.calls[0]?.[0] as {
      providerOptions?: unknown;
      maxRetries?: number;
    };
    expect(call.providerOptions).toEqual({
      openrouter: { provider: { zdr: true } },
    });
    expect(call.maxRetries).toBe(0);
  });
});
