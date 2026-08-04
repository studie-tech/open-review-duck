import "server-only";

import { and, desc, eq, ne } from "drizzle-orm";
import { aiJobs } from "@/drizzle/schema";
import type { db as database } from "~/server/db";

type Database = typeof database;
export const AI_PRIOR_CONVERSATION_MAX_BYTES = 64 * 1_024;

export interface PriorConversationTurn {
  answer: string;
  question: string;
}

/** Keeps the newest complete conversation turns inside a strict byte ceiling. */
export function boundPriorConversation(
  records: Array<{
    createdAt: Date;
    id: string;
    question: string | null;
    result: { summary: string } | null;
  }>,
  maximumBytes = AI_PRIOR_CONVERSATION_MAX_BYTES,
) {
  const newestFirst = [...records].sort(
    (left, right) =>
      right.createdAt.getTime() - left.createdAt.getTime() ||
      right.id.localeCompare(left.id),
  );
  const selected: PriorConversationTurn[] = [];
  let bytes = 0;
  for (const record of newestFirst) {
    if (!record.question || !record.result) continue;
    const turn = { question: record.question, answer: record.result.summary };
    // XML entity escaping can expand one untrusted ASCII byte to six bytes.
    // Reserve that upper bound so prompt framing never outruns this cap.
    const turnBytes = Buffer.byteLength(JSON.stringify(turn)) * 6;
    if (bytes + turnBytes > maximumBytes) continue;
    selected.push(turn);
    bytes += turnBytes;
  }
  return { bytes, turns: selected.reverse() };
}

/** Loads one authorized thread's recent completed turns with bounded prompt size. */
export async function loadPriorConversation(
  db: Database,
  input: {
    threadId?: string | null;
    userId: string;
    workspaceId: string;
    pullRequestId: string;
    excludeJobId?: string;
  },
) {
  if (!input.threadId) return { bytes: 0, turns: [] };
  const records = await db.query.aiJobs.findMany({
    columns: {
      createdAt: true,
      id: true,
      question: true,
      result: true,
    },
    where: and(
      eq(aiJobs.threadId, input.threadId),
      eq(aiJobs.userId, input.userId),
      eq(aiJobs.workspaceId, input.workspaceId),
      eq(aiJobs.pullRequestId, input.pullRequestId),
      eq(aiJobs.status, "completed"),
      input.excludeJobId ? ne(aiJobs.id, input.excludeJobId) : undefined,
    ),
    orderBy: [desc(aiJobs.createdAt)],
    limit: 50,
  });
  return boundPriorConversation(records);
}
