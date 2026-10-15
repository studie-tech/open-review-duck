// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscussionImageViewer } from "./discussion-image-viewer";

let viewportWidth = 1000;
let viewportHeight = 600;

beforeEach(() => {
  viewportWidth = 1000;
  viewportHeight = 600;
  vi.stubGlobal("ResizeObserver", undefined);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => viewportWidth,
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    () => viewportHeight,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Loads an attachment into the measured viewport without network requests. */
function renderLoadedViewer(size = { width: 2000, height: 1000 }) {
  const onClose = vi.fn();
  render(
    <DiscussionImageViewer
      image={{ src: "https://github.com/attachment.png", alt: "War room" }}
      onClose={onClose}
    />,
  );
  const image = screen.getByAltText("War room");
  Object.defineProperties(image, {
    naturalWidth: { value: size.width },
    naturalHeight: { value: size.height },
  });
  fireEvent.load(image);
  return { image, onClose };
}

describe("DiscussionImageViewer", () => {
  it("keeps the modal accessible when its discussion pane hides on mobile", () => {
    render(
      <div hidden>
        <DiscussionImageViewer
          image={{ src: "https://github.com/attachment.png", alt: "War room" }}
          onClose={vi.fn()}
        />
      </div>,
    );
    expect(
      screen.getByRole("dialog", { name: "Image preview: War room" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Close image preview" }),
    ).toHaveFocus();
  });

  it("fits the full attachment, zooms to actual pixels, and returns to fit", async () => {
    const user = userEvent.setup();
    renderLoadedViewer();
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("48%");
    expect(screen.getByText("2,000 × 1,000 px")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("60%");
    await user.click(
      screen.getByRole("button", { name: "View image at actual size" }),
    );
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("100%");
    await user.click(screen.getByRole("button", { name: "Fit image to view" }));
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("48%");
    expect(
      screen.getByRole("button", { name: "Fit image to view" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("bounds zoom, pans with the keyboard, and resets its position", () => {
    const { image } = renderLoadedViewer();
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "1" });
    for (let index = 0; index < 20; index++)
      fireEvent.keyDown(dialog, { key: "+" });
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("400%");
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(image.style.transform).toContain("translate(-80px, 0px)");
    fireEvent.keyDown(dialog, { key: "0" });
    expect(image.style.transform).toContain("translate(0px, 0px)");
    for (let index = 0; index < 20; index++)
      fireEvent.keyDown(dialog, { key: "-" });
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("10%");
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();
  });

  it("zooms around the pointer with the wheel and toggles actual size on double-click", () => {
    renderLoadedViewer();
    const canvas = screen.getByRole("region", { name: "Image canvas" });
    const prevented = !fireEvent.wheel(canvas, {
      deltaY: -100,
      cancelable: true,
    });
    expect(prevented).toBe(true);
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("78%");
    fireEvent.doubleClick(canvas);
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("48%");
    fireEvent.doubleClick(canvas);
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("100%");
  });

  it("refits automatically when the viewport shrinks", () => {
    renderLoadedViewer();
    viewportWidth = 500;
    viewportHeight = 400;
    fireEvent(window, new Event("resize"));
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("23%");
  });

  it("keeps double-click at actual size for images that already fit", () => {
    renderLoadedViewer({ width: 400, height: 200 });
    const canvas = screen.getByRole("region", { name: "Image canvas" });
    fireEvent.doubleClick(canvas);
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("100%");
    expect(
      screen.getByRole("button", { name: "View image at actual size" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.doubleClick(canvas);
    expect(
      screen.getByRole("button", { name: "Fit image to view" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("shows a useful fallback when an attachment fails and keeps original access", () => {
    const { image } = renderLoadedViewer();
    fireEvent.error(image);
    expect(screen.getByText("This image couldn’t be loaded.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();
    expect(
      screen.getByRole("link", { name: "Open original image in a new tab" }),
    ).toHaveAttribute("href", "https://github.com/attachment.png");
  });
});
