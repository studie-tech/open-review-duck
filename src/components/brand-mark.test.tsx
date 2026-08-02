// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BrandMark } from "./brand-mark";

describe("BrandMark", () => {
  it("uses theme-aware brand tokens", () => {
    render(<BrandMark />);

    const logo = screen.getByRole("img", { name: "ReviewDuck" });
    const panes = logo.querySelectorAll("rect");

    expect(panes[0]).toHaveAttribute("fill", "var(--brand-pane-back)");
    expect(panes[1]).toHaveAttribute("fill", "var(--brand-pane-front)");
    expect(logo.querySelector("path:last-of-type")).toHaveAttribute(
      "fill",
      "var(--brand-duck)",
    );
  });
});
