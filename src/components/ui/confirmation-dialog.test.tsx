// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationDialog } from "./confirmation-dialog";

afterEach(cleanup);

/** Renders a confirmation dialog test subject. */
function renderDialog({
  onCancel = vi.fn(),
  onConfirm = vi.fn(),
  pending = false,
}: {
  onCancel?: () => void;
  onConfirm?: () => void;
  pending?: boolean;
} = {}) {
  render(
    <ConfirmationDialog
      title="Reset this review?"
      description="All sign-offs will be cleared."
      confirmLabel="Reset review"
      pendingLabel="Resetting…"
      pending={pending}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
}

/**
 * Mimics a real `showModal`, which moves focus to the dialog's first tabbable
 * element. jsdom implements no such behaviour, so without this a dialog that
 * relies on React's autofocus passes here and still opens focused on Cancel in
 * a browser, where Enter dismisses instead of confirming.
 */
function withBrowserShowModal() {
  const original = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    "showModal",
  );
  HTMLDialogElement.prototype.showModal = function showModal(
    this: HTMLDialogElement,
  ) {
    this.setAttribute("open", "");
    this.querySelector<HTMLElement>(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    )?.focus();
  };
  return () => {
    if (original)
      Object.defineProperty(HTMLDialogElement.prototype, "showModal", original);
    else
      delete (HTMLDialogElement.prototype as { showModal?: unknown }).showModal;
  };
}

describe("ConfirmationDialog", () => {
  it("confirms with Enter after the browser moves focus on open", async () => {
    const restore = withBrowserShowModal();
    try {
      const user = userEvent.setup();
      const onConfirm = vi.fn();
      const onCancel = vi.fn();
      renderDialog({ onCancel, onConfirm });

      // Cancel is the first tabbable control, so the dialog must take focus
      // back for its own default action.
      expect(
        screen.getByRole("button", { name: /Reset review.*Enter/i }),
      ).toHaveFocus();

      await user.keyboard("{Enter}");

      expect(onConfirm).toHaveBeenCalledOnce();
      expect(onCancel).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("focuses and confirms the primary action with Enter", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderDialog({ onConfirm });

    const confirm = screen.getByRole("button", {
      name: /Reset review.*Enter/i,
    });
    expect(confirm).toHaveFocus();
    expect(confirm).toHaveTextContent(/Reset review/);
    expect(confirm).toHaveTextContent(/Enter|↵/);

    await user.keyboard("{Enter}");

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("cancels with Escape", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderDialog({ onCancel });

    await user.keyboard("{Escape}");

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("cancels with Escape even when focus has moved outside the dialog", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const outside = document.createElement("button");
    document.body.append(outside);
    renderDialog({ onCancel });
    outside.focus();

    await user.keyboard("{Escape}");

    expect(onCancel).toHaveBeenCalledOnce();
    outside.remove();
  });

  it("blocks confirmation and cancellation while pending", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    renderDialog({ onCancel, onConfirm, pending: true });

    await user.keyboard("{Enter}{Escape}");

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Resetting…" })).toBeDisabled();
  });
});
