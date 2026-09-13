// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCommandCenterBindings } from "~/components/command-center";
import { reviewShortcuts } from "~/lib/review-shortcuts";
import { ReviewToolbar, ReviewToolbarTooltip } from "./review-toolbar-tooltip";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const actions = [
  "discussions",
  "undoSignOff",
  "reset",
  "commands",
  "refresh",
  "openProvider",
  "toggleTheme",
] as const;

/** Renders toolbar hints alongside the same command dispatcher used by the workspace. */
function Harness({
  onAction,
  suspended = false,
  disabled = false,
}: {
  onAction: (action: string) => void;
  suspended?: boolean;
  disabled?: boolean;
}) {
  useCommandCenterBindings({
    commands: actions.map((action) => ({
      id: action,
      label: action,
      group: "Review actions",
      shortcut: reviewShortcuts[action],
      disabled,
      onSelect: () => onAction(action),
    })),
    onOpen: vi.fn(),
    onOpenShortcuts: vi.fn(),
    suspended,
  });
  return (
    <>
      <input aria-label="Comment" />
      <ReviewToolbar>
        {actions.map((action) => (
          <ReviewToolbarTooltip
            key={action}
            label={action}
            shortcut={reviewShortcuts[action]}
          >
            <button type="button" disabled={disabled}>
              {action}
            </button>
          </ReviewToolbarTooltip>
        ))}
      </ReviewToolbar>
    </>
  );
}

describe("toolbar command shortcuts", () => {
  it("preserves an existing description through tooltip and modifier changes", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh");
    render(
      <ReviewToolbar>
        <span id="existing">Original help</span>
        <ReviewToolbarTooltip
          label="Supplementary help"
          shortcut={reviewShortcuts.reset}
        >
          <button type="button" aria-describedby="existing">
            Reset
          </button>
        </ReviewToolbarTooltip>
      </ReviewToolbar>,
    );
    const button = screen.getByRole("button", { name: "Reset" });
    expect(button).toHaveAttribute("aria-describedby", "existing");
    fireEvent.focus(button);
    expect(button).toHaveAccessibleDescription(
      "Original help Supplementary help (⌘⇧R)",
    );
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    expect(button).toHaveAttribute("aria-describedby", "existing");
    fireEvent.keyUp(window, { key: "Meta" });
    fireEvent.blur(button);
    expect(button).toHaveAttribute("aria-describedby", "existing");
  });

  it("reveals every shortcut while Command is held, then clears on release or blur", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh");
    render(<Harness onAction={vi.fn()} />);
    expect(screen.queryByText("⌘D")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    for (const hint of ["⌘D", "⌘U", "⌘⇧R", "⌘K", "⌘R", "⌘⇧O", "⌘⇧L"])
      expect(screen.getByText(hint)).toBeVisible();
    expect(screen.getByRole("button", { name: "reset" })).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+Shift+r",
    );
    fireEvent.keyUp(window, { key: "Meta", metaKey: false });
    expect(screen.queryByText("⌘D")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    fireEvent.blur(window);
    expect(screen.queryByText("⌘D")).not.toBeInTheDocument();
  });
  it("dispatches each Command combination once and prevents the browser default", () => {
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);
    for (const action of actions) {
      const stroke = reviewShortcuts[action][0];
      if (!stroke) throw new Error(`Missing shortcut for ${action}`);
      const event = new KeyboardEvent("keydown", {
        key: stroke.key,
        metaKey: true,
        shiftKey: "shift" in stroke && stroke.shift,
        bubbles: true,
        cancelable: true,
      });
      fireEvent(document, event);
      expect(event.defaultPrevented).toBe(true);
      expect(onAction).toHaveBeenLastCalledWith(action);
    }
    expect(onAction).toHaveBeenCalledTimes(actions.length);
  });
  it("leaves typing, suspended dialogs, and disabled actions alone", () => {
    const onAction = vi.fn();
    const { rerender } = render(<Harness onAction={onAction} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "r", metaKey: true });
    expect(onAction).not.toHaveBeenCalled();
    rerender(<Harness onAction={onAction} suspended />);
    fireEvent.keyDown(document, { key: "r", metaKey: true });
    expect(onAction).not.toHaveBeenCalled();
    rerender(<Harness onAction={onAction} disabled />);
    fireEvent.keyDown(document, { key: "r", metaKey: true });
    expect(onAction).not.toHaveBeenCalled();
  });
  it("uses Control hints on non-Apple platforms", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows NT");
    render(<Harness onAction={vi.fn()} />);
    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    expect(screen.getByText("Ctrl+R")).toBeVisible();
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.queryByText("Ctrl+R")).not.toBeInTheDocument();
  });
});
