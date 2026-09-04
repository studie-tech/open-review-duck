// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  previewReviewPanelWidth,
  REVIEW_PANEL_COLLAPSE_WIDTH,
  ReviewPanelResizeHandle,
  reviewPanelWidthFromPointer,
} from "./review-panel-resize-handle";

afterEach(() => {
  cleanup();
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

/** Renders a handle with stable dimensions and overridable behavior. */
function renderHandle(
  overrides: Partial<Parameters<typeof ReviewPanelResizeHandle>[0]> = {},
) {
  const onCollapse = vi.fn();
  const onResize = vi.fn();
  render(
    <ReviewPanelResizeHandle
      controls="review-path-panel"
      defaultWidth={250}
      label="Resize changed files"
      maximumWidth={480}
      minimumWidth={220}
      onCollapse={onCollapse}
      onResize={onResize}
      side="left"
      width={250}
      {...overrides}
    />,
  );
  return {
    handle: screen.getByRole("separator", { name: "Resize changed files" }),
    onCollapse,
    onResize,
  };
}

describe("review panel resizing", () => {
  it("translates pointer travel for panels on either edge", () => {
    expect(
      reviewPanelWidthFromPointer({
        clientX: 310,
        side: "left",
        startClientX: 250,
        startWidth: 250,
      }),
    ).toBe(310);
    expect(
      reviewPanelWidthFromPointer({
        clientX: 940,
        side: "right",
        startClientX: 1_000,
        startWidth: 320,
      }),
    ).toBe(380);
  });

  it("snaps into the collapse zone and constrains useful widths", () => {
    expect(previewReviewPanelWidth(REVIEW_PANEL_COLLAPSE_WIDTH, 220, 480)).toBe(
      0,
    );
    expect(previewReviewPanelWidth(180, 220, 480)).toBe(220);
    expect(previewReviewPanelWidth(600, 220, 480)).toBe(480);
  });

  it("resizes through a window-tracked pointer gesture", () => {
    const { handle, onResize, onCollapse } = renderHandle();

    fireEvent.pointerDown(handle, {
      button: 0,
      clientX: 250,
      pointerId: 1,
    });
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.pointerUp(window, { clientX: 370, pointerId: 1 });

    expect(onResize).toHaveBeenLastCalledWith(370);
    expect(onCollapse).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("collapses at the outside edge without forgetting its reopen width", () => {
    const { handle, onResize, onCollapse } = renderHandle();

    fireEvent.pointerDown(handle, {
      button: 0,
      clientX: 250,
      pointerId: 1,
    });
    fireEvent.pointerUp(window, { clientX: 20, pointerId: 1 });

    expect(onResize).toHaveBeenLastCalledWith(250);
    expect(onCollapse).toHaveBeenCalledOnce();
  });

  it("supports precise keyboard resizing and keyboard collapse", () => {
    const onCollapse = vi.fn();
    const onResize = vi.fn();
    const { handle } = renderHandle({ onCollapse, onResize, width: 220 });

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onResize).toHaveBeenCalledWith(236);

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onCollapse).toHaveBeenCalledOnce();
  });

  it("offers default, minimum, and maximum keyboard-friendly sizes", () => {
    const { handle, onResize } = renderHandle({ width: 400 });

    fireEvent.doubleClick(handle);
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyDown(handle, { key: "End" });

    expect(onResize).toHaveBeenNthCalledWith(1, 250);
    expect(onResize).toHaveBeenNthCalledWith(2, 220);
    expect(onResize).toHaveBeenNthCalledWith(3, 480);
  });
});
