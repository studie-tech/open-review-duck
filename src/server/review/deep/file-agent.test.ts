import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/env", () => ({
  env: {
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    AI_MAX_TOOL_CALLS: 256,
    AI_MAX_SOURCE_BYTES: 8 * 1024 * 1024,
    AI_MAX_DISTINCT_FILES: 40,
    AI_MAX_DURATION_MS: 1_800_000,
  },
}));

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  resolveAiModel: vi.fn(async () => ({
    model: "model" as never,
    providerOptions: undefined,
  })),
  deepReviewFileTools: vi.fn(),
  deepReviewFileFinished: vi.fn(async () => false),
  createDeepReviewContext: vi.fn(),
  validateFileFindings: vi.fn(async () => ({ findings: [] })),
  deepReviewSurveyTools: vi.fn(() => ({})),
  deepReviewSurveyFinished: vi.fn(async () => false),
  validateDeepReviewSurveyFindings: vi.fn(async () => ({ anchored: 0 })),
  deepReviewSurveyPromptInput: vi.fn(async () => ({
    pullRequest: {
      title: "Harden the token exchange",
      description: null,
      sourceBranch: "feature",
      targetBranch: "main",
    },
    files: [],
    units: [],
    dependencies: [],
  })),
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
  stepCountIs: () => undefined,
}));
vi.mock("~/server/ai/models", () => ({ resolveAiModel: mocks.resolveAiModel }));
vi.mock("~/server/security/vault", () => ({
  sealVaultSecret: async (_scope: unknown, value: string) => value,
  openVaultSecret: async (_scope: unknown, value: string) => value,
}));
vi.mock("./context", () => ({
  createDeepReviewContext: mocks.createDeepReviewContext,
}));
vi.mock("./file-tools", () => ({
  deepReviewFileTools: mocks.deepReviewFileTools,
  deepReviewFileFinished: mocks.deepReviewFileFinished,
}));
vi.mock("./validate", () => ({
  validateFileFindings: mocks.validateFileFindings,
  /** Stands in for the lazily resolved relocation and refutation client. */
  deepReviewValidationModel: () => ({ generate: async () => "" }),
}));
vi.mock("./survey", () => ({
  deepReviewSurveyTools: mocks.deepReviewSurveyTools,
  deepReviewSurveyFinished: mocks.deepReviewSurveyFinished,
  deepReviewSurveyPromptInput: mocks.deepReviewSurveyPromptInput,
  validateDeepReviewSurveyFindings: mocks.validateDeepReviewSurveyFindings,
}));

import {
  aiJobEvidence,
  aiJobs,
  aiJobToolCalls,
  aiJobTurns,
  aiReviewItems,
} from "@/drizzle/schema";
import type { DeepReviewContext } from "./context";
import {
  deepReviewRunStop,
  executeReviewFileTurn,
  executeReviewSurveyTurn,
  fileChangedRanges,
  parsePlanCheckpoints,
} from "./file-agent";

const parentJobId = "00000000-0000-4000-8000-000000000001";
const childJobId = "00000000-0000-4000-8000-000000000002";
const workspaceId = "00000000-0000-4000-8000-0000000000bb";

interface FakeRunState {
  child: Record<string, unknown>;
  parent: Record<string, unknown>;
  item: Record<string, unknown>;
  toolCalls: number;
  sourceBytes: number;
  consumedTokens: number;
  consumedMicroUsd: number;
  turns: { id: string; sequence: number; role: string; content: string }[];
}

interface RecordedUpdate {
  table: string;
  values: Record<string, unknown>;
}

/** Names a drizzle table for a test assertion without importing its metadata. */
function tableName(table: unknown): string {
  if (table === aiJobs) return "aiJobs";
  if (table === aiReviewItems) return "aiReviewItems";
  if (table === aiJobToolCalls) return "aiJobToolCalls";
  if (table === aiJobEvidence) return "aiJobEvidence";
  return "other";
}

/**
 * Builds the narrowest database double the turn path exercises.
 *
 * Job reads are answered from a queue because the turn reads the child first
 * and its parent second, and a drizzle `where` clause cannot be introspected
 * back into the id it filters on.
 */
