import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { aiReviewFindingLocations } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { DEEP_REVIEW_SURVEY_ITEM_PATH } from "~/server/review/deep/survey";
import { sealVaultSecret } from "~/server/security/vault";
import {
  assertCommentIsTheReviewersToChange,
  deepReviewFindingForPublication,
  deepReviewRunPayload,
  publishedCommentAuthor,
} from "./review";

const workspaceId = "00000000-0000-4000-8000-0000000000aa";
const parentJobId = "00000000-0000-4000-8000-0000000000bb";
const childJobId = "00000000-0000-4000-8000-0000000000cc";
const unitId = "00000000-0000-4000-8000-0000000000dd";

const job = {
  id: parentJobId,
  status: "completed" as const,
  deepReviewTerminalState: "partial" as const,
  runFailureClass: null,
  completionReason: "deep_review_partial" as const,
  error: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  completedAt: new Date("2026-01-01T00:05:00.000Z"),
};

interface ItemSeed {
  id: string;
  path: string;
  state: string;
  failureClass?: string | null;
  reason?: string | null;
}

interface FindingSeed {
  id: string;
  itemId?: string;
  path?: string | null;
  severity?: string;
  category?: string;
  state?: string;
  verdict?: string;
  verdictReason?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  unitId?: string | null;
  orderIndex?: number | null;
  title?: string;
  body?: string;
  /** Replaces the sealed payload, so a damaged row can be exercised. */
  encryptedContent?: string;
}

/** Builds one coverage row in the shape `ai_review_item` selects. */
function item(seed: ItemSeed) {
  return {
    id: seed.id,
    path: seed.path,
    changeType: "modified",
    changedLineCount: 12,
    state: seed.state,
    failureClass: seed.failureClass ?? null,
    reason: seed.reason ?? null,
  };
}

/** Seals one finding row exactly as `report_finding` persists it. */
async function finding(seed: FindingSeed) {
  return {
    id: seed.id,
    itemId: seed.itemId ?? "item-alpha",
    jobId: childJobId,
    workspaceId,
    path: seed.path === undefined ? "src/alpha.ts" : seed.path,
    severity: seed.severity ?? "high",
    category: seed.category ?? "bug",
    encryptedContent:
      seed.encryptedContent ??
      (await sealVaultSecret(
        { workspaceId, recordId: seed.id, provider: "ai-review-finding" },
        JSON.stringify({
          title: seed.title ?? "A title",
          body: seed.body ?? "A body",
          existingCode: "const value = compute();",
          suggestionCode: "const value = await compute();",
        }),
      )),
    state: seed.state ?? "anchored",
    verdict: seed.verdict ?? "unverified",
    verdictReason: seed.verdictReason ?? null,
    anchorTier: "unit_current",
    anchorSide: "current",
    startLine: seed.startLine === undefined ? 12 : seed.startLine,
    endLine: seed.endLine === undefined ? 12 : seed.endLine,
    anchorAmbiguous: false,
    unitId: seed.unitId === undefined ? unitId : seed.unitId,
    mergedIntoId: null,
    orderIndex: seed.orderIndex === undefined ? 0 : seed.orderIndex,
    createdAt: new Date("2026-01-01T00:01:00.000Z"),
  };
}

/**
 * Builds the smallest database double the read path exercises.
 *
 * The `where` clauses are drizzle expressions the double cannot evaluate, so it
 * returns the seeded rows and records that each read happened at all — which is
 * what the empty-run case actually asserts.
 */
function createReadDb(state: {
  items: ReturnType<typeof item>[];
  findings: Awaited<ReturnType<typeof finding>>[];
  /** Seeded in heap order, which the double only sorts when asked to. */
  locations: {
    findingId: string;
    position: number;
    path: string;
    anchorTier: string | null;
    anchorSide: string | null;
    startLine: number | null;
    endLine: number | null;
  }[];
  /** The published comments of this run, already filtered as the query is. */
  comments?: { aiFindingIndex: number | null }[];
}) {
  const reads = { comments: 0, findings: 0, locations: 0 };
  const db = {
    query: {
      aiReviewItems: {
        /** Returns the run's sealed coverage rows. */
        findMany: async () => state.items,
      },
      aiReviewFindings: {
        /** Returns the surfaced findings, counting the read. */
        findMany: async () => {
          reads.findings += 1;
          return state.findings;
        },
      },
      aiReviewFindingLocations: {
        /** Returns the cross-file locations, counting the read. */
        findMany: async (args?: { orderBy?: readonly unknown[] }) => {
          reads.locations += 1;
          const rows = args?.orderBy?.includes(
            aiReviewFindingLocations.position,
          )
            ? [...state.locations].sort((a, b) => a.position - b.position)
            : state.locations;
          // `position` orders the read without joining the payload, so the
          // double drops it exactly as the query's `columns` does.
          return rows.map(({ position: _position, ...row }) => row);
        },
      },
      reviewComments: {
        /** Returns this run's published comments, counting the read. */
        findMany: async () => {
          reads.comments += 1;
          return state.comments ?? [];
        },
      },
    },
  } as unknown as typeof database;
  return { db, reads };
}

