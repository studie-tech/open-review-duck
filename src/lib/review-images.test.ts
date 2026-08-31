import { describe, expect, it } from "vitest";
import {
  isPreviewableReviewImage,
  reviewImageMediaType,
  reviewImagePreviewUrl,
} from "./review-images";

describe("review image preview", () => {
  it("accepts common raster image paths and rejects other binaries", () => {
    expect(isPreviewableReviewImage("public/icons/icon-180x180.png")).toBe(
      true,
    );
    expect(isPreviewableReviewImage("assets/hero.JPEG")).toBe(true);
    expect(isPreviewableReviewImage("brand/logo.webp")).toBe(true);
    expect(isPreviewableReviewImage("docs/diagram.pdf")).toBe(false);
    expect(isPreviewableReviewImage("fonts/display.woff2")).toBe(false);
  });

  it("confirms PNG bytes match the path before choosing a media type", () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(reviewImageMediaType("public/duck.png", png)).toBe("image/png");
    expect(
      reviewImageMediaType("public/duck.png", new Uint8Array([0, 1, 2])),
    ).toBe(undefined);
    expect(reviewImageMediaType("public/duck.pdf", png)).toBeUndefined();
  });

  it("builds a cookie-gated preview URL for one unit", () => {
    expect(reviewImagePreviewUrl("unit/with spaces")).toBe(
      "/api/review/images/unit%2Fwith%20spaces",
    );
  });
});
