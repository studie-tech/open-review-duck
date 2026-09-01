import { useEffect, useState } from "react";

/**
 * Formats a timestamp as a coarse relative phrase against a known clock.
 *
 * Pages pass the payload `fetchedAt` so the first paint matches SSR instead of
 * reading `Date.now()` during render. The locale is pinned so server and
 * browser cannot disagree on the phrase.
 */
export function formatRelativeTime(value: Date, now: number) {
  const seconds = Math.round((value.getTime() - now) / 1_000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

/**
 * Keeps relative-time SSR stable, then uses the client clock after mount.
 *
 * The first paint uses `fetchedAt`. Later renders read `Date.now()` so a
 * refetch that lands a newer timestamp cannot render as a future phrase.
 */
export function useRelativeClock(fetchedAt: number) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted ? Date.now() : fetchedAt;
}
