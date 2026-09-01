// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRelativeTime, useRelativeClock } from "~/lib/relative-time";

describe("formatRelativeTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ages a timestamp against the provided clock, not the process clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-31T18:00:00Z"));
    const fetchedAt = Date.parse("2026-08-21T12:20:00Z");
    const value = new Date("2026-08-14T12:20:00Z");

    expect(formatRelativeTime(value, fetchedAt)).toBe("7 days ago");
  });

  it("uses hours and minutes for nearer timestamps", () => {
    const now = Date.parse("2026-08-21T12:20:00Z");

    expect(formatRelativeTime(new Date("2026-08-21T10:20:00Z"), now)).toBe(
      "2 hours ago",
    );
    expect(formatRelativeTime(new Date("2026-08-21T12:05:00Z"), now)).toBe(
      "15 minutes ago",
    );
  });

  it("keeps fetchedAt until mount, then uses the client clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-31T18:00:00Z"));
    const fetchedAt = Date.parse("2026-08-21T12:20:00Z");

    const { result } = renderHook(() => useRelativeClock(fetchedAt));

    expect(result.current).toBe(Date.parse("2026-08-31T18:00:00Z"));
  });
});
