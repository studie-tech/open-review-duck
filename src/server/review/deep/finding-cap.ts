/**
 * Coordinates one review item's finding ceiling across concurrent tool calls.
 *
 * Reservations happen before the caller performs asynchronous preparation or
 * persistence. A failed callback releases its room, while a successful one
 * permanently charges it for the lifetime of this tool set.
 */
export function findingCapacity(limit: number, alreadyReported = 0) {
  const ceiling = Math.max(0, Math.floor(limit));
  let committed = Math.min(ceiling, Math.max(0, Math.floor(alreadyReported)));
  let reserved = 0;

  return {
    /** Runs work with as much of the requested capacity as remains. */
    async withReservation<T>(
      requested: number,
      execute: (accepted: number) => Promise<T>,
    ): Promise<T> {
      const accepted = Math.min(
        Math.max(0, Math.floor(requested)),
        Math.max(0, ceiling - committed - reserved),
      );
      reserved += accepted;
      try {
        const result = await execute(accepted);
        committed += accepted;
        return result;
      } finally {
        reserved -= accepted;
      }
    },
  };
}
