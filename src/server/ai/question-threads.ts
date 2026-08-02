export interface AiQuestionThreadRecord {
  createdAt: Date;
  id: string;
  threadId: string | null;
}

/** Orders persisted questions and exposes their required conversation identity. */
export function withAiQuestionConversationIds<
  Record extends AiQuestionThreadRecord,
>(records: Record[]): Array<Record & { conversationId: string }> {
  return [...records]
    .sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id),
    )
    .map((record) => {
      if (!record.threadId) {
        throw new Error("Persisted AI question is missing a conversation ID");
      }
      return { ...record, conversationId: record.threadId };
    });
}
