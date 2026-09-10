// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiReviewConfirmationDialog } from "./ai-review-confirmation-dialog";

afterEach(cleanup);

describe("AiReviewConfirmationDialog", () => {
  it("keeps the workspace confirmation copy and Enter shortcut", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <AiReviewConfirmationDialog onCancel={vi.fn()} onConfirm={onConfirm} />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Review this pull request with AI?",
      }),
    ).toBeVisible();
    expect(
      screen.getByText(/inspect all changed files and add evidence-backed/i),
    ).toBeVisible();
    const confirm = screen.getByRole("button", {
      name: /Start AI review.*Enter/i,
    });
    expect(confirm).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
