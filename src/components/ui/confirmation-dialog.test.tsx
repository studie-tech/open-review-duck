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

describe("ConfirmationDialog", () => {
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
