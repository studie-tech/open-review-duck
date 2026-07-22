// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";

describe("Button", () => {
  it("renders an accessible button and handles activation", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();

    render(<Button onClick={onClick}>Prepare review</Button>);
    const button = screen.getByRole("button", { name: "Prepare review" });

    await user.click(button);

    expect(button).toHaveClass("bg-lime");
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("preserves link semantics when rendered as a child", () => {
    render(
      <Button asChild variant="secondary">
        <a href="/dashboard">Open dashboard</a>
      </Button>,
    );

    expect(
      screen.getByRole("link", { name: "Open dashboard" }),
    ).toHaveAttribute("href", "/dashboard");
  });
});