/** Builds the two point reads the publish path makes, seeded per test. */
function createPublishDb(state: {
  finding?: Awaited<ReturnType<typeof finding>>;
  item?: { parentJobId: string };
}) {
  return {
    query: {
      aiReviewFindings: {
        /** Returns the finding named by the publish request, if any. */
        findFirst: async () => state.finding,
      },
      aiReviewItems: {
        /** Returns the coverage row the finding hangs from, if any. */
        findFirst: async () => state.item,
      },
    },
  } as unknown as typeof database;
}

describe("deep review read path", () => {
  it("orders findings by their frozen rank and flattens sealed content", async () => {
    const { db } = createReadDb({
      items: [
        item({ id: "item-alpha", path: "src/alpha.ts", state: "completed" }),
      ],
      findings: [
        await finding({ id: "f-second", orderIndex: 1, title: "Second" }),
        await finding({ id: "f-first", orderIndex: 0, title: "First" }),
      ],
      locations: [],
    });

    const run = await deepReviewRunPayload(db, job);

    expect(run.findings.map(({ title }) => title)).toEqual(["First", "Second"]);
    expect(run.findings[0]).toMatchObject({
      body: "A body",
      contentAvailable: true,
      existingCode: "const value = compute();",
      publishable: true,
      suggestionCode: "const value = await compute();",
    });
  });

  it("ranks an unranked finding last, tie-broken by id", async () => {
    // `orderIndex` is frozen at finalize, so a run still in flight has rows
    // that no rank has reached yet. They must not float above ranked ones.
    const { db } = createReadDb({
      items: [
        item({ id: "item-alpha", path: "src/alpha.ts", state: "completed" }),
      ],
      findings: [
        await finding({ id: "f-b", orderIndex: null, title: "Unranked B" }),
        await finding({ id: "f-a", orderIndex: null, title: "Unranked A" }),
        await finding({ id: "f-ranked", orderIndex: 3, title: "Ranked" }),
      ],
      locations: [],
    });

    const run = await deepReviewRunPayload(db, job);

    expect(run.findings.map(({ title }) => title)).toEqual([
      "Ranked",
      "Unranked A",
      "Unranked B",
    ]);
  });

  it("surfaces a finding that never anchored, marked unpublishable", async () => {
    const { db } = createReadDb({
      items: [
        item({ id: "item-alpha", path: "src/alpha.ts", state: "completed" }),
      ],
      findings: [
        await finding({
          id: "f-unanchored",
          state: "unanchored",
          startLine: null,
          endLine: null,
          unitId: null,
        }),
        await finding({
          id: "f-refuted",
          orderIndex: 1,
          state: "refuted",
          verdict: "refuted",
          verdictReason: "src/alpha.ts:12 already guards this",
        }),
      ],
      locations: [],
    });

    const run = await deepReviewRunPayload(db, job);

    expect(run.findings.map(({ publishable }) => publishable)).toEqual([
      false,
      false,
    ]);
    expect(run.findings[1]?.verdictReason).toBe(
      "src/alpha.ts:12 already guards this",
    );
  });

  it("attaches each cross-file location to its finding, in the named order", async () => {
    const { db } = createReadDb({
      items: [
        item({
          id: "item-survey",
          path: DEEP_REVIEW_SURVEY_ITEM_PATH,
          state: "completed",
        }),
      ],
      findings: [
        await finding({
          id: "f-survey",
          itemId: "item-survey",
          path: null,
          state: "unanchored",
          startLine: null,
          endLine: null,
          unitId: null,
        }),
      ],
      locations: [
        {
          findingId: "f-survey",
          position: 1,
          path: "src/beta.ts",
          anchorTier: "unit_current",
          anchorSide: "current",
          startLine: 9,
          endLine: 9,
        },
        {
          findingId: "f-other",
          position: 0,
          path: "src/ignored.ts",
          anchorTier: null,
          anchorSide: null,
          startLine: null,
          endLine: null,
        },
        {
          findingId: "f-survey",
          position: 0,
          path: "src/alpha.ts",
          anchorTier: "file_current",
          anchorSide: "current",
          startLine: 4,
          endLine: 4,
        },
      ],
    });

    const run = await deepReviewRunPayload(db, job);

    // The client holds an open location by its index, so the payload has to
    // list them in the order the survey named them.
    expect(run.findings[0]?.locations).toEqual([
      {
        path: "src/alpha.ts",
        anchorTier: "file_current",
        anchorSide: "current",
        startLine: 4,
        endLine: 4,
      },
      {
        path: "src/beta.ts",
        anchorTier: "unit_current",
        anchorSide: "current",
        startLine: 9,
        endLine: 9,
      },
    ]);
  });

  it("reports an unreadable payload rather than dropping the finding", async () => {
    const { db } = createReadDb({
      items: [
        item({ id: "item-alpha", path: "src/alpha.ts", state: "completed" }),
      ],
      findings: [
        await finding({
          id: "f-damaged",
          encryptedContent: "vault-v1.not.a.payload",
        }),
      ],
      locations: [],
    });

    const run = await deepReviewRunPayload(db, job);

    expect(run.findings).toHaveLength(1);
    expect(run.findings[0]).toMatchObject({
      contentAvailable: false,
      title: "",
      body: "",
    });
  });

  it("counts coverage and separates the survey from the file list", async () => {
    const { db } = createReadDb({
      items: [
        item({
          id: "item-survey",
          path: DEEP_REVIEW_SURVEY_ITEM_PATH,
          state: "completed",
        }),
        item({ id: "item-zeta", path: "src/zeta.ts", state: "reused" }),
        item({
          id: "item-alpha",
          path: "src/alpha.ts",
          state: "failed",
          failureClass: "budget",
          reason: "The review stopped at its token budget.",
        }),
      ],
      findings: [],
      locations: [],
    });

    const run = await deepReviewRunPayload(db, job);

    expect(run.coverage).toEqual({
      total: 3,
      completed: 1,
      reused: 1,
      waived: 0,
      failed: 1,
    });
    expect(run.items.map(({ path, kind }) => [path, kind])).toEqual([
      ["src/alpha.ts", "file"],
      ["src/zeta.ts", "file"],
      [DEEP_REVIEW_SURVEY_ITEM_PATH, "survey"],
    ]);
    expect(run.items[0]).toMatchObject({
      id: "item-alpha",
      failureClass: "budget",
      reason: "The review stopped at its token budget.",
    });
  });

  it("reads no finding at all for a run whose plan sealed empty", async () => {
    const { db, reads } = createReadDb({
      items: [],
      findings: [],
      locations: [],
    });

    const run = await deepReviewRunPayload(db, job);

    expect(run.findings).toEqual([]);
    expect(reads).toEqual({ comments: 0, findings: 0, locations: 0 });
    expect(run.terminalState).toBe("partial");
  });

  it("reports a published finding in a file the reviewer is not reading", async () => {
    // The payload is run-wide, unlike `unitDiscussion`: a findings list has to
    // mark the beta finding as published while alpha is the open unit.
    const { db } = createReadDb({
      items: [
        item({ id: "item-alpha", path: "src/alpha.ts", state: "completed" }),
        item({ id: "item-beta", path: "src/beta.ts", state: "completed" }),
      ],
      findings: [
        await finding({ id: "f-alpha", orderIndex: 0 }),
        await finding({
          id: "f-beta",
          itemId: "item-beta",
          path: "src/beta.ts",
          orderIndex: 1,
          unitId: "00000000-0000-4000-8000-0000000000ee",
        }),
        await finding({ id: "f-unranked", orderIndex: null }),
      ],
      locations: [],
      comments: [{ aiFindingIndex: 1 }],
    });

    const run = await deepReviewRunPayload(db, job);

    expect(run.publishedFindingIds).toEqual(["f-beta"]);
  });

  it("leaves an unranked finding out of the published set", async () => {
    // `aiFindingIndex` is nullable for a hand-written comment, and `orderIndex`
    // is null until finalize, so neither null may match the other.
    const { db } = createReadDb({
      items: [
        item({ id: "item-alpha", path: "src/alpha.ts", state: "completed" }),
      ],
      findings: [await finding({ id: "f-unranked", orderIndex: null })],
      locations: [],
      comments: [{ aiFindingIndex: null }],
    });

    const run = await deepReviewRunPayload(db, job);

    expect(run.publishedFindingIds).toEqual([]);
  });
});

