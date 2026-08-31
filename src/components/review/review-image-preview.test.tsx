// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ReviewBinaryPlaceholder,
  ReviewBinaryPreview,
} from "./review-image-preview";

afterEach(cleanup);

describe("ReviewBinaryPreview", () => {
  it("shows the image for a previewable path", () => {
    render(
      <ReviewBinaryPreview
        path="public/icons/icon-180x180.png"
        unitId="unit-1"
      />,
    );

    expect(
      screen.getByRole("img", { name: "icon-180x180.png" }),
    ).toHaveAttribute("src", "/api/review/images/unit-1");
    expect(screen.queryByText("Binary file")).not.toBeInTheDocument();
  });

  it("falls back to the binary placeholder when the image cannot load", () => {
    render(
      <ReviewBinaryPreview
        path="public/icons/icon-180x180.png"
        unitId="unit-1"
      />,
    );

    fireEvent.error(screen.getByRole("img", { name: "icon-180x180.png" }));

    expect(screen.getByText("Binary file")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("keeps non-image binaries as an acknowledgement card", () => {
    render(<ReviewBinaryPlaceholder path="vendor/native.wasm" />);

    expect(screen.getByText("Binary file")).toBeVisible();
    expect(screen.getByText("vendor/native.wasm")).toBeVisible();
  });
});
