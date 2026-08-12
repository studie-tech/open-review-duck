import { describe, expect, it, vi } from "vitest";

vi.mock("~/env", () => ({
  env: {
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    AI_MAX_DURATION_MS: 600_000,
  },
}));

vi.mock("~/server/ai/models", () => ({
  resolveAiModel: vi.fn(async () => {
    throw new Error("resolveAiModel must not be reached by these tests");
  }),
}));

vi.mock("ai", () => ({
  generateText: vi.fn(async () => {
    throw new Error("generateText must not be reached by these tests");
  }),
}));

import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";
import { DEEP_REVIEW_REFUTE_SYSTEM_PROMPT } from "./review-prompts";
import {
  createRelocationBudget,
  type DeepReviewValidationEvidence,
  type DeepReviewValidationModel,
  type DeepReviewValidationModelRequest,
  type DeepReviewValidationUnit,
  extractCodeBlock,
  parseRefuteVotes,
  type ValidateFileFindingsInput,
  validateFileFindings,
} from "./validate";

const workspaceId = "00000000-0000-4000-8000-0000000000aa";
const jobId = "00000000-0000-4000-8000-0000000000bb";
const itemId = "00000000-0000-4000-8000-0000000000cc";
const path = "src/alpha.ts";
const currentBlobId = "blob-current";
const previousBlobId = "blob-previous";

const currentSource = [
  "export function alpha() {",
  "  const value = compute();",
  "  return value;",
  "}",
  "",
  "export function beta() {",
  "  const other = compute();",
  "  return other;",
  "}",
  "",
].join("\n");

const previousSource = [
  "export function alpha() {",
  "  const legacy = computeLegacy();",
  "  return legacy;",
  "}",
  "",
  "export function beta() {",
  "  const other = compute();",
  "  return other;",
  "}",
  "",
].join("\n");

const units: DeepReviewValidationUnit[] = [
  { id: "unit-alpha", path, startLine: 1, endLine: 4 },
  { id: "unit-beta", path, startLine: 6, endLine: 9 },
  { id: "unit-elsewhere", path: "src/other.ts", startLine: 1, endLine: 4 },
];

interface FindingSeed {
  id: string;
  title?: string;
  body?: string;
  existingCode: string;
  state?: string;
}

interface FindingRow {
  id: string;
  state: string;
  encryptedContent: string;
}

/** Seals one finding payload exactly as `report_finding` persists it. */
async function sealFinding(seed: FindingSeed): Promise<FindingRow> {
  return {
    id: seed.id,
    state: seed.state ?? "submitted",
    encryptedContent: await sealVaultSecret(
      { workspaceId, recordId: seed.id, provider: "ai-review-finding" },
      JSON.stringify({
        title: seed.title ?? "A title",
        body: seed.body ?? "A body",
        existingCode: seed.existingCode,
        suggestionCode: undefined,
      }),
    ),
  };
}

/** Opens a resealed payload, proving the AAD still binds the finding's id. */
async function openFinding(id: string, ciphertext: string) {
  return JSON.parse(
    await openVaultSecret(
      { workspaceId, recordId: id, provider: "ai-review-finding" },
      ciphertext,
    ),
  ) as { title: string; body: string; existingCode: string };
}

interface RecordedUpdate {
  values: Record<string, unknown>;
}

/** Builds the smallest database double the validation path exercises. */
function fakeDatabase(rows: readonly FindingRow[]) {
  const updates: RecordedUpdate[] = [];
  const links: { findingId: string; evidenceId: string }[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: async () =>
          rows
            .filter((row) => row.state === "submitted")
            .map((row) => ({
              id: row.id,
              encryptedContent: row.encryptedContent,
            })),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ values });
        },
      }),
    }),
    insert: () => ({
      values: (rowsToInsert: { findingId: string; evidenceId: string }[]) => ({
        onConflictDoNothing: async () => {
          links.push(...rowsToInsert);
        },
      }),
    }),
    delete: () => {
      throw new Error("validation must never delete a finding");
    },
  };
  return { db: db as never, updates, links };
}

interface StubModelOptions {
  relocate?: string | (() => string);
  refute?: string | (() => string);
}

