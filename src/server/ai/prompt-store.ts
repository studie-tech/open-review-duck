import "server-only";

import { aiPrompts } from "@/drizzle/schema";
import {
  AI_PROMPT_CATALOG,
  AI_PROMPT_KEYS,
  type AiPromptKey,
  isAiPromptKey,
} from "~/config/ai-prompt-catalog";
import type { ReviewDuckAgentPromptBodies } from "~/config/prompts";
import type { db as database } from "~/server/db";
import type { DeepReviewPromptBodies } from "~/server/review/deep/review-prompts";
import { defaultAiPromptBodies, defaultAiPromptBody } from "./prompt-defaults";

type Database = typeof database;

const seedLocks = new WeakMap<object, Promise<void>>();

/** Inserts any catalog keys that are not yet stored, without overwriting edits. */
export async function ensureAiPrompts(db: Database) {
  const pending = seedLocks.get(db);
  if (pending) {
    await pending;
    return;
  }
  const run = (async () => {
    const stored = await db.query.aiPrompts.findMany({
      columns: { key: true },
    });
    const present = new Set(stored.map((row) => row.key));
    const missing = AI_PROMPT_KEYS.filter((key) => !present.has(key));
    if (missing.length === 0) return;
    await db
      .insert(aiPrompts)
      .values(
        missing.map((key) => ({
          key,
          body: defaultAiPromptBody(key),
        })),
      )
      .onConflictDoNothing({ target: aiPrompts.key });
  })().finally(() => {
    seedLocks.delete(db);
  });
  seedLocks.set(db, run);
  await run;
}

/** Loads every prompt body, seeding defaults for keys that have never been saved. */
export async function loadAiPromptBodies(db: Database) {
  await ensureAiPrompts(db);
  const rows = await db.query.aiPrompts.findMany();
  const bodies = defaultAiPromptBodies();
  for (const row of rows) {
    if (isAiPromptKey(row.key)) bodies[row.key] = row.body;
  }
  return bodies;
}

/** Persists an administrator edit for one known prompt. */
export async function saveAiPrompt(
  db: Database,
  input: { key: AiPromptKey; body: string; userId: string },
) {
  await ensureAiPrompts(db);
  await db
    .insert(aiPrompts)
    .values({
      key: input.key,
      body: input.body,
      updatedByUserId: input.userId,
    })
    .onConflictDoUpdate({
      target: aiPrompts.key,
      set: {
        body: input.body,
        updatedByUserId: input.userId,
        updatedAt: new Date(),
      },
    });
}

/** Projects stored bodies into the explanation assembler. */
export function explainPromptBodies(
  bodies: Record<AiPromptKey, string>,
): ReviewDuckAgentPromptBodies {
  return {
    shared: bodies["explain.shared"],
    questionTask: bodies["explain.question_task"],
    unitTask: bodies["explain.unit_task"],
    submit: bodies["explain.submit"],
  };
}

/** Projects stored bodies into the deep-review assemblers. */
export function deepReviewPromptBodies(
  bodies: Record<AiPromptKey, string>,
): DeepReviewPromptBodies {
  return {
    changePrDeleted: bodies["deep_review.change.pr_deleted"],
    changePrAdded: bodies["deep_review.change.pr_added"],
    changePrRenamed: bodies["deep_review.change.pr_renamed"],
    changePrModified: bodies["deep_review.change.pr_modified"],
    changeRepoDeleted: bodies["deep_review.change.repo_deleted"],
    changeRepoCurrent: bodies["deep_review.change.repo_current"],
    scoutUser: bodies["deep_review.scout.user"],
    planUser: bodies["deep_review.plan.user"],
    relocateUser: bodies["deep_review.relocate.user"],
    refuteUser: bodies["deep_review.refute.user"],
    surveyUser: bodies["deep_review.survey.user"],
    dedupeUser: bodies["deep_review.dedupe.user"],
  };
}

/** Lists catalog metadata with the current and default bodies. */
export async function listAiPrompts(db: Database) {
  const bodies = await loadAiPromptBodies(db);
  return AI_PROMPT_KEYS.map((key) => {
    const definition = AI_PROMPT_CATALOG[key];
    const defaultBody = defaultAiPromptBody(key);
    return {
      ...definition,
      body: bodies[key],
      defaultBody,
      modified: bodies[key] !== defaultBody,
    };
  });
}