function createFakeDb(state: FakeRunState) {
  const updates: RecordedUpdate[] = [];
  const jobReads = [state.child, state.parent];
  const db = {
    query: {
      aiJobs: {
        /** Returns the child, then its parent, in the order the turn reads them. */
        findFirst: async () => jobReads.shift() ?? state.parent,
      },
      aiReviewItems: {
        /** Returns the one item this child job reviews. */
        findFirst: async () => state.item,
      },
      aiJobTurns: {
        /** Returns the durable transcript, sealed as plain text by the mock. */
        findMany: async () =>
          state.turns.map((turn) => ({
            id: turn.id,
            sequence: turn.sequence,
            encryptedContent: turn.content,
          })),
      },
      aiJobToolCalls: {
        /** Reports no stored tool call, so every tool body would run fresh. */
        findFirst: async () => undefined,
      },
      managedAiModels: {
        /** Reports no managed pricing, matching an unmetered provider. */
        findFirst: async () => undefined,
      },
      pullRequests: {
        /** Returns the pull-request framing every scout prompt opens with. */
        findFirst: async () => ({
          id: "pull-request",
          title: "Harden the token exchange",
          description: null,
          sourceBranch: "feature",
          targetBranch: "main",
        }),
      },
    },
    /** Records an update and applies the state changes the turn depends on. */
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          updates.push({ table: tableName(table), values });
          if (table === aiReviewItems) Object.assign(state.item, values);
          return { where: async () => [] };
        },
      };
    },
    /** Persists a transcript row so a re-read returns what was just written. */
    insert(table: unknown) {
      return {
        values: (row: Record<string, unknown>) => {
          if (table === aiJobTurns) {
            state.turns.push({
              id: String(row.id),
              sequence: Number(row.sequence),
              role: String(row.role),
              content: String(row.encryptedContent),
            });
          }
          const settled = Promise.resolve([] as unknown[]) as Promise<
            unknown[]
          > & { onConflictDoNothing?: () => Promise<unknown[]> };
          settled.onConflictDoNothing = async () => [];
          return settled;
        },
      };
    },
    /** Answers every aggregate the run-level gate reads, keyed by its table. */
    select() {
      return {
        from(table: unknown) {
          /** Resolves the aggregate row this table stands for. */
          const rows = () => {
            if (table === aiJobToolCalls) return [{ calls: state.toolCalls }];
            if (table === aiJobEvidence) return [{ bytes: state.sourceBytes }];
            if (table === aiReviewItems) return [{ total: 1, settled: 1 }];
            return [
              {
                tokens: state.consumedTokens,
                microUsd: state.consumedMicroUsd,
              },
            ];
          };
          return {
            innerJoin: () => ({ where: async () => rows() }),
            where: async () => rows(),
          };
        },
      };
    },
    /** Answers the distinct-path read the tools are seeded with. */
    selectDistinct() {
      return { from: () => ({ where: async () => [] }) };
    },
    /** Counts findings already reported for this item. */
    $count: async () => 0,
  };
  return { db: db as never, updates };
}

/** Builds the run state a healthy first turn starts from. */
function createState(overrides: Partial<FakeRunState> = {}): FakeRunState {
  return {
    child: {
      id: childJobId,
      parentJobId,
      workspaceId,
      pullRequestId: "pull-request",
      snapshotId: "snapshot",
      status: "queued",
      startedAt: null,
      provider: "openrouter",
      model: "anthropic/claude",
    },
    parent: {
      id: parentJobId,
      parentJobId: null,
      status: "running",
      startedAt: new Date(),
      cancelledAt: null,
      reservedInputTokens: 0,
      reservedOutputTokens: 0,
      reservedMicroUsd: 0,
    },
    item: {
      id: "item-1",
      path: "src/auth/token.ts",
      changeType: "modified",
      changedLineCount: 12,
      state: "selected",
      failureClass: null,
      reason: null,
    },
    toolCalls: 0,
    sourceBytes: 0,
    consumedTokens: 0,
    consumedMicroUsd: 0,
    turns: [],
    ...overrides,
  };
}

/** Builds the repository context the prompt builder reads two revisions from. */
function fakeRepository(): DeepReviewContext {
  return {
    runJobId: parentJobId,
    snapshot: { id: "snapshot" },
    repository: { id: "repository" },
    listFiles: async () => ["src/auth/token.ts"],
    readFile: async () => ({
      blob: { id: "blob", digest: "digest" },
      snapshotFileId: "file-1",
      source: "const token = read();\nreturn token;\n",
    }),
    readPreviousSource: async () => "const token = read();\n",
    searchCode: async () => [],
    units: async () => [
      {
        path: "src/auth/token.ts",
        name: "exchange",
        kind: "function",
        startLine: 1,
        endLine: 2,
      },
    ],
    changedFile: () => undefined,
    changedFiles: () => [],
    sourceDecision: async () => ({ allowed: true }),
    dispose: () => undefined,
  } as unknown as DeepReviewContext;
}