/** Answers the two validation calls, dispatching on the system prompt. */
function stubModel(options: StubModelOptions) {
  const requests: DeepReviewValidationModelRequest[] = [];
  const model: DeepReviewValidationModel = {
    async generate(request) {
      requests.push(request);
      const answer =
        request.system === DEEP_REVIEW_REFUTE_SYSTEM_PROMPT
          ? options.refute
          : options.relocate;
      if (answer === undefined) throw new Error("no stubbed answer");
      return typeof answer === "function" ? answer() : answer;
    },
  };
  return { model, requests };
}

const currentEvidence: DeepReviewValidationEvidence[] = [
  { id: "ev-current", sourceBlobId: currentBlobId, startLine: 1, endLine: 9 },
];

/** Builds a validation input, defaulting everything a case does not state. */
function validationInput(
  overrides: Partial<ValidateFileFindingsInput> = {},
): ValidateFileFindingsInput {
  return {
    item: { id: itemId, path },
    job: { id: jobId, workspaceId },
    currentSource,
    previousSource,
    changedRanges: [{ startLine: 2, endLine: 3 }],
    previousChangedRanges: [{ startLine: 2, endLine: 3 }],
    units,
    evidence: currentEvidence,
    currentBlobId,
    previousBlobId,
    snapshotPaths: [path, "src/other.ts"],
    ...overrides,
  } as ValidateFileFindingsInput;
}

describe("extractCodeBlock", () => {
  it("returns the first fenced block without its language tag", () => {
    expect(extractCodeBlock("prose\n```ts\nconst a = 1;\n```\nmore")).toBe(
      "const a = 1;",
    );
  });

  it("returns nothing when the block is unterminated or absent", () => {
    expect(extractCodeBlock("no fence here")).toBe("");
    expect(extractCodeBlock("```ts\nconst a = 1;")).toBe("");
  });
});

describe("parseRefuteVotes", () => {
  it("reads a bare JSON vote list", () => {
    const votes = parseRefuteVotes(
      '{"votes":[{"id":"f1","verdict":"refuted","refutation":"it is guarded","evidencePath":"src/alpha.ts","evidenceLine":3}]}',
    );
    expect(votes).toEqual([
      {
        id: "f1",
        verdict: "refuted",
        refutation: "it is guarded",
        evidencePath: "src/alpha.ts",
        evidenceLine: 3,
      },
    ]);
  });

  it("tolerates a fence the refuter was told not to add", () => {
    expect(
      parseRefuteVotes('```json\n{"votes":[{"id":"f1","verdict":"x"}]}\n```'),
    ).toEqual([
      {
        id: "f1",
        verdict: "not_refuted",
        refutation: undefined,
        evidencePath: undefined,
        evidenceLine: undefined,
      },
    ]);
  });

  it("reports an unusable answer as null rather than as no votes", () => {
    expect(parseRefuteVotes("I could not decide.")).toBeNull();
    expect(parseRefuteVotes('{"verdicts":[]}')).toBeNull();
  });
});

