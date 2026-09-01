/**
 * Caps a server read timestamp at the browser's own clock.
 *
 * Pages stamp their hydrated payload with the server's `Date.now()`, but React
 * Query ages that stamp against the client clock. A browser running behind the
 * server would read the payload as newer than the present and hold it well past
 * the shared stale time, so capping it bounds the error at that stale time while
 * a genuinely old prefetched payload still ages from when the server read it.
 */
export function clampToClientClock(fetchedAt: number) {
  return Math.min(fetchedAt, Date.now());
}

/**
 * Builds the common options for refreshable server-hydrated queries.
 *
 * The server read time, capped to the browser clock, lets the shared stale
 * time age prefetched data correctly. Mount and focus refetches then refresh
 * stale route payloads while React Query still suppresses unnecessary reads.
 */
export function hydratedQueryOptions<Data>(
  initialData: Data,
  fetchedAt: number,
) {
  return {
    initialData,
    initialDataUpdatedAt: clampToClientClock(fetchedAt),
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  } as const;
}
