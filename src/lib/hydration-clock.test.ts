import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampToClientClock,
  hydratedQueryOptions,
} from "~/lib/hydration-clock";

afterEach(() => {
  vi.useRealTimers();
});

describe("clampToClientClock", () => {
  it("keeps a server read that already predates the client clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-21T12:20:00Z"));
    const fetchedAt = Date.parse("2026-08-21T12:00:00Z");

    expect(clampToClientClock(fetchedAt)).toBe(fetchedAt);
  });

  it("caps a server read that a lagging client clock has not reached", () => {
    vi.useFakeTimers();
    const clientNow = Date.parse("2026-08-21T12:20:00Z");
    vi.setSystemTime(clientNow);

    expect(clampToClientClock(Date.parse("2026-08-21T12:25:00Z"))).toBe(
      clientNow,
    );
  });
});

describe("hydratedQueryOptions", () => {
  it("keeps the hydrated value and shared refresh policy", () => {
    vi.useFakeTimers();
    const clientNow = Date.parse("2026-08-21T12:20:00Z");
    vi.setSystemTime(clientNow);
    const initialData = { total: 3 };

    expect(
      hydratedQueryOptions(initialData, Date.parse("2026-08-21T12:25:00Z")),
    ).toEqual({
      initialData,
      initialDataUpdatedAt: clientNow,
      refetchOnMount: true,
      refetchOnWindowFocus: true,
    });
  });
});
