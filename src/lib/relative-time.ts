/**
 * Formats a timestamp as a coarse relative phrase against a known clock.
 *
 * Pages pass the payload `fetchedAt` so the first paint matches SSR instead of
 * reading `Date.now()` during render.
 */
export function formatRelativeTime(value: Date, now: number) {
  const seconds = Math.round((value.getTime() - now) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}