/** Shapes one provider response the turn accumulates usage from. */
function modelResult(overrides: Record<string, unknown> = {}) {
  return {
    text: "",
    responseMessages: [],
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      inputTokenDetails: {},
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deepReviewFileTools.mockReturnValue({});
  mocks.deepReviewFileFinished.mockResolvedValue(false);
  mocks.deepReviewSurveyTools.mockReturnValue({});
  mocks.deepReviewSurveyFinished.mockResolvedValue(false);
  mocks.resolveAiModel.mockResolvedValue({
    model: "model" as never,
    providerOptions: undefined,
  });
  mocks.generateText.mockResolvedValue(modelResult());
});

describe("deepReviewRunStop", () => {
  const usage = {
    toolCalls: 0,
    sourceBytes: 0,
    consumedTokens: 0,
    consumedMicroUsd: 0,
  };
  const parent = {
    startedAt: new Date(1_000),
    cancelledAt: null,
    status: "running" as const,
    reservedInputTokens: 0,
    reservedOutputTokens: 0,
    reservedMicroUsd: 0,
  };

  it("allows a turn inside every ceiling", () => {
    expect(deepReviewRunStop({ parent, usage, now: 2_000 })).toBeNull();
  });

  it("stops a cancelled run before it spends another turn", () => {
    const stop = deepReviewRunStop({
      parent: { ...parent, cancelledAt: new Date(1_500) },
      usage,
      now: 2_000,
    });
    expect(stop?.failureClass).toBe("cancelled");
  });

  it("measures the wall clock from the parent, not from the file", () => {
    const stop = deepReviewRunStop({
      parent,
      usage,
      now: 1_000 + 1_800_000,
    });
    expect(stop?.failureClass).toBe("timeout");
  });

  it("counts tool calls across the whole tree", () => {
    const stop = deepReviewRunStop({
      parent,
      usage: { ...usage, toolCalls: 256 },
      now: 2_000,
    });
    expect(stop?.failureClass).toBe("tool_limit");
  });

  it("bounds source exposure across the whole tree", () => {
    const stop = deepReviewRunStop({
      parent,
      usage: { ...usage, sourceBytes: 8 * 1024 * 1024 },
      now: 2_000,
    });
    expect(stop?.failureClass).toBe("budget");
  });

  it("stops when the tree consumed the parent's token reservation", () => {
    const stop = deepReviewRunStop({
      parent: {
        ...parent,
        reservedInputTokens: 900,
        reservedOutputTokens: 100,
      },
      usage: { ...usage, consumedTokens: 1_000 },
      now: 2_000,
    });
    expect(stop?.failureClass).toBe("budget");
  });

  it("stops when the tree consumed the parent's cost reservation", () => {
    const stop = deepReviewRunStop({
      parent: { ...parent, reservedMicroUsd: 500 },
      usage: { ...usage, consumedMicroUsd: 500 },
      now: 2_000,
    });
    expect(stop?.failureClass).toBe("budget");
  });
});

describe("parsePlanCheckpoints", () => {
  it("reads the bare JSON object the contract asks for", () => {
    const parsed = parsePlanCheckpoints(
      '{"checkpoints":[{"focus":"the retry loop","lines":"12-40","why":"it can spin"}]}',
    );
    expect(parsed).toEqual([
      { focus: "the retry loop", lines: "12-40", why: "it can spin" },
    ]);
  });

  it("tolerates a fence the contract does not ask for", () => {
    const parsed = parsePlanCheckpoints(
      '```json\n{"checkpoints":[{"focus":"a","lines":"1","why":"b"}]}\n```',
    );
    expect(parsed).toHaveLength(1);
  });

  it("caps the plan at five checkpoints", () => {
    const checkpoints = Array.from({ length: 9 }, (_, index) => ({
      focus: `focus ${index}`,
      lines: `${index + 1}`,
      why: "risk",
    }));
    expect(parsePlanCheckpoints(JSON.stringify({ checkpoints }))).toHaveLength(
      5,
    );
  });

  it("degrades an empty, malformed or unparseable plan to no plan", () => {
    expect(parsePlanCheckpoints('{"checkpoints":[]}')).toBeUndefined();
    expect(parsePlanCheckpoints("I could not plan this file.")).toBeUndefined();
    expect(
      parsePlanCheckpoints('{"checkpoints":[{"focus":1}]}'),
    ).toBeUndefined();
  });
});

