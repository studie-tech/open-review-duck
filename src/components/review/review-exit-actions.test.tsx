// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewExitActions } from "./review-exit-actions";

const pendingNavigation = vi.hoisted(() => ({ pending: false }));

vi.mock("~/components/navigation-progress", () => ({
  usePendingNavigation: () => ({
    navigate: vi.fn(),
    pending: pendingNavigation.pending,
  }),
}));

afterEach(() => {
  cleanup();
  pendingNavigation.pending = false;
});

const shortcuts = {
  dashboardShortcut: [{ key: "g" }, { key: "r" }],
  dismissShortcut: [{ key: "Escape" }],
  nextReviewShortcut: [{ key: "n", shift: true }],
};

/** Renders the action row with defaults that individual tests can override. */
function renderActions(
  overrides: Partial<ComponentProps<typeof ReviewExitActions>> = {},
) {
  const handlers = {
    onDashboard: vi.fn(),
    onDismiss: vi.fn(),
    onNextReview: vi.fn(),
  };
  render(
    <ReviewExitActions
      {...shortcuts}
      dismissLabel="Keep review open"
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe("ReviewExitActions", () => {
  it("owns the shared labels, shortcuts, callbacks, and dismiss ref", async () => {
    const dismissButtonRef = createRef<HTMLButtonElement>();
    const handlers = renderActions({ dismissButtonRef });
    const user = userEvent.setup();

    for (const name of [
      /Keep review open/,
      /Pull requests/,
      /Review next PR/,
    ]) {
      expect(
        screen.getByRole("button", { name }).querySelector("kbd"),
      ).toBeInTheDocument();
    }
    expect(dismissButtonRef.current).toBe(
      screen.getByRole("button", { name: /Keep review open/ }),
    );

    await user.click(screen.getByRole("button", { name: /Keep review open/ }));
    await user.click(screen.getByRole("button", { name: /Pull requests/ }));
    await user.click(screen.getByRole("button", { name: /Review next PR/ }));
    expect(handlers.onDismiss).toHaveBeenCalledOnce();
    expect(handlers.onDashboard).toHaveBeenCalledOnce();
    expect(handlers.onNextReview).toHaveBeenCalledOnce();
  });

  it("omits the next-review action when no candidate or queue check remains", () => {
    renderActions({ onNextReview: undefined });

    expect(
      screen.queryByRole("button", { name: /Review next PR/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Checking review queue/ }),
    ).not.toBeInTheDocument();
  });

  it("shows the disabled queue placeholder only when requested", () => {
    renderActions({ onNextReview: undefined, queueLoading: true });

    const queue = screen.getByRole("button", {
      name: /Checking review queue/,
    });
    expect(queue).toBeDisabled();
    expect(queue.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("disables both navigation actions and shows their pending spinners", () => {
    pendingNavigation.pending = true;
    renderActions();

    for (const name of [/Pull requests/, /Review next PR/]) {
      const action = screen.getByRole("button", { name });
      expect(action).toBeDisabled();
      expect(action).toHaveAttribute("aria-busy", "true");
      expect(action.querySelector(".animate-spin")).toBeInTheDocument();
    }
    expect(
      screen.getByRole("button", { name: /Keep review open/ }),
    ).toBeEnabled();
  });
});