describe("deep review publication", () => {
  const request = {
    findingId: "f-publishable",
    parentJobId,
    path: "src/alpha.ts",
    line: 12,
  };

  it("returns the finding's text and its run-wide order index", async () => {
    const db = createPublishDb({
      finding: await finding({
        id: "f-publishable",
        orderIndex: 7,
        title: "Unhandled rejection",
        body: "The promise is never awaited.",
      }),
      item: { parentJobId },
    });

    expect(await deepReviewFindingForPublication(db, request)).toEqual({
      body: "**Unhandled rejection**\n\nThe promise is never awaited.",
      orderIndex: 7,
    });
  });

  it("refuses a finding sealed under a different run", async () => {
    // The job lookup authorizes the reviewer; this is what stops one
    // authorized job from publishing another run's finding rows.
    const db = createPublishDb({
      finding: await finding({ id: "f-publishable" }),
      item: { parentJobId: "00000000-0000-4000-8000-0000000000ee" },
    });

    await expect(deepReviewFindingForPublication(db, request)).rejects.toThrow(
      TRPCError,
    );
  });

  it("refuses a finding whose id names no row", async () => {
    const db = createPublishDb({});

    await expect(deepReviewFindingForPublication(db, request)).rejects.toThrow(
      /does not belong to the selected review/,
    );
  });

  it("refuses every finding a comment could not carry a line for", async () => {
    // `review_comment.line` and `review_comment.unitId` are both not null, so
    // each of these is structurally unpublishable rather than merely stale.
    for (const seed of [
      { state: "unanchored", startLine: null, unitId: null },
      { state: "out_of_scope" },
      { state: "ungrounded" },
      { state: "refuted", verdict: "refuted" },
      { unitId: null },
    ]) {
      const db = createPublishDb({
        finding: await finding({ id: "f-publishable", ...seed }),
        item: { parentJobId },
      });
      await expect(
        deepReviewFindingForPublication(db, request),
      ).rejects.toThrow(/can only be read in ReviewDuck/);
    }
  });

  it("refuses a finding the run has not ranked yet", async () => {
    // `orderIndex` is what `review_comment.aiFindingIndex` stores, so a run
    // still short of finalize has no idempotency key for the comment.
    const db = createPublishDb({
      finding: await finding({ id: "f-publishable", orderIndex: null }),
      item: { parentJobId },
    });

    await expect(deepReviewFindingForPublication(db, request)).rejects.toThrow(
      /has not finished ranking its findings/,
    );
  });

  it("refuses a finding that has moved off the selected line", async () => {
    const db = createPublishDb({
      finding: await finding({ id: "f-publishable", startLine: 40 }),
      item: { parentJobId },
    });

    await expect(deepReviewFindingForPublication(db, request)).rejects.toThrow(
      /no longer matches the selected code/,
    );
  });

  it("refuses to publish text it could not read back", async () => {
    const db = createPublishDb({
      finding: await finding({
        id: "f-publishable",
        encryptedContent: "vault-v1.not.a.payload",
      }),
      item: { parentJobId },
    });

    await expect(deepReviewFindingForPublication(db, request)).rejects.toThrow(
      /could not be read back/,
    );
  });
});

