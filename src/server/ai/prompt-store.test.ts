import { describe, expect, it, vi } from "vitest";
import { AI_PROMPT_KEYS } from "~/config/ai-prompt-catalog";
import type { db as database } from "~/server/db";
import { defaultAiPromptBody } from "./prompt-defaults";
import { listAiPrompts, loadAiPromptBodies } from "./prompt-store";

type Database = typeof database;

/** Creates the prompt-store surface of the database with observable seeding. */
function promptDatabase(findMany: ReturnType<typeof vi.fn>): {
  db: Database;
  insertedValues: ReturnType<typeof vi.fn>;
} {
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const insertedValues = vi.fn(() => ({ onConflictDoNothing }));
  return {
    db: {
      query: { aiPrompts: { findMany } },
      insert: vi.fn(() => ({ values: insertedValues })),
    } as unknown as Database,
    insertedValues,
  };
}

describe("AI prompt loading", () => {
  it("seeds and retains the shipped default for a missing key", async () => {
    const missingKey = "explain.system";
    const storedKeys = AI_PROMPT_KEYS.filter((key) => key !== missingKey).map(
      (key) => ({ key }),
    );
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(storedKeys)
      .mockResolvedValueOnce([]);
    const { db, insertedValues } = promptDatabase(findMany);

    const bodies = await loadAiPromptBodies(db);

    expect(bodies[missingKey]).toBe(defaultAiPromptBody(missingKey));
    expect(insertedValues).toHaveBeenCalledWith([
      { key: missingKey, body: defaultAiPromptBody(missingKey) },
    ]);
  });

  it("overlays stored administrator edits on the shipped defaults", async () => {
    const key = "semantic.cluster.system";
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(
        AI_PROMPT_KEYS.map((storedKey) => ({ key: storedKey })),
      )
      .mockResolvedValueOnce([{ key, body: "Administrator override" }]);
    const { db, insertedValues } = promptDatabase(findMany);

    const bodies = await loadAiPromptBodies(db);

    expect(bodies[key]).toBe("Administrator override");
    expect(insertedValues).not.toHaveBeenCalled();
  });

  it("ignores unknown stored rows and retains known shipped defaults", async () => {
    const knownKey = "explain.system";
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(AI_PROMPT_KEYS.map((key) => ({ key })))
      .mockResolvedValueOnce([
        { key: "retired.prompt", body: "Obsolete override" },
      ]);
    const { db, insertedValues } = promptDatabase(findMany);

    const bodies = await loadAiPromptBodies(db);

    expect(bodies[knownKey]).toBe(defaultAiPromptBody(knownKey));
    expect(bodies).not.toHaveProperty("retired.prompt");
    expect(insertedValues).not.toHaveBeenCalled();
  });

  it("propagates database failures while ensuring prompt rows", async () => {
    const failure = new Error("prompt table is unavailable");
    const { db } = promptDatabase(vi.fn().mockRejectedValue(failure));

    await expect(loadAiPromptBodies(db)).rejects.toBe(failure);
  });

  it("propagates database failures while reading prompt bodies", async () => {
    const failure = new Error("prompt rows cannot be read");
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(AI_PROMPT_KEYS.map((key) => ({ key })))
      .mockRejectedValueOnce(failure);
    const { db } = promptDatabase(findMany);

    await expect(loadAiPromptBodies(db)).rejects.toBe(failure);
  });

  it("does not hide prompt-store failures from the admin listing", async () => {
    const failure = new Error("prompt permissions denied");
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(AI_PROMPT_KEYS.map((key) => ({ key })))
      .mockRejectedValueOnce(failure);
    const { db } = promptDatabase(findMany);

    await expect(listAiPrompts(db)).rejects.toBe(failure);
  });
});