describe("anchoring", () => {
  it("anchors a changed-line snippet and records its unit", async () => {
    const rows = [
      await sealFinding({
        id: "f1",
        existingCode: "  const value = compute();",
      }),
    ];
    const { db, updates } = fakeDatabase(rows);
    const result = await validateFileFindings(db, validationInput());
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      state: "anchored",
      verdict: "unverified",
      anchorTier: "unit_current",
      anchorSide: "current",
      startLine: 2,
      endLine: 2,
      anchorAmbiguous: false,
      unitId: "unit-alpha",
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.values).toMatchObject({ state: "anchored" });
  });

  it("keeps a snippet that matches nothing, in the file-level bucket", async () => {
    const rows = [
      await sealFinding({ id: "f1", existingCode: "const nowhere = true;" }),
    ];
    const { db, updates } = fakeDatabase(rows);
    const result = await validateFileFindings(db, validationInput());
    expect(result.findings[0]).toMatchObject({
      state: "unanchored",
      anchorTier: "none",
      startLine: null,
      endLine: null,
    });
    // Nothing is deleted: the row is still updated, never removed.
    expect(updates).toHaveLength(1);
  });

  it("does not invent a line for a payload it cannot read", async () => {
    const rows: FindingRow[] = [
      { id: "f1", state: "submitted", encryptedContent: "not-a-vault-value" },
    ];
    const { db } = fakeDatabase(rows);
    const { model, requests } = stubModel({ relocate: "```\nanything\n```" });
    const result = await validateFileFindings(db, validationInput({ model }));
    expect(result.findings[0]?.state).toBe("unanchored");
    expect(requests).toHaveLength(0);
  });

  it("validates only findings still in state submitted", async () => {
    const rows = [
      await sealFinding({
        id: "f1",
        existingCode: "  const value = compute();",
        state: "anchored",
      }),
    ];
    const { db, updates } = fakeDatabase(rows);
    const result = await validateFileFindings(db, validationInput());
    expect(result.findings).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});

describe("scope gate", () => {
  it("routes an anchor on untouched code to out_of_scope", async () => {
    const rows = [
      await sealFinding({
        id: "f1",
        existingCode: "  const other = compute();",
      }),
    ];
    const { db } = fakeDatabase(rows);
    const result = await validateFileFindings(db, validationInput());
    expect(result.findings[0]).toMatchObject({
      state: "out_of_scope",
      anchorTier: "unit_current",
      startLine: 7,
    });
  });

  it("fails closed when a previous-side anchor has no previous ranges", async () => {
    const rows = [
      await sealFinding({
        id: "f1",
        existingCode: "  const legacy = computeLegacy();",
      }),
    ];
    const { db } = fakeDatabase(rows);
    const result = await validateFileFindings(
      db,
      validationInput({ previousChangedRanges: undefined }),
    );
    expect(result.findings[0]).toMatchObject({
      state: "out_of_scope",
      anchorSide: "previous",
      startLine: 2,
    });
  });
});

describe("evidence gate", () => {
  it("routes an anchor the agent never read to ungrounded", async () => {
    const rows = [
      await sealFinding({
        id: "f1",
        existingCode: "  const value = compute();",
      }),
    ];
    const { db } = fakeDatabase(rows);
    const result = await validateFileFindings(
      db,
      validationInput({
        evidence: [
          {
            id: "ev-current",
            sourceBlobId: currentBlobId,
            startLine: 6,
            endLine: 9,
          },
        ],
      }),
    );
    expect(result.findings[0]).toMatchObject({
      state: "ungrounded",
      startLine: 2,
    });
  });

  it("never grounds a previous-side anchor with a current-side read", async () => {
    const rows = [
      await sealFinding({
        id: "f1",
        existingCode: "  const legacy = computeLegacy();",
      }),
    ];
    const { db, links } = fakeDatabase(rows);
    // The one evidence row covers the anchored lines exactly, and differs from
    // the previous revision only by its blob: line ranges alone would pass.
    const result = await validateFileFindings(
      db,
      validationInput({
        evidence: [
          {
            id: "ev-current",
            sourceBlobId: currentBlobId,
            startLine: 1,
            endLine: 9,
          },
        ],
      }),
    );
    expect(result.findings[0]).toMatchObject({
      state: "ungrounded",
      anchorSide: "previous",
      anchorTier: "file_previous",
      startLine: 2,
    });
    expect(links).toHaveLength(0);
  });

  it("grounds a previous-side anchor on a previous-side read", async () => {
    const rows = [
      await sealFinding({
        id: "f1",
        existingCode: "  const legacy = computeLegacy();",
      }),
    ];
    const { db, links } = fakeDatabase(rows);
    const result = await validateFileFindings(
      db,
      validationInput({
        evidence: [
          {
            id: "ev-previous",
            sourceBlobId: previousBlobId,
            startLine: 1,
            endLine: 4,
          },
        ],
      }),
    );
    expect(result.findings[0]).toMatchObject({
      state: "anchored",
      anchorSide: "previous",
    });
    expect(links).toEqual([{ findingId: "f1", evidenceId: "ev-previous" }]);
  });

  it("fails closed when the side's blob id is unknown", async () => {
    const rows = [
      await sealFinding({
        id: "f1",
        existingCode: "  const value = compute();",
      }),
    ];
    const { db } = fakeDatabase(rows);
    const result = await validateFileFindings(
      db,
      validationInput({ currentBlobId: null }),
    );
    expect(result.findings[0]?.state).toBe("ungrounded");
  });
});

describe("relocation", () => {
  it("re-extracts a snippet and anchors it as relocated", async () => {
    const rows = [
      await sealFinding({
        id: "f1",
        existingCode: "const value = computeSomethingElse();",
      }),
    ];
    const { db, updates } = fakeDatabase(rows);
    const { model, requests } = stubModel({
      relocate: "```ts\n  const value = compute();\n```",
      refute: '{"votes":[{"id":"f1","verdict":"not_refuted"}]}',
    });
    const result = await validateFileFindings(db, validationInput({ model }));
    expect(result.relocationsAttempted).toBe(1);
    expect(result.relocationsResolved).toBe(1);
    expect(result.findings[0]).toMatchObject({
      state: "anchored",
      anchorTier: "relocated",
      startLine: 2,
      relocated: true,
    });
    expect(requests).toHaveLength(2);
    const resealed = updates[0]?.values.encryptedContent;
    expect(typeof resealed).toBe("string");
    expect(await openFinding("f1", String(resealed))).toMatchObject({
      existingCode: "const value = compute();",
      title: "A title",
    });
  });

  it("restores the original claim when the re-extraction still fails", async () => {
    const rows = [
      await sealFinding({
        id: "f1",
        existingCode: "const value = computeSomethingElse();",
      }),
    ];
    const { db, updates } = fakeDatabase(rows);
    const { model } = stubModel({
      relocate: "```ts\nconst stillNotInTheFile = true;\n```",
    });
    const result = await validateFileFindings(db, validationInput({ model }));
    expect(result.relocationsAttempted).toBe(1);
    expect(result.relocationsResolved).toBe(0);
    expect(result.findings[0]).toMatchObject({
      state: "unanchored",
      relocated: false,
    });
    // The stored content is untouched, so what surfaces is the model's own
    // claim rather than a failed re-extraction.
    expect(updates[0]?.values.encryptedContent).toBeUndefined();
    expect(
      await openFinding("f1", rows[0]?.encryptedContent ?? ""),
    ).toMatchObject({ existingCode: "const value = computeSomethingElse();" });
  });

  it("survives a relocation call that throws", async () => {
    const rows = [
      await sealFinding({ id: "f1", existingCode: "const missing = 1;" }),
    ];
    const { db } = fakeDatabase(rows);
    const { model } = stubModel({
      relocate: () => {
        throw new Error("provider exploded");
      },
    });
    const result = await validateFileFindings(db, validationInput({ model }));
    expect(result.findings[0]?.state).toBe("unanchored");
    expect(result.relocationsResolved).toBe(0);
  });

  it("stops relocating once a shared run budget is spent", async () => {
    const rows = [
      await sealFinding({ id: "f1", existingCode: "const missingOne = 1;" }),
      await sealFinding({ id: "f2", existingCode: "const missingTwo = 2;" }),
    ];
    const { db } = fakeDatabase(rows);
    const { model, requests } = stubModel({ relocate: "```\nnope\n```" });
    const budget = createRelocationBudget(1);
    const result = await validateFileFindings(
      db,
      validationInput({ model, relocationBudget: budget }),
    );
    expect(result.relocationsAttempted).toBe(1);
    expect(requests).toHaveLength(1);
    expect(budget.remaining).toBe(0);
    expect(result.findings.map((finding) => finding.state)).toEqual([
      "unanchored",
      "unanchored",
    ]);
  });
});

describe("refutation", () => {
  /** Seeds one anchored, grounded, in-scope finding for the judge to weigh. */
  async function anchoredRows() {
    return [
      await sealFinding({
        id: "f1",
        existingCode: "  const value = compute();",
      }),
    ];
  }

  it("discards a finding whose refutation cites a real path", async () => {
    const { db, updates } = fakeDatabase(await anchoredRows());
    const { model } = stubModel({
      refute:
        '{"votes":[{"id":"f1","verdict":"refuted","refutation":"compute() already returns a default","evidencePath":"src/alpha.ts","evidenceLine":2}]}',
    });
    const result = await validateFileFindings(db, validationInput({ model }));
    expect(result.refutationApplied).toBe(true);
    expect(result.findings[0]).toMatchObject({
      state: "refuted",
      verdict: "refuted",
      startLine: 2,
    });
    expect(result.findings[0]?.verdictReason).toContain("already returns");
    // The row keeps its anchor and its refutation: an auditable discard.
    expect(updates[0]?.values).toMatchObject({
      state: "refuted",
      startLine: 2,
    });
  });

  it("keeps a finding whose refutation cites a path outside the snapshot", async () => {
    const { db } = fakeDatabase(await anchoredRows());
    const { model } = stubModel({
      refute:
        '{"votes":[{"id":"f1","verdict":"refuted","refutation":"handled elsewhere","evidencePath":"src/not-in-the-pr.ts","evidenceLine":2}]}',
    });
    const result = await validateFileFindings(db, validationInput({ model }));
    expect(result.findings[0]).toMatchObject({
      state: "anchored",
      verdict: "unverified",
      verdictReason: null,
    });
  });

  it("keeps a finding whose refutation cites nothing at all", async () => {
    const { db } = fakeDatabase(await anchoredRows());
    const { model } = stubModel({
      refute: '{"votes":[{"id":"f1","verdict":"refuted"}]}',
    });
    const result = await validateFileFindings(db, validationInput({ model }));
    expect(result.findings[0]).toMatchObject({
      state: "anchored",
      verdict: "unverified",
    });
  });

  it("surfaces everything when the refuter throws", async () => {
    const { db } = fakeDatabase(await anchoredRows());
    const { model } = stubModel({
      refute: () => {
        throw new Error("504 gateway timeout");
      },
    });
    const result = await validateFileFindings(db, validationInput({ model }));
    expect(result.refutationApplied).toBe(false);
    expect(result.findings[0]).toMatchObject({
      state: "anchored",
      verdict: "unverified",
    });
  });

  it("surfaces everything when the answer cannot be parsed", async () => {
    const { db } = fakeDatabase(await anchoredRows());
    const { model } = stubModel({ refute: "All of these look fine to me." });
    const result = await validateFileFindings(db, validationInput({ model }));
    expect(result.refutationApplied).toBe(false);
    expect(result.findings[0]?.verdict).toBe("unverified");
  });

  it("surfaces everything when one id is voted on twice", async () => {
    const rows = [
      await sealFinding({
        id: "f1",
        existingCode: "  const value = compute();",
      }),
      await sealFinding({ id: "f2", existingCode: "  return value;" }),
    ];
    const { db } = fakeDatabase(rows);
    const { model } = stubModel({
      refute: JSON.stringify({
        votes: [
          {
            id: "f1",
            verdict: "refuted",
            refutation: "guarded above",
            evidencePath: path,
            evidenceLine: 2,
          },
          {
            id: "f1",
            verdict: "not_refuted",
          },
          {
            id: "f2",
            verdict: "refuted",
            refutation: "dead code",
            evidencePath: path,
            evidenceLine: 3,
          },
        ],
      }),
    });
    const result = await validateFileFindings(db, validationInput({ model }));
    expect(result.findings.map((finding) => finding.state)).toEqual([
      "anchored",
      "anchored",
    ]);
    expect(
      result.findings.every((finding) => finding.verdict === "unverified"),
    ).toBe(true);
  });

  it("judges only anchored findings, and only once per file", async () => {
    const rows = [
      await sealFinding({
        id: "f1",
        existingCode: "  const value = compute();",
      }),
      await sealFinding({
        id: "f2",
        existingCode: "  const other = compute();",
      }),
      await sealFinding({ id: "f3", existingCode: "const nowhere = true;" }),
    ];
    const { db } = fakeDatabase(rows);
    const { model, requests } = stubModel({
      relocate: "```\nstill missing\n```",
      refute: '{"votes":[{"id":"f1","verdict":"not_refuted"}]}',
    });
    const result = await validateFileFindings(db, validationInput({ model }));
    const refuteCalls = requests.filter(
      (request) => request.system === DEEP_REVIEW_REFUTE_SYSTEM_PROMPT,
    );
    expect(refuteCalls).toHaveLength(1);
    expect(refuteCalls[0]?.prompt).toContain("f1");
    expect(refuteCalls[0]?.prompt).not.toContain("f2");
    expect(refuteCalls[0]?.prompt).not.toContain("f3");
    expect(result.findings.map((finding) => finding.state)).toEqual([
      "anchored",
      "out_of_scope",
      "unanchored",
    ]);
  });

  it("makes no model call at all when no finding survives to judgement", async () => {
    const rows = [
      await sealFinding({
        id: "f1",
        existingCode: "  const other = compute();",
      }),
    ];
    const { db } = fakeDatabase(rows);
    const { model, requests } = stubModel({});
    const result = await validateFileFindings(db, validationInput({ model }));
    expect(requests).toHaveLength(0);
    expect(result.refutationApplied).toBe(false);
  });
});