describe("fileChangedRanges", () => {
  it("treats every line of an added file as changed", () => {
    expect(fileChangedRanges("added", "one\ntwo\nthree", null)).toEqual([
      { startLine: 1, endLine: 3 },
    ]);
  });

  it("reports no current-revision range for a deleted file", () => {
    expect(fileChangedRanges("deleted", null, "one\ntwo")).toEqual([]);
  });

  it("reports only the lines a modification touched", () => {
    expect(
      fileChangedRanges("modified", "one\nchanged\nthree", "one\ntwo\nthree"),
    ).toEqual([{ startLine: 2, endLine: 2 }]);
  });
});

describe("executeReviewFileTurn", () => {
  it("completes the file when the scout calls finish_file", async () => {
    const state = createState();
    const { db, updates } = createFakeDb(state);
    mocks.deepReviewFileTools.mockImplementation(
      (context: { onFinishFile?: (input: { summary: string }) => void }) => {
        mocks.generateText.mockImplementation(async () => {
          context.onFinishFile?.({ summary: "reviewed" });
          return modelResult();
        });
        return {};
      },
    );

    const result = await executeReviewFileTurn(db, {
      childJobId,
      turnIndex: 0,
      context: fakeRepository(),
    });

    expect(result).toMatchObject({ done: true, state: "completed" });
    expect(
      updates.some(
        (update) =>
          update.table === "aiReviewItems" &&
          update.values.state === "completed",
      ),
    ).toBe(true);
  });

  it("keeps the turn open when the scout has budget left", async () => {
    const state = createState();
    const { db } = createFakeDb(state);

    const result = await executeReviewFileTurn(db, {
      childJobId,
      turnIndex: 0,
      maxTurns: 3,
      context: fakeRepository(),
    });

    expect(result).toMatchObject({ done: false, state: "selected" });
  });

  it("covers a file whose scout used every turn without finishing", async () => {
    const state = createState();
    const { db } = createFakeDb(state);

    const result = await executeReviewFileTurn(db, {
      childJobId,
      turnIndex: 2,
      maxTurns: 3,
      context: fakeRepository(),
    });

    expect(result).toMatchObject({
      done: true,
      state: "completed",
      reason: "turn_limit",
    });
  });

  it("treats a replayed finish_file as terminal without the callback", async () => {
    const state = createState();
    const { db } = createFakeDb(state);
    mocks.deepReviewFileFinished.mockResolvedValue(true);

    const result = await executeReviewFileTurn(db, {
      childJobId,
      turnIndex: 0,
      context: fakeRepository(),
    });

    expect(result).toMatchObject({ done: true, state: "completed" });
  });

  it("fails one file without failing the run when the model throws", async () => {
    const state = createState();
    const { db, updates } = createFakeDb(state);
    mocks.generateText.mockRejectedValue(
      new Error("Provider request failed with status 503"),
    );

    const result = await executeReviewFileTurn(db, {
      childJobId,
      turnIndex: 0,
      context: fakeRepository(),
    });

    expect(result).toMatchObject({ done: true, state: "failed" });
    expect(result.failureClass).toBe("provider");
    expect(
      updates.some(
        (update) =>
          update.table === "aiJobs" && update.values.status === "failed",
      ),
    ).toBe(true);
  });

  it("redacts a credential out of the reason it persists", async () => {
    const state = createState();
    const { db } = createFakeDb(state);
    mocks.generateText.mockRejectedValue(
      new Error("provider rejected Authorization: Bearer sk-abcdef0123456789"),
    );

    const result = await executeReviewFileTurn(db, {
      childJobId,
      turnIndex: 0,
      context: fakeRepository(),
    });

    expect(result.reason).not.toContain("sk-abcdef0123456789");
    expect(result.reason).toContain("[REDACTED]");
  });

  it("stops a cancelled run before it calls the model", async () => {
    const state = createState();
    state.parent.cancelledAt = new Date();
    const { db } = createFakeDb(state);

    const result = await executeReviewFileTurn(db, {
      childJobId,
      turnIndex: 0,
      context: fakeRepository(),
    });

    expect(result).toMatchObject({ done: true, state: "failed" });
    expect(result.failureClass).toBe("cancelled");
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("stops a file whose tree already exhausted the tool-call ceiling", async () => {
    const state = createState({ toolCalls: 256 });
    const { db } = createFakeDb(state);

    const result = await executeReviewFileTurn(db, {
      childJobId,
      turnIndex: 0,
      context: fakeRepository(),
    });

    expect(result.failureClass).toBe("tool_limit");
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("never reviews an item another pass already settled", async () => {
    const state = createState();
    state.item.state = "failed";
    state.item.failureClass = "cancelled";
    const { db } = createFakeDb(state);

    const result = await executeReviewFileTurn(db, {
      childJobId,
      turnIndex: 0,
      context: fakeRepository(),
    });

    expect(result).toMatchObject({ done: true, state: "failed" });
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("plans before reviewing a file with many changed lines", async () => {
    const state = createState();
    state.item.changedLineCount = 400;
    const { db } = createFakeDb(state);
    mocks.generateText
      .mockResolvedValueOnce(
        modelResult({
          text: '{"checkpoints":[{"focus":"the retry loop","lines":"12-40","why":"it can spin"}]}',
        }),
      )
      .mockResolvedValueOnce(modelResult());

    await executeReviewFileTurn(db, {
      childJobId,
      turnIndex: 0,
      context: fakeRepository(),
    });

    expect(mocks.generateText).toHaveBeenCalledTimes(2);
    const scoutPrompt = String(
      mocks.generateText.mock.calls[1]?.[0].messages[0].content,
    );
    expect(scoutPrompt).toContain("the retry loop");
  });

  it("reviews a small file without a planning call", async () => {
    const state = createState();
    const { db } = createFakeDb(state);

    await executeReviewFileTurn(db, {
      childJobId,
      turnIndex: 0,
      context: fakeRepository(),
    });

    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    const scoutPrompt = String(
      mocks.generateText.mock.calls[0]?.[0].messages[0].content,
    );
    expect(scoutPrompt).toContain("no pre-scan plan");
  });

  it("charges the run's source bytes, not the file's, against the tools", async () => {
    const state = createState({ sourceBytes: 4_096 });
    const { db } = createFakeDb(state);

    await executeReviewFileTurn(db, {
      childJobId,
      turnIndex: 0,
      context: fakeRepository(),
    });

    expect(mocks.deepReviewFileTools).toHaveBeenCalledWith(
      expect.objectContaining({ sourceBytesRead: 4_096 }),
    );
  });

  it("refuses a job that is not a deep review child", async () => {
    const state = createState();
    state.child.parentJobId = null;
    const { db } = createFakeDb(state);

    await expect(
      executeReviewFileTurn(db, { childJobId, turnIndex: 0 }),
    ).rejects.toThrow("requires a deep review child job");
  });

  it("validates a file's findings before it closes the item", async () => {
    const state = createState();
    const { db } = createFakeDb(state);
    mocks.deepReviewFileFinished.mockResolvedValue(true);

    await executeReviewFileTurn(db, {
      childJobId,
      turnIndex: 0,
      context: fakeRepository(),
    });

    // Anchoring has to happen before finalize freezes an order, or a finding
    // left in `submitted` is ranked nowhere and surfaced to nobody.
    expect(mocks.validateFileFindings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        item: { id: "item-1", path: "src/auth/token.ts" },
      }),
    );
    expect(state.item.state).toBe("completed");
  });

  it("does not validate a file whose turn failed", async () => {
    const state = createState();
    const { db } = createFakeDb(state);
    mocks.generateText.mockRejectedValue(new Error("fetch failed"));

    await executeReviewFileTurn(db, {
      childJobId,
      turnIndex: 0,
      context: fakeRepository(),
    });

    expect(mocks.validateFileFindings).not.toHaveBeenCalled();
  });
});

describe("executeReviewSurveyTurn", () => {
  it("runs the survey against its own coverage item", async () => {
    const state = createState();
    state.item.path = "(cross-file survey)";
    state.item.changeType = "survey";
    const { db } = createFakeDb(state);
    mocks.deepReviewSurveyFinished.mockResolvedValue(true);

    const result = await executeReviewSurveyTurn(db, {
      childJobId,
      turnIndex: 0,
      context: fakeRepository(),
    });

    expect(result).toMatchObject({ done: true, state: "completed" });
    expect(mocks.deepReviewSurveyTools).toHaveBeenCalled();
    expect(mocks.deepReviewFileTools).not.toHaveBeenCalled();
    expect(mocks.validateDeepReviewSurveyFindings).toHaveBeenCalled();
  });

  it("stops the survey on the same run-level ceilings a file stops on", async () => {
    const state = createState({ toolCalls: 256 });
    state.item.path = "(cross-file survey)";
    const { db } = createFakeDb(state);

    const result = await executeReviewSurveyTurn(db, {
      childJobId,
      turnIndex: 0,
      context: fakeRepository(),
    });

    expect(result.failureClass).toBe("tool_limit");
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
});
