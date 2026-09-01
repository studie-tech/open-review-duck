import type { ModelMessage } from "@ai-sdk/provider-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => ({
  open: vi.fn(async (_scope: unknown, value: string) =>
    value.replace(/^sealed:/, ""),
  ),
  seal: vi.fn(async (_scope: unknown, value: string) => `sealed:${value}`),
}));

vi.mock("~/server/security/vault", () => ({
  openVaultSecret: vault.open,
  sealVaultSecret: vault.seal,
}));

import { aiJobToolCalls, aiJobTurns } from "@/drizzle/schema";
import {
  executeDurableToolCall,
  loadAiMessages,
  persistAiMessage,
} from "./durable-state";

interface StoredTurn {
  id: string;
  jobId: string;
  sequence: number;
  role: string;
  encryptedContent: string;
}

interface StoredToolCall {
  id: string;
  jobId: string;
  toolCallId: string;
  status: "running" | "completed" | "failed";
  encryptedOutput: string | null;
  [key: string]: unknown;
}

/** Builds the persistence surface used by the shared durable state helpers. */
function createFakeDb(input?: { toolCall?: StoredToolCall }) {
  const turns: StoredTurn[] = [];
  const toolCalls: StoredToolCall[] = input?.toolCall ? [input.toolCall] : [];
  const db = {
    query: {
      aiJobTurns: {
        findMany: async () =>
          [...turns].sort((a, b) => a.sequence - b.sequence),
      },
      aiJobToolCalls: {
        findFirst: async () => toolCalls[0],
      },
    },
    insert(table: unknown) {
      return {
        values(row: Record<string, unknown>) {
          if (table === aiJobTurns) turns.push(row as unknown as StoredTurn);
          if (table === aiJobToolCalls) {
            toolCalls.push({
              ...row,
              id: String(row.id),
              jobId: String(row.jobId),
              toolCallId: String(row.toolCallId),
              status: "running",
              encryptedOutput: null,
            });
          }
          return {
            onConflictDoNothing: async () => [],
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where: async () => {
              if (table === aiJobToolCalls && toolCalls[0]) {
                Object.assign(toolCalls[0], values);
              }
              return [];
            },
          };
        },
      };
    },
  };
  return { db: db as never, toolCalls, turns };
}

const job = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};

describe("durable AI state", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the persisted turn id for both sealing and opening", async () => {
    const { db, turns } = createFakeDb();
    const message: ModelMessage = { role: "user", content: "inspect this" };

    await persistAiMessage(db, job, 3, message);
    await expect(loadAiMessages(db, job)).resolves.toEqual([message]);

    const turnId = turns[0]?.id;
    expect(turnId).toBeTruthy();
    const scope = {
      workspaceId: job.workspaceId,
      recordId: turnId,
      provider: "ai-turn",
    };
    expect(vault.seal).toHaveBeenCalledWith(scope, JSON.stringify(message));
    expect(vault.open).toHaveBeenCalledWith(
      scope,
      `sealed:${JSON.stringify(message)}`,
    );
  });

  it("replays a completed tool output without executing its handler", async () => {
    const existing = {
      id: "00000000-0000-4000-8000-000000000003",
      jobId: job.id,
      toolCallId: "call-1",
      status: "completed" as const,
      encryptedOutput: 'sealed:{"paths":["src/a.ts"]}',
    };
    const { db } = createFakeDb({ toolCall: existing });
    const execute = vi.fn();

    await expect(
      executeDurableToolCall(db, job, 2, {
        callId: "call-1",
        name: "list_files",
        arguments: {},
        execute,
        sanitizeError: () => "safe",
      }),
    ).resolves.toEqual({ paths: ["src/a.ts"] });

    expect(execute).not.toHaveBeenCalled();
    expect(vault.open).toHaveBeenCalledWith(
      {
        workspaceId: job.workspaceId,
        recordId: existing.id,
        provider: "ai-tool-output",
      },
      existing.encryptedOutput,
    );
  });

  it("persists only the caller's sanitized tool failure", async () => {
    const { db, toolCalls } = createFakeDb();
    const cause = new Error("Bearer secret-provider-token");
    const sanitizeError = vi.fn(() => "Provider credentials were rejected");

    await expect(
      executeDurableToolCall(db, job, 5, {
        callId: "call-2",
        name: "read_file",
        arguments: { path: "src/a.ts" },
        execute: async () => {
          throw cause;
        },
        sanitizeError,
      }),
    ).rejects.toBe(cause);

    expect(sanitizeError).toHaveBeenCalledWith(cause);
    expect(toolCalls[0]).toMatchObject({ status: "failed" });
    expect(toolCalls[0]?.encryptedOutput).toBe(
      'sealed:{"error":"Provider credentials were rejected"}',
    );
    expect(toolCalls[0]?.encryptedOutput).not.toContain(
      "secret-provider-token",
    );
    const recordId = toolCalls[0]?.id;
    expect(vault.seal).toHaveBeenCalledWith(
      {
        workspaceId: job.workspaceId,
        recordId,
        provider: "ai-tool-input",
      },
      JSON.stringify({ path: "src/a.ts" }),
    );
    expect(vault.seal).toHaveBeenCalledWith(
      {
        workspaceId: job.workspaceId,
        recordId,
        provider: "ai-tool-output",
      },
      JSON.stringify({ error: "Provider credentials were rejected" }),
    );
  });
});