describe("who may change a provider comment", () => {
  const reviewer = "reviewer-one";
  const colleague = "reviewer-two";
  const thread = {
    externalId: "thread-1",
    comments: [{ externalId: "thread-1" }, { externalId: "reply-9" }],
  };

  /**
   * Answers the ownership lookup with whichever rows the clauses would match.
   *
   * The double cannot evaluate a drizzle expression, so the test states the
   * rows the query is expected to find rather than the predicate it built.
   */
  function createOwnershipDb(rows: { userId: string }[]) {
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            /** Returns the seeded owner, as the bounded query would. */
            limit: async () => rows.slice(0, 1),
          }),
        }),
      }),
    } as unknown as typeof database;
  }

  it("names the reviewer a published comment belongs to", async () => {
    await expect(
      publishedCommentAuthor(
        createOwnershipDb([{ userId: colleague }]),
        unitId,
        thread,
        "reply-9",
      ),
    ).resolves.toBe(colleague);
  });

  it("names nobody for a comment ReviewDuck never published", async () => {
    // A bot's comment, or one written in the provider's own interface, is as
    // open to change as the provider itself would leave it.
    await expect(
      publishedCommentAuthor(createOwnershipDb([]), unitId, thread, "reply-9"),
    ).resolves.toBeUndefined();
  });

  it("refuses one reviewer's change to another's comment", async () => {
    await expect(
      assertCommentIsTheReviewersToChange(
        createOwnershipDb([{ userId: colleague }]),
        reviewer,
        unitId,
        thread,
        "reply-9",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows a reviewer to change their own comment", async () => {
    await expect(
      assertCommentIsTheReviewersToChange(
        createOwnershipDb([{ userId: reviewer }]),
        reviewer,
        unitId,
        thread,
        "thread-1",
      ),
    ).resolves.toBeUndefined();
  });

  it("allows a comment nobody here published", async () => {
    await expect(
      assertCommentIsTheReviewersToChange(
        createOwnershipDb([]),
        reviewer,
        unitId,
        thread,
        "reply-9",
      ),
    ).resolves.toBeUndefined();
  });
});
