// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextRevealControl } from "./context-reveal-control";

afterEach(cleanup);

describe("ContextRevealControl", () => {
  it("reveals one capped page above with the shared shortcut and direction", async () => {
    const onReveal = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <ContextRevealControl
        availableLines={57}
        direction="above"
        onReveal={onReveal}
        revealedLines={20}
        shortcut={[{ key: "ArrowUp", shift: true }]}
      />,
    );

    const button = screen.getByRole("button", {
      name: /Show 20 more lines above.*Shift\+↑/,
    });
    const icon = button.querySelector("svg");
    expect(icon).toHaveClass("rotate-180");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(button.querySelector("kbd")).toHaveTextContent("Shift+↑");
    expect(container.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(
      3,
    );

    await user.click(button);
    expect(onReveal).toHaveBeenCalledOnce();
  });

  it("shows the partial remaining count below before any lines are revealed", () => {
    render(
      <ContextRevealControl
        availableLines={12}
        direction="below"
        onReveal={vi.fn()}
        revealedLines={0}
        shortcut={[{ key: "ArrowDown", shift: true }]}
      />,
    );

    const button = screen.getByRole("button", {
      name: /Show 12 lines below.*Shift\+↓/,
    });
    expect(button).not.toHaveTextContent("more");
    expect(button.querySelector("svg")).not.toHaveClass("rotate-180");
    expect(button.querySelector("kbd")).toHaveTextContent("Shift+↓");
  });

  it("uses the exact remainder after a partial reveal", () => {
    render(
      <ContextRevealControl
        availableLines={25}
        direction="below"
        onReveal={vi.fn()}
        revealedLines={20}
        shortcut={[{ key: "ArrowDown", shift: true }]}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Show 5 more lines below/ }),
    ).toBeVisible();
  });

  it("renders no control when zero lines remain", () => {
    const { rerender } = render(
      <ContextRevealControl
        availableLines={0}
        direction="above"
        onReveal={vi.fn()}
        revealedLines={0}
        shortcut={[{ key: "ArrowUp", shift: true }]}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    rerender(
      <ContextRevealControl
        availableLines={20}
        direction="above"
        onReveal={vi.fn()}
        revealedLines={20}
        shortcut={[{ key: "ArrowUp", shift: true }]}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
