// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewModeSwitch } from "./review-mode-switch";

describe("ReviewModeSwitch", () => {
  it("presents one selected review projection and changes without mutation", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ReviewModeSwitch mode="path" onChange={onChange} />,
    );

    expect(screen.getByRole("tablist")).toHaveClass("w-full");
    expect(container.querySelectorAll('[role="tab"].flex-1')).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Guided" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(onChange).toHaveBeenCalledWith("files");
  });
});
