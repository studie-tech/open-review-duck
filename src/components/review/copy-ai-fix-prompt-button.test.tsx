// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyAiFixPromptButton } from "./copy-ai-fix-prompt-button";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Installs a clipboard the jsdom navigator does not expose. */
function mockClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

describe("CopyAiFixPromptButton", () => {
  it("assembles the prompt on click and confirms with a check", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    const prompt = vi.fn(() => "# Fix it");
    render(<CopyAiFixPromptButton prompt={prompt} subject="this finding" />);
    expect(prompt).not.toHaveBeenCalled();

    const button = screen.getByRole("button", {
      name: "Copy AI fix prompt for this finding",
    });
    expect(button).toHaveAttribute(
      "title",
      "Copy fix prompt for your AI agent",
    );
    fireEvent.click(button);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("# Fix it");
    });
    expect(
      screen.getByRole("button", {
        name: "AI fix prompt for this finding copied",
      }),
    ).toHaveAttribute("title", "Copied");
  });

  it("returns to the wand once the confirmation has been seen", async () => {
    vi.useFakeTimers();
    mockClipboard(vi.fn().mockResolvedValue(undefined));
    render(
      <CopyAiFixPromptButton
        prompt={() => "# Fix it"}
        subject="the merge block"
        variant="inline"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Copy AI fix prompt/ }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("button")).toHaveTextContent("Copied");

    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(screen.getByRole("button")).toHaveTextContent("Copy fix prompt");
  });

  it("keeps the row's own click handler out of the copy", async () => {
    mockClipboard(vi.fn().mockResolvedValue(undefined));
    const onRow = vi.fn();
    render(
      <button type="button" onClick={onRow}>
        <CopyAiFixPromptButton prompt={() => "x"} subject="the row" />
      </button>,
    );
    fireEvent.click(screen.getByRole("button", { name: /fix prompt/ }));
    expect(onRow).not.toHaveBeenCalled();
  });

  it("says so when the clipboard refuses the prompt", async () => {
    mockClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const error = vi.spyOn(toast, "error").mockImplementation(() => "toast");
    render(<CopyAiFixPromptButton prompt={() => "x"} subject="the check" />);

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(error).toHaveBeenCalledWith("Could not copy the fix prompt");
    });
    expect(
      screen.getByRole("button", { name: "Copy AI fix prompt for the check" }),
    ).toBeInTheDocument();
  });
});
