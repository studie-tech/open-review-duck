const OPTIMISTIC_ACTION_BATCH_SIZE = 20;

/**
 * Removes the next save request from an optimistic action queue.
 *
 * The first action leaves immediately so the common single-click path has no
 * batching delay. Actions accumulated during that request are coalesced into
 * bounded batches, keeping rapid review input responsive without producing
 * one network round trip per click.
 */
export function takeOptimisticActionBatch<Action>(pending: Action[]) {
  if (pending.length === 0) return [];
  const size =
    pending.length === 1
      ? 1
      : Math.min(pending.length, OPTIMISTIC_ACTION_BATCH_SIZE);
  return pending.splice(0, size);
}
