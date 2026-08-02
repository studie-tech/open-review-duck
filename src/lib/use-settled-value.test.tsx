// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettledValue } from "./use-settled-value";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Displays the value after navigation has settled. */
function SettledValueHarness({ value }: { value: string }) {
  const settledValue = useSettledValue(value, 200);
  return <output>{settledValue ?? "waiting"}</output>;
}

describe("useSettledValue", () => {
  it("returns the initial value immediately", () => {
    render(<SettledValueHarness value="one" />);
    expect(screen.getByRole("status")).toHaveTextContent("one");
  });

  it("only exposes the last value after rapid changes settle", () => {
    vi.useFakeTimers();
    const view = render(<SettledValueHarness value="one" />);

    view.rerender(<SettledValueHarness value="two" />);
    expect(screen.getByRole("status")).toHaveTextContent("waiting");
    act(() => vi.advanceTimersByTime(100));
    view.rerender(<SettledValueHarness value="three" />);
    act(() => vi.advanceTimersByTime(199));
    expect(screen.getByRole("status")).toHaveTextContent("waiting");

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("status")).toHaveTextContent("three");
  });
});
